import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationEvent, OrganizationSummarySnapshot } from "@sandbox-agent/foundry-shared";
import type { ActorConn, BackendClient } from "../src/backend-client.js";
import { RemoteSubscriptionManager } from "../src/subscription/remote-manager.js";

class FakeActorConn implements ActorConn {
  private readonly listeners = new Map<string, Set<(payload: any) => void>>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  disposeCount = 0;

  on(event: string, listener: (payload: any) => void): () => void {
    let current = this.listeners.get(event);
    if (!current) {
      current = new Set();
      this.listeners.set(event, current);
    }
    current.add(listener);
    return () => {
      current?.delete(listener);
      if (current?.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }

  emitError(error: unknown): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }
}

function organizationSnapshot(): OrganizationSummarySnapshot {
  return {
    organizationId: "org-1",
    github: {
      connectedAccount: "octocat",
      installationStatus: "connected",
      syncStatus: "synced",
      importedRepoCount: 1,
      lastSyncLabel: "Synced just now",
      lastSyncAt: 10,
      lastWebhookAt: null,
      lastWebhookEvent: "",
      syncGeneration: 1,
      syncPhase: null,
      processedRepositoryCount: 1,
      totalRepositoryCount: 1,
    },
    repos: [{ id: "repo-1", label: "repo-1", taskCount: 1, latestActivityMs: 10 }],
    taskSummaries: [
      {
        id: "task-1",
        repoId: "repo-1",
        title: "Initial task",
        status: "idle",
        repoName: "repo-1",
        updatedAtMs: 10,
        branch: "main",
        pullRequest: null,
        activeSessionId: null,
        sessionsSummary: [],
        primaryUserLogin: null,
        primaryUserAvatarUrl: null,
      },
    ],
  };
}

function createBackend(conn: FakeActorConn, snapshot: OrganizationSummarySnapshot): BackendClient {
  return {
    connectOrganization: vi.fn(async () => conn),
    getOrganizationSummary: vi.fn(async () => snapshot),
  } as unknown as BackendClient;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RemoteSubscriptionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one connection per topic key and applies incoming events", async () => {
    const conn = new FakeActorConn();
    const backend = createBackend(conn, organizationSnapshot());
    const manager = new RemoteSubscriptionManager(backend);
    const params = { organizationId: "org-1" } as const;
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    const unsubscribeA = manager.subscribe("organization", params, listenerA);
    const unsubscribeB = manager.subscribe("organization", params, listenerB);
    await flushAsyncWork();

    expect(backend.connectOrganization).toHaveBeenCalledTimes(1);
    expect(backend.getOrganizationSummary).toHaveBeenCalledTimes(1);
    expect(manager.getStatus("organization", params)).toBe("connected");
    expect(manager.getSnapshot("organization", params)?.taskSummaries[0]?.title).toBe("Initial task");
    expect(manager.listDebugTopics()).toEqual([
      expect.objectContaining({
        topicKey: "organization",
        cacheKey: "organization:org-1",
        listenerCount: 2,
        status: "connected",
      }),
    ]);

    conn.emit("organizationUpdated", {
      type: "organizationUpdated",
      snapshot: {
        organizationId: "org-1",
        github: {
          connectedAccount: "octocat",
          installationStatus: "connected",
          syncStatus: "syncing",
          importedRepoCount: 1,
          lastSyncLabel: "Syncing repositories...",
          lastSyncAt: 10,
          lastWebhookAt: null,
          lastWebhookEvent: "",
          syncGeneration: 2,
          syncPhase: "syncing_branches",
          processedRepositoryCount: 1,
          totalRepositoryCount: 3,
        },
        repos: [],
        taskSummaries: [
          {
            id: "task-1",
            repoId: "repo-1",
            title: "Updated task",
            status: "running",
            repoName: "repo-1",
            updatedAtMs: 20,
            branch: "feature/live",
            pullRequest: null,
            activeSessionId: null,
            sessionsSummary: [],
            primaryUserLogin: null,
            primaryUserAvatarUrl: null,
          },
        ],
      },
    } satisfies OrganizationEvent);

    // applyEvent chains onto an internal promise — flush the microtask queue
    await flushAsyncWork();

    expect(manager.getSnapshot("organization", params)?.taskSummaries[0]?.title).toBe("Updated task");
    expect(listenerA).toHaveBeenCalled();
    expect(listenerB).toHaveBeenCalled();
    expect(manager.listDebugTopics()[0]?.lastRefreshAt).toEqual(expect.any(Number));

    unsubscribeA();
    unsubscribeB();
    manager.dispose();
  });

  it("keeps a topic warm during the grace period and tears it down afterwards", async () => {
    const conn = new FakeActorConn();
    const backend = createBackend(conn, organizationSnapshot());
    const manager = new RemoteSubscriptionManager(backend);
    const params = { organizationId: "org-1" } as const;

    const unsubscribeA = manager.subscribe("organization", params, () => {});
    await flushAsyncWork();
    unsubscribeA();

    vi.advanceTimersByTime(29_000);
    expect(manager.listDebugTopics()).toEqual([]);

    const unsubscribeB = manager.subscribe("organization", params, () => {});
    await flushAsyncWork();

    expect(backend.connectOrganization).toHaveBeenCalledTimes(1);
    expect(conn.disposeCount).toBe(0);

    unsubscribeB();
    expect(manager.listDebugTopics()).toEqual([]);
    vi.advanceTimersByTime(30_000);

    expect(conn.disposeCount).toBe(1);
    expect(manager.getSnapshot("organization", params)).toBeUndefined();
  });

  it("surfaces connection errors to subscribers", async () => {
    const conn = new FakeActorConn();
    const backend = createBackend(conn, organizationSnapshot());
    const manager = new RemoteSubscriptionManager(backend);
    const params = { organizationId: "org-1" } as const;

    manager.subscribe("organization", params, () => {});
    await flushAsyncWork();

    conn.emitError(new Error("socket dropped"));

    expect(manager.getStatus("organization", params)).toBe("error");
    expect(manager.getError("organization", params)?.message).toBe("socket dropped");
  });
});
