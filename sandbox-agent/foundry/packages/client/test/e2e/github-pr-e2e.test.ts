import { describe, expect, it } from "vitest";
import type { AuditLogEvent as HistoryEvent, TaskRecord } from "@sandbox-agent/foundry-shared";
import { createBackendClient } from "../../src/backend-client.js";
import { requireImportedRepo } from "./helpers.js";

const RUN_E2E = process.env.HF_ENABLE_DAEMON_E2E === "1";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseGithubRepo(input: string): { owner: string; repo: string; fullName: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("HF_E2E_GITHUB_REPO is empty");
  }

  // owner/repo shorthand
  const shorthand = trimmed.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (shorthand) {
    const owner = shorthand[1]!;
    const repo = shorthand[2]!;
    return { owner, repo, fullName: `${owner}/${repo}` };
  }

  // https://github.com/owner/repo(.git)?(/...)?
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    const parts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    if (url.hostname.toLowerCase().includes("github.com") && parts.length >= 2) {
      const owner = parts[0]!;
      const repo = (parts[1] ?? "").replace(/\.git$/, "");
      if (owner && repo) {
        return { owner, repo, fullName: `${owner}/${repo}` };
      }
    }
  } catch {
    // fall through
  }

  throw new Error(`Unable to parse GitHub repo from: ${input}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function poll<T>(
  label: string,
  timeoutMs: number,
  intervalMs: number,
  fn: () => Promise<T>,
  isDone: (value: T) => boolean,
  onTick?: (value: T) => void,
): Promise<T> {
  const start = Date.now();
  let last: T;
  for (;;) {
    last = await fn();
    onTick?.(last);
    if (isDone(last)) {
      return last;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

function parseHistoryPayload(event: HistoryEvent): Record<string, unknown> {
  try {
    return JSON.parse(event.payloadJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function debugDump(client: ReturnType<typeof createBackendClient>, organizationId: string, repoId: string, taskId: string): Promise<string> {
  try {
    const task = await client.getTask(organizationId, repoId, taskId);
    const detail = await client.getTaskDetail(organizationId, repoId, taskId).catch(() => null);
    const history = await client.listHistory({ organizationId, taskId, limit: 80 }).catch(() => []);
    const historySummary = history
      .slice(0, 20)
      .map((e) => `${new Date(e.createdAt).toISOString()} ${e.kind}`)
      .join("\n");

    let sessionEventsSummary = "";
    const activeSessionId = detail?.activeSessionId ?? null;
    if (task.activeSandboxId && activeSessionId) {
      const events = await client
        .listSandboxSessionEvents(organizationId, task.sandboxProviderId, task.activeSandboxId, {
          sessionId: activeSessionId,
          limit: 50,
        })
        .then((r) => r.items)
        .catch(() => []);
      sessionEventsSummary = events
        .slice(-12)
        .map((e) => `${new Date(e.createdAt).toISOString()} ${e.sender}`)
        .join("\n");
    }

    return [
      "=== task ===",
      JSON.stringify(
        {
          status: task.status,
          title: task.title,
          branchName: task.branchName,
          activeSandboxId: task.activeSandboxId,
          activeSessionId,
          pullRequestUrl: detail?.pullRequest?.url ?? null,
        },
        null,
        2,
      ),
      "=== history (most recent first) ===",
      historySummary || "(none)",
      "=== session events (tail) ===",
      sessionEventsSummary || "(none)",
    ].join("\n");
  } catch (err) {
    return `debug dump failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function githubApi(token: string, path: string, init?: RequestInit): Promise<Response> {
  const url = `https://api.github.com/${path.replace(/^\/+/, "")}`;
  return await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
}

describe("e2e: backend -> sandbox-agent -> git -> PR", () => {
  it.skipIf(!RUN_E2E)("creates a task, waits for agent to implement, and opens a PR", { timeout: 15 * 60_000 }, async () => {
    const endpoint = process.env.HF_E2E_BACKEND_ENDPOINT?.trim() || "http://127.0.0.1:7741/v1/rivet";
    const organizationId = process.env.HF_E2E_WORKSPACE?.trim() || "default";
    const repoRemote = requiredEnv("HF_E2E_GITHUB_REPO");
    const githubToken = requiredEnv("GITHUB_TOKEN");

    const { fullName } = parseGithubRepo(repoRemote);
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const expectedFile = `e2e/${runId}.txt`;

    const client = createBackendClient({
      endpoint,
      defaultOrganizationId: organizationId,
    });

    const repo = await requireImportedRepo(client, organizationId, repoRemote);

    const created = await client.createTask({
      organizationId,
      repoId: repo.repoId,
      task: [
        "E2E test task:",
        `1. Create a new file at ${expectedFile} containing the single line: ${runId}`,
        "2. git add the file",
        `3. git commit -m \"test(e2e): ${runId}\"`,
        "4. git push the branch to origin",
        "5. Stop when done (agent should go idle).",
      ].join("\n"),
      sandboxProviderId: "local",
      explicitTitle: `test(e2e): ${runId}`,
      explicitBranchName: `e2e/${runId}`,
    });

    let prNumber: number | null = null;
    let branchName: string | null = null;
    let sandboxId: string | null = null;
    let sessionId: string | null = null;
    let lastStatus: string | null = null;

    try {
      const namedAndProvisioned = await poll<TaskRecord>(
        "task naming + sandbox provisioning",
        // Cold local sandbox startup can exceed a few minutes on first run.
        8 * 60_000,
        1_000,
        async () => client.getTask(organizationId, repo.repoId, created.taskId),
        (h) => Boolean(h.title && h.branchName && h.activeSandboxId),
        (h) => {
          if (h.status !== lastStatus) {
            lastStatus = h.status;
          }
          if (h.status === "error") {
            throw new Error("task entered error state during provisioning");
          }
        },
      ).catch(async (err) => {
        const dump = await debugDump(client, organizationId, repo.repoId, created.taskId);
        throw new Error(`${err instanceof Error ? err.message : String(err)}\n${dump}`);
      });

      branchName = namedAndProvisioned.branchName!;
      sandboxId = namedAndProvisioned.activeSandboxId!;

      const withSession = await poll<Awaited<ReturnType<typeof client.getTaskDetail>>>(
        "task to create active session",
        3 * 60_000,
        1_500,
        async () => client.getTaskDetail(organizationId, repo.repoId, created.taskId),
        (h) => Boolean(h.activeSessionId),
        (h) => {
          if (h.status === "error") {
            throw new Error("task entered error state while waiting for active session");
          }
        },
      ).catch(async (err) => {
        const dump = await debugDump(client, organizationId, repo.repoId, created.taskId);
        throw new Error(`${err instanceof Error ? err.message : String(err)}\n${dump}`);
      });

      sessionId = withSession.activeSessionId!;

      await poll<{ id: string }[]>(
        "session transcript bootstrap events",
        2 * 60_000,
        2_000,
        async () =>
          (
            await client.listSandboxSessionEvents(organizationId, namedAndProvisioned.sandboxProviderId, sandboxId!, {
              sessionId: sessionId!,
              limit: 40,
            })
          ).items,
        (events) => events.length > 0,
      ).catch(async (err) => {
        const dump = await debugDump(client, organizationId, repo.repoId, created.taskId);
        throw new Error(`${err instanceof Error ? err.message : String(err)}\n${dump}`);
      });

      await poll<TaskRecord>(
        "task to reach idle state",
        8 * 60_000,
        2_000,
        async () => client.getTask(organizationId, repo.repoId, created.taskId),
        (h) => h.status === "idle",
        (h) => {
          if (h.status === "error") {
            throw new Error("task entered error state while waiting for idle");
          }
        },
      ).catch(async (err) => {
        const dump = await debugDump(client, organizationId, repo.repoId, created.taskId);
        throw new Error(`${err instanceof Error ? err.message : String(err)}\n${dump}`);
      });

      const prCreatedEvent = await poll<HistoryEvent[]>(
        "PR creation history event",
        3 * 60_000,
        2_000,
        async () => client.listHistory({ organizationId, taskId: created.taskId, limit: 200 }),
        (events) => events.some((e) => e.kind === "task.pr_created"),
      )
        .catch(async (err) => {
          const dump = await debugDump(client, organizationId, repo.repoId, created.taskId);
          throw new Error(`${err instanceof Error ? err.message : String(err)}\n${dump}`);
        })
        .then((events) => events.find((e) => e.kind === "task.pr_created")!);

      const payload = parseHistoryPayload(prCreatedEvent);
      prNumber = Number(payload.prNumber);
      const prUrl = String(payload.prUrl ?? "");

      expect(prNumber).toBeGreaterThan(0);
      expect(prUrl).toContain("/pull/");

      const prFilesRes = await githubApi(githubToken, `repos/${fullName}/pulls/${prNumber}/files?per_page=100`, { method: "GET" });
      if (!prFilesRes.ok) {
        const body = await prFilesRes.text();
        throw new Error(`GitHub PR files request failed: ${prFilesRes.status} ${body}`);
      }
      const prFiles = (await prFilesRes.json()) as Array<{ filename: string }>;
      expect(prFiles.some((f) => f.filename === expectedFile)).toBe(true);

      // Close the task and assert the sandbox is released (stopped).
      await client.runAction(organizationId, repo.repoId, created.taskId, "archive");

      await poll<Awaited<ReturnType<typeof client.getTaskDetail>>>(
        "task to become archived (session released)",
        60_000,
        1_000,
        async () => client.getTaskDetail(organizationId, repo.repoId, created.taskId),
        (h) => h.status === "archived" && h.activeSessionId === null,
      ).catch(async (err) => {
        const dump = await debugDump(client, organizationId, repo.repoId, created.taskId);
        throw new Error(`${err instanceof Error ? err.message : String(err)}\n${dump}`);
      });

      if (sandboxId) {
        await poll<{ sandboxProviderId: string; sandboxId: string; state: string; at: number }>(
          "sandbox to stop",
          2 * 60_000,
          2_000,
          async () => client.sandboxProviderState(organizationId, "local", sandboxId!),
          (s) => {
            const st = String(s.state).toLowerCase();
            return st.includes("destroyed") || st.includes("stopped") || st.includes("suspended") || st.includes("paused");
          },
        ).catch(async (err) => {
          const dump = await debugDump(client, organizationId, repo.repoId, created.taskId);
          const state = await client.sandboxProviderState(organizationId, "local", sandboxId!).catch(() => null);
          throw new Error(`${err instanceof Error ? err.message : String(err)}\n` + `sandbox state: ${state ? state.state : "unknown"}\n` + `${dump}`);
        });
      }
    } finally {
      if (prNumber && Number.isFinite(prNumber)) {
        await githubApi(githubToken, `repos/${fullName}/pulls/${prNumber}`, {
          method: "PATCH",
          body: JSON.stringify({ state: "closed" }),
          headers: { "Content-Type": "application/json" },
        }).catch(() => {});
      }

      if (branchName) {
        await githubApi(githubToken, `repos/${fullName}/git/refs/heads/${encodeURIComponent(branchName)}`, { method: "DELETE" }).catch(() => {});
      }
    }
  });
});
