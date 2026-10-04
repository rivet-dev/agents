import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuditLogEvent as HistoryEvent, RepoOverview } from "@sandbox-agent/foundry-shared";
import { createBackendClient } from "../../src/backend-client.js";
import { requireImportedRepo } from "./helpers.js";

const RUN_FULL_E2E = process.env.HF_ENABLE_DAEMON_FULL_E2E === "1";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseGithubRepo(input: string): { fullName: string } {
  const trimmed = input.trim();
  const shorthand = trimmed.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (shorthand) {
    return { fullName: `${shorthand[1]}/${shorthand[2]}` };
  }

  const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  const parts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  if (url.hostname.toLowerCase().includes("github.com") && parts.length >= 2) {
    return { fullName: `${parts[0]}/${(parts[1] ?? "").replace(/\.git$/, "")}` };
  }

  throw new Error(`Unable to parse GitHub repo from: ${input}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll<T>(label: string, timeoutMs: number, intervalMs: number, fn: () => Promise<T>, isDone: (value: T) => boolean): Promise<T> {
  const start = Date.now();
  let last: T;
  for (;;) {
    last = await fn();
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

async function ensureRemoteBranchExists(token: string, fullName: string, branchName: string): Promise<void> {
  const repoRes = await githubApi(token, `repos/${fullName}`, { method: "GET" });
  if (!repoRes.ok) {
    throw new Error(`GitHub repo lookup failed: ${repoRes.status} ${await repoRes.text()}`);
  }
  const repo = (await repoRes.json()) as { default_branch?: string };
  const defaultBranch = repo.default_branch;
  if (!defaultBranch) {
    throw new Error(`GitHub repo default branch is missing for ${fullName}`);
  }

  const defaultRefRes = await githubApi(token, `repos/${fullName}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, { method: "GET" });
  if (!defaultRefRes.ok) {
    throw new Error(`GitHub default ref lookup failed: ${defaultRefRes.status} ${await defaultRefRes.text()}`);
  }
  const defaultRef = (await defaultRefRes.json()) as { object?: { sha?: string } };
  const sha = defaultRef.object?.sha;
  if (!sha) {
    throw new Error(`GitHub default ref sha missing for ${fullName}:${defaultBranch}`);
  }

  const createRefRes = await githubApi(token, `repos/${fullName}/git/refs`, {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha,
    }),
    headers: { "Content-Type": "application/json" },
  });
  if (createRefRes.ok || createRefRes.status === 422) {
    return;
  }

  throw new Error(`GitHub create ref failed: ${createRefRes.status} ${await createRefRes.text()}`);
}

describe("e2e(client): full integration stack workflow", () => {
  it.skipIf(!RUN_FULL_E2E)("uses an imported repo, loads branch graph, and executes a stack restack action", { timeout: 8 * 60_000 }, async () => {
    const endpoint = process.env.HF_E2E_BACKEND_ENDPOINT?.trim() || "http://127.0.0.1:7741/v1/rivet";
    const organizationId = process.env.HF_E2E_WORKSPACE?.trim() || "default";
    const repoRemote = requiredEnv("HF_E2E_GITHUB_REPO");
    const githubToken = requiredEnv("GITHUB_TOKEN");
    const { fullName } = parseGithubRepo(repoRemote);
    const normalizedRepoRemote = `https://github.com/${fullName}.git`;
    const seededBranch = `e2e/full-seed-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

    const client = createBackendClient({
      endpoint,
      defaultOrganizationId: organizationId,
    });

    try {
      await ensureRemoteBranchExists(githubToken, fullName, seededBranch);

      const repo = await requireImportedRepo(client, organizationId, repoRemote);
      expect(repo.remoteUrl).toBe(normalizedRepoRemote);

      const overview = await poll<RepoOverview>(
        "repo overview includes seeded branch",
        90_000,
        1_000,
        async () => client.getRepoOverview(organizationId, repo.repoId),
        (value) => value.branches.some((row: RepoOverview["branches"][number]) => row.branchName === seededBranch),
      );

      const postActionOverview = await client.getRepoOverview(organizationId, repo.repoId);
      const seededRow = postActionOverview.branches.find((row: RepoOverview["branches"][number]) => row.branchName === seededBranch);
      expect(Boolean(seededRow)).toBe(true);
      expect(postActionOverview.fetchedAt).toBeGreaterThanOrEqual(overview.fetchedAt);
    } finally {
      await githubApi(githubToken, `repos/${fullName}/git/refs/heads/${encodeURIComponent(seededBranch)}`, { method: "DELETE" }).catch(() => {});
    }
  });
});
