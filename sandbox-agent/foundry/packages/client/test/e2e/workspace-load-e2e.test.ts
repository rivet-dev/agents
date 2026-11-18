import { describe, expect, it } from "vitest";
import {
  createFoundryLogger,
  type TaskWorkspaceSnapshot,
  type WorkspaceSession,
  type WorkspaceTask,
  type WorkspaceModelId,
  type WorkspaceTranscriptEvent,
} from "@sandbox-agent/foundry-shared";
import { createBackendClient } from "../../src/backend-client.js";
import { requireImportedRepo } from "./helpers.js";

const RUN_WORKBENCH_LOAD_E2E = process.env.HF_ENABLE_DAEMON_WORKBENCH_LOAD_E2E === "1";
const logger = createFoundryLogger({
  service: "foundry-client-e2e",
  bindings: {
    suite: "workspace-load",
  },
});

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function workspaceModelEnv(name: string, fallback: WorkspaceModelId): WorkspaceModelId {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll<T>(label: string, timeoutMs: number, intervalMs: number, fn: () => Promise<T>, isDone: (value: T) => boolean): Promise<T> {
  const startedAt = Date.now();
  let lastValue: T;

  for (;;) {
    lastValue = await fn();
    if (isDone(lastValue)) {
      return lastValue;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

function findTask(snapshot: TaskWorkspaceSnapshot, taskId: string): WorkspaceTask {
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`task ${taskId} missing from snapshot`);
  }
  return task;
}

function findTab(task: WorkspaceTask, sessionId: string): WorkspaceSession {
  const tab = task.sessions.find((candidate) => candidate.id === sessionId);
  if (!tab) {
    throw new Error(`tab ${sessionId} missing from task ${task.id}`);
  }
  return tab;
}

function extractEventText(event: WorkspaceTranscriptEvent): string {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return String(payload ?? "");
  }

  const envelope = payload as {
    method?: unknown;
    params?: unknown;
    result?: unknown;
  };

  const params = envelope.params;
  if (params && typeof params === "object") {
    const update = (params as { update?: unknown }).update;
    if (update && typeof update === "object") {
      const content = (update as { content?: unknown }).content;
      if (content && typeof content === "object") {
        const chunkText = (content as { text?: unknown }).text;
        if (typeof chunkText === "string") {
          return chunkText;
        }
      }
    }

    const text = (params as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }

    const prompt = (params as { prompt?: Array<{ text?: unknown }> }).prompt;
    if (Array.isArray(prompt)) {
      return prompt
        .map((item) => (typeof item?.text === "string" ? item.text.trim() : ""))
        .filter(Boolean)
        .join("\n");
    }
  }

  const result = envelope.result;
  if (result && typeof result === "object") {
    const text = (result as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }

  return typeof envelope.method === "string" ? envelope.method : JSON.stringify(payload);
}

function transcriptIncludesAgentText(transcript: WorkspaceTranscriptEvent[], expectedText: string): boolean {
  return transcript
    .filter((event) => event.sender === "agent")
    .map((event) => extractEventText(event))
    .join("")
    .includes(expectedText);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

async function measureWorkspaceSnapshot(
  client: ReturnType<typeof createBackendClient>,
  organizationId: string,
  iterations: number,
): Promise<{
  avgMs: number;
  maxMs: number;
  payloadBytes: number;
  taskCount: number;
  tabCount: number;
  transcriptEventCount: number;
}> {
  const durations: number[] = [];
  let snapshot: TaskWorkspaceSnapshot | null = null;

  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    snapshot = await client.getWorkspace(organizationId);
    durations.push(performance.now() - startedAt);
  }

  const finalSnapshot = snapshot ?? {
    organizationId,
    repos: [],
    repositories: [],
    tasks: [],
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(finalSnapshot), "utf8");
  const tabCount = finalSnapshot.tasks.reduce((sum, task) => sum + task.sessions.length, 0);
  const transcriptEventCount = finalSnapshot.tasks.reduce((sum, task) => sum + task.sessions.reduce((tabSum, tab) => tabSum + tab.transcript.length, 0), 0);

  return {
    avgMs: Math.round(average(durations)),
    maxMs: Math.round(Math.max(...durations, 0)),
    payloadBytes,
    taskCount: finalSnapshot.tasks.length,
    tabCount,
    transcriptEventCount,
  };
}

describe("e2e(client): workspace load", () => {
  it.skipIf(!RUN_WORKBENCH_LOAD_E2E)("runs a simple sequential load profile against the real backend", { timeout: 30 * 60_000 }, async () => {
    const endpoint = process.env.HF_E2E_BACKEND_ENDPOINT?.trim() || "http://127.0.0.1:7741/v1/rivet";
    const organizationId = process.env.HF_E2E_WORKSPACE?.trim() || "default";
    const repoRemote = requiredEnv("HF_E2E_GITHUB_REPO");
    const model = workspaceModelEnv("HF_E2E_MODEL", "gpt-5.3-codex");
    const taskCount = intEnv("HF_LOAD_TASK_COUNT", 3);
    const extraSessionCount = intEnv("HF_LOAD_EXTRA_SESSION_COUNT", 2);
    const pollIntervalMs = intEnv("HF_LOAD_POLL_INTERVAL_MS", 2_000);

    const client = createBackendClient({
      endpoint,
      defaultOrganizationId: organizationId,
    });

    const repo = await requireImportedRepo(client, organizationId, repoRemote);
    const createTaskLatencies: number[] = [];
    const provisionLatencies: number[] = [];
    const createSessionLatencies: number[] = [];
    const messageRoundTripLatencies: number[] = [];
    const snapshotSeries: Array<{
      taskCount: number;
      avgMs: number;
      maxMs: number;
      payloadBytes: number;
      tabCount: number;
      transcriptEventCount: number;
    }> = [];

    snapshotSeries.push(await measureWorkspaceSnapshot(client, organizationId, 2));

    for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
      const runId = `load-${taskIndex}-${Date.now().toString(36)}`;
      const initialReply = `LOAD_INIT_${runId}`;

      const createStartedAt = performance.now();
      const created = await client.createWorkspaceTask(organizationId, {
        repoId: repo.repoId,
        title: `Workspace Load ${runId}`,
        branch: `load/${runId}`,
        model,
        task: `Reply with exactly: ${initialReply}`,
      });
      createTaskLatencies.push(performance.now() - createStartedAt);

      const provisionStartedAt = performance.now();
      const provisioned = await poll(
        `task ${runId} provisioning`,
        12 * 60_000,
        pollIntervalMs,
        async () => findTask(await client.getWorkspace(organizationId), created.taskId),
        (task) => {
          const tab = task.sessions[0];
          return Boolean(tab && task.status === "idle" && tab.status === "idle" && transcriptIncludesAgentText(tab.transcript, initialReply));
        },
      );
      provisionLatencies.push(performance.now() - provisionStartedAt);

      expect(provisioned.sessions.length).toBeGreaterThan(0);
      const primaryTab = provisioned.sessions[0]!;
      expect(transcriptIncludesAgentText(primaryTab.transcript, initialReply)).toBe(true);

      for (let sessionIndex = 0; sessionIndex < extraSessionCount; sessionIndex += 1) {
        const expectedReply = `LOAD_REPLY_${runId}_${sessionIndex}`;
        const createSessionStartedAt = performance.now();
        const createdSession = await client.createWorkspaceSession(organizationId, {
          repoId: repo.repoId,
          taskId: created.taskId,
          model,
        });
        createSessionLatencies.push(performance.now() - createSessionStartedAt);

        await client.sendWorkspaceMessage(organizationId, {
          repoId: repo.repoId,
          taskId: created.taskId,
          sessionId: createdSession.sessionId,
          text: `Run pwd in the repo, then reply with exactly: ${expectedReply}`,
          attachments: [],
        });

        const messageStartedAt = performance.now();
        const withReply = await poll(
          `task ${runId} session ${sessionIndex} reply`,
          10 * 60_000,
          pollIntervalMs,
          async () => findTask(await client.getWorkspace(organizationId), created.taskId),
          (task) => {
            const tab = findTab(task, createdSession.sessionId);
            return tab.status === "idle" && transcriptIncludesAgentText(tab.transcript, expectedReply);
          },
        );
        messageRoundTripLatencies.push(performance.now() - messageStartedAt);

        expect(transcriptIncludesAgentText(findTab(withReply, createdSession.sessionId).transcript, expectedReply)).toBe(true);
      }

      const snapshotMetrics = await measureWorkspaceSnapshot(client, organizationId, 3);
      snapshotSeries.push(snapshotMetrics);
      logger.info(
        {
          taskIndex: taskIndex + 1,
          ...snapshotMetrics,
        },
        "workspace_load_snapshot",
      );
    }

    const firstSnapshot = snapshotSeries[0]!;
    const lastSnapshot = snapshotSeries[snapshotSeries.length - 1]!;
    const summary = {
      taskCount,
      extraSessionCount,
      createTaskAvgMs: Math.round(average(createTaskLatencies)),
      provisionAvgMs: Math.round(average(provisionLatencies)),
      createSessionAvgMs: Math.round(average(createSessionLatencies)),
      messageRoundTripAvgMs: Math.round(average(messageRoundTripLatencies)),
      snapshotReadBaselineAvgMs: firstSnapshot.avgMs,
      snapshotReadFinalAvgMs: lastSnapshot.avgMs,
      snapshotReadFinalMaxMs: lastSnapshot.maxMs,
      snapshotPayloadBaselineBytes: firstSnapshot.payloadBytes,
      snapshotPayloadFinalBytes: lastSnapshot.payloadBytes,
      snapshotTabFinalCount: lastSnapshot.tabCount,
      snapshotTranscriptFinalCount: lastSnapshot.transcriptEventCount,
    };

    logger.info(summary, "workspace_load_summary");

    expect(createTaskLatencies.length).toBe(taskCount);
    expect(provisionLatencies.length).toBe(taskCount);
    expect(createSessionLatencies.length).toBe(taskCount * extraSessionCount);
    expect(messageRoundTripLatencies.length).toBe(taskCount * extraSessionCount);
  });
});
