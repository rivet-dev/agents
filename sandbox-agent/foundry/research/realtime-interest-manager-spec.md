# Realtime Interest Manager — Implementation Spec

## Overview

Replace the current polling + empty-notification + full-refetch architecture with a push-based realtime system. The client subscribes to topics, receives the initial state, and then receives full replacement payloads for changed entities over WebSocket. No polling. No re-fetching.

This spec covers three layers: backend (materialized state + broadcast), client library (subscription manager), and frontend (hook consumption). Comment architecture-related code throughout so new contributors can understand the data flow from comments alone.

---

## 1. Data Model: What Changes

### 1.1 Split `WorkbenchTask` into summary and detail types

**File:** `packages/shared/src/workbench.ts`

Currently `WorkbenchTask` is a single flat type carrying everything (sidebar fields + transcripts + diffs + file tree). Split it:

```typescript
/** Sidebar-level task data. Materialized in the organization actor's SQLite. */
export interface WorkbenchTaskSummary {
  id: string;
  repoId: string;
  title: string;
  status: WorkbenchTaskStatus;
  repoName: string;
  updatedAtMs: number;
  branch: string | null;
  pullRequest: WorkbenchPullRequestSummary | null;
  /** Summary of sessions — no transcript content. */
  sessionsSummary: WorkbenchSessionSummary[];
}

/** Session metadata without transcript content. */
export interface WorkbenchSessionSummary {
  id: string;
  sessionId: string | null;
  sessionName: string;
  agent: WorkbenchAgentKind;
  model: WorkbenchModelId;
  status: "running" | "idle" | "error";
  thinkingSinceMs: number | null;
  unread: boolean;
  created: boolean;
}

/** Repo-level summary for organization sidebar. */
export interface WorkbenchRepoSummary {
  id: string;
  label: string;
  /** Aggregated branch/task overview state (replaces getRepoOverview polling). */
  taskCount: number;
  latestActivityMs: number;
}

/** Full task detail — only fetched when viewing a specific task. */
export interface WorkbenchTaskDetail {
  id: string;
  repoId: string;
  title: string;
  status: WorkbenchTaskStatus;
  repoName: string;
  updatedAtMs: number;
  branch: string | null;
  pullRequest: WorkbenchPullRequestSummary | null;
  sessionsSummary: WorkbenchSessionSummary[];
  fileChanges: WorkbenchFileChange[];
  diffs: Record<string, string>;
  fileTree: WorkbenchFileTreeNode[];
  minutesUsed: number;
  /** Sandbox info for this task. */
  sandboxes: WorkbenchSandboxSummary[];
  activeSandboxId: string | null;
}

export interface WorkbenchSandboxSummary {
  providerId: string;
  sandboxId: string;
  cwd: string | null;
}

/** Full session content — only fetched when viewing a specific session tab. */
export interface WorkbenchSessionDetail {
  sessionId: string;
  tabId: string;
  sessionName: string;
  agent: WorkbenchAgentKind;
  model: WorkbenchModelId;
  status: "running" | "idle" | "error";
  thinkingSinceMs: number | null;
  unread: boolean;
  draft: WorkbenchComposerDraft;
  transcript: WorkbenchTranscriptEvent[];
}

/** Organization-level snapshot — initial fetch for the organization topic. */
export interface OrganizationSummarySnapshot {
  organizationId: string;
  repos: WorkbenchRepoSummary[];
  taskSummaries: WorkbenchTaskSummary[];
}
```

Remove the old `TaskWorkbenchSnapshot` type and `WorkbenchTask` type once migration is complete.

### 1.2 Event payload types

**File:** `packages/shared/src/realtime-events.ts` (new file)

Each event carries the full new state of the changed entity — not a patch, not an empty notification.

```typescript
/** Organization-level events broadcast by the organization actor. */
export type OrganizationEvent =
  | { type: "taskSummaryUpdated"; taskSummary: WorkbenchTaskSummary }
  | { type: "taskRemoved"; taskId: string }
  | { type: "repoAdded"; repo: WorkbenchRepoSummary }
  | { type: "repoUpdated"; repo: WorkbenchRepoSummary }
  | { type: "repoRemoved"; repoId: string };

/** Task-level events broadcast by the task actor. */
export type TaskEvent =
  | { type: "taskDetailUpdated"; detail: WorkbenchTaskDetail };

/** Session-level events broadcast by the task actor, filtered by sessionId on the client. */
export type SessionEvent =
  | { type: "sessionUpdated"; session: WorkbenchSessionDetail };

/** App-level events broadcast by the app organization actor. */
export type AppEvent =
  | { type: "appUpdated"; snapshot: FoundryAppSnapshot };

/** Sandbox process events broadcast by the sandbox instance actor. */
export type SandboxProcessesEvent =
  | { type: "processesUpdated"; processes: SandboxProcessRecord[] };
```

---

## 2. Backend: Materialized State + Broadcasts

### 2.1 Organization actor — materialized sidebar state

**Files:**
- `packages/backend/src/actors/organization/db/schema.ts` — add tables
- `packages/backend/src/actors/organization/actions.ts` — replace `buildWorkbenchSnapshot`, add delta handlers

Add to organization actor SQLite schema:

```typescript
export const taskSummaries = sqliteTable("task_summaries", {
  taskId: text("task_id").primaryKey(),
  repoId: text("repo_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(), // WorkbenchTaskStatus
  repoName: text("repo_name").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  branch: text("branch"),
  pullRequestJson: text("pull_request_json"), // JSON-serialized WorkbenchPullRequestSummary | null
  sessionsSummaryJson: text("sessions_summary_json").notNull().default("[]"), // JSON array of WorkbenchSessionSummary
});
```

New organization actions:

```typescript
/**
 * Called by task actors when their summary-level state changes.
 * Upserts the task summary row and broadcasts the update to all connected clients.
 *
 * This is the core of the materialized state pattern: task actors push their
 * summary changes here instead of requiring clients to fan out to every task.
 */
async applyTaskSummaryUpdate(c, input: { taskSummary: WorkbenchTaskSummary }) {
  // Upsert into taskSummaries table
  await c.db.insert(taskSummaries).values(toRow(input.taskSummary))
    .onConflictDoUpdate({ target: taskSummaries.taskId, set: toRow(input.taskSummary) }).run();
  // Broadcast to connected clients
  c.broadcast("organizationUpdated", { type: "taskSummaryUpdated", taskSummary: input.taskSummary });
}

async removeTaskSummary(c, input: { taskId: string }) {
  await c.db.delete(taskSummaries).where(eq(taskSummaries.taskId, input.taskId)).run();
  c.broadcast("organizationUpdated", { type: "taskRemoved", taskId: input.taskId });
}

/**
 * Initial fetch for the organization topic.
 * Reads entirely from local SQLite — no fan-out to child actors.
 */
async getWorkspaceSummary(c, input: { organizationId: string }): Promise<OrganizationSummarySnapshot> {
  const repoRows = await c.db.select().from(repos).orderBy(desc(repos.updatedAt)).all();
  const taskRows = await c.db.select().from(taskSummaries).orderBy(desc(taskSummaries.updatedAtMs)).all();
  return {
    organizationId: c.state.organizationId,
    repos: repoRows.map(toRepoSummary),
    taskSummaries: taskRows.map(toTaskSummary),
  };
}
```

Replace `buildWorkbenchSnapshot` (the fan-out) — keep it only as a `reconcileWorkbenchState` background action for recovery/rebuild.

### 2.2 Task actor — push summaries to organization + broadcast detail

**Files:**
- `packages/backend/src/actors/task/workbench.ts` — replace `notifyWorkbenchUpdated` calls

Every place that currently calls `notifyWorkbenchUpdated(c)` (there are ~20 call sites) must instead:

1. Build the current `WorkbenchTaskSummary` from local state.
2. Push it to the organization actor: `organization.applyTaskSummaryUpdate({ taskSummary })`.
3. Build the current `WorkbenchTaskDetail` from local state.
4. Broadcast to directly-connected clients: `c.broadcast("taskUpdated", { type: "taskDetailUpdated", detail })`.
5. If session state changed, also broadcast: `c.broadcast("sessionUpdated", { type: "sessionUpdated", session: buildSessionDetail(c, sessionId) })`.

Add helper functions:

```typescript
/**
 * Builds a WorkbenchTaskSummary from local task actor state.
 * This is what gets pushed to the organization actor for sidebar materialization.
 */
function buildTaskSummary(c: any): WorkbenchTaskSummary { ... }

/**
 * Builds a WorkbenchTaskDetail from local task actor state.
 * This is broadcast to clients directly connected to this task.
 */
function buildTaskDetail(c: any): WorkbenchTaskDetail { ... }

/**
 * Builds a WorkbenchSessionDetail for a specific session.
 * Broadcast to clients subscribed to this session's updates.
 */
function buildSessionDetail(c: any, sessionId: string): WorkbenchSessionDetail { ... }

/**
 * Replaces the old notifyWorkbenchUpdated pattern.
 * Pushes summary to organization actor + broadcasts detail to direct subscribers.
 */
async function broadcastTaskUpdate(c: any, options?: { sessionId?: string }) {
  // Push summary to parent organization actor
  const organization = await getOrCreateOrganization(c, c.state.organizationId);
  await organization.applyTaskSummaryUpdate({ taskSummary: buildTaskSummary(c) });

  // Broadcast detail to clients connected to this task
  c.broadcast("taskUpdated", { type: "taskDetailUpdated", detail: buildTaskDetail(c) });

  // If a specific session changed, broadcast session detail
  if (options?.sessionId) {
    c.broadcast("sessionUpdated", {
      type: "sessionUpdated",
      session: buildSessionDetail(c, options.sessionId),
    });
  }
}
```

### 2.3 Task actor — new actions for initial fetch

```typescript
/**
 * Initial fetch for the task topic.
 * Reads from local SQLite only — no cross-actor calls.
 */
async getTaskDetail(c): Promise<WorkbenchTaskDetail> { ... }

/**
 * Initial fetch for the session topic.
 * Returns full session content including transcript.
 */
async getSessionDetail(c, input: { sessionId: string }): Promise<WorkbenchSessionDetail> { ... }
```

### 2.4 App organization actor

**File:** `packages/backend/src/actors/organization/app-shell.ts`

Change `c.broadcast("appUpdated", { at: Date.now(), sessionId })` to:
```typescript
c.broadcast("appUpdated", { type: "appUpdated", snapshot: await buildAppSnapshot(c, sessionId) });
```

### 2.5 Sandbox instance actor

**File:** `packages/backend/src/actors/sandbox-instance/index.ts`

Change `broadcastProcessesUpdated` to include the process list:
```typescript
function broadcastProcessesUpdated(c: any): void {
  const processes = /* read from local DB */;
  c.broadcast("processesUpdated", { type: "processesUpdated", processes });
}
```

---

## 3. Client Library: Interest Manager

### 3.1 Topic definitions

**File:** `packages/client/src/interest/topics.ts` (new)

```typescript
/**
 * Topic definitions for the subscription manager.
 *
 * Each topic defines how to connect to an actor, fetch initial state,
 * which event to listen for, and how to apply incoming events to cached state.
 *
 * The subscription manager uses these definitions to manage WebSocket connections,
 * cached state, and subscriptions for all realtime data flows.
 */

export interface TopicDefinition<TData, TParams, TEvent> {
  /** Derive a unique cache key from params. */
  key: (params: TParams) => string;

  /** Which broadcast event name to listen for on the actor connection. */
  event: string;

  /** Open a WebSocket connection to the actor. */
  connect: (backend: BackendClient, params: TParams) => Promise<ActorConn>;

  /** Fetch the initial snapshot from the actor. */
  fetchInitial: (backend: BackendClient, params: TParams) => Promise<TData>;

  /** Apply an incoming event to the current cached state. Returns the new state. */
  applyEvent: (current: TData, event: TEvent) => TData;
}

export interface AppTopicParams {}
export interface OrganizationTopicParams { organizationId: string }
export interface TaskTopicParams { organizationId: string; repoId: string; taskId: string }
export interface SessionTopicParams { organizationId: string; repoId: string; taskId: string; sessionId: string }
export interface SandboxProcessesTopicParams { organizationId: string; providerId: string; sandboxId: string }

export const topicDefinitions = {
  app: {
    key: () => "app",
    event: "appUpdated",
    connect: (b, _p) => b.connectWorkspace("app"),
    fetchInitial: (b, _p) => b.getAppSnapshot(),
    applyEvent: (_current, event: AppEvent) => event.snapshot,
  } satisfies TopicDefinition<FoundryAppSnapshot, AppTopicParams, AppEvent>,

  organization: {
    key: (p) => `organization:${p.organizationId}`,
    event: "organizationUpdated",
    connect: (b, p) => b.connectWorkspace(p.organizationId),
    fetchInitial: (b, p) => b.getWorkspaceSummary(p.organizationId),
    applyEvent: (current, event: OrganizationEvent) => {
      switch (event.type) {
        case "taskSummaryUpdated":
          return {
            ...current,
            taskSummaries: upsertById(current.taskSummaries, event.taskSummary),
          };
        case "taskRemoved":
          return {
            ...current,
            taskSummaries: current.taskSummaries.filter(t => t.id !== event.taskId),
          };
        case "repoAdded":
        case "repoUpdated":
          return {
            ...current,
            repos: upsertById(current.repos, event.repo),
          };
        case "repoRemoved":
          return {
            ...current,
            repos: current.repos.filter(r => r.id !== event.repoId),
          };
      }
    },
  } satisfies TopicDefinition<OrganizationSummarySnapshot, OrganizationTopicParams, OrganizationEvent>,

  task: {
    key: (p) => `task:${p.organizationId}:${p.taskId}`,
    event: "taskUpdated",
    connect: (b, p) => b.connectTask(p.organizationId, p.repoId, p.taskId),
    fetchInitial: (b, p) => b.getTaskDetail(p.organizationId, p.repoId, p.taskId),
    applyEvent: (_current, event: TaskEvent) => event.detail,
  } satisfies TopicDefinition<WorkbenchTaskDetail, TaskTopicParams, TaskEvent>,

  session: {
    key: (p) => `session:${p.organizationId}:${p.taskId}:${p.sessionId}`,
    event: "sessionUpdated",
    // Reuses the task actor connection — same actor, different event.
    connect: (b, p) => b.connectTask(p.organizationId, p.repoId, p.taskId),
    fetchInitial: (b, p) => b.getSessionDetail(p.organizationId, p.repoId, p.taskId, p.sessionId),
    applyEvent: (current, event: SessionEvent) => {
      // Filter: only apply if this event is for our session
      if (event.session.sessionId !== current.sessionId) return current;
      return event.session;
    },
  } satisfies TopicDefinition<WorkbenchSessionDetail, SessionTopicParams, SessionEvent>,

  sandboxProcesses: {
    key: (p) => `sandbox:${p.organizationId}:${p.sandboxId}`,
    event: "processesUpdated",
    connect: (b, p) => b.connectSandbox(p.organizationId, p.providerId, p.sandboxId),
    fetchInitial: (b, p) => b.listSandboxProcesses(p.organizationId, p.providerId, p.sandboxId),
    applyEvent: (_current, event: SandboxProcessesEvent) => event.processes,
  } satisfies TopicDefinition<SandboxProcessRecord[], SandboxProcessesTopicParams, SandboxProcessesEvent>,
} as const;

/** Derive TypeScript types from the topic registry. */
export type TopicKey = keyof typeof topicDefinitions;
export type TopicParams<K extends TopicKey> = Parameters<(typeof topicDefinitions)[K]["fetchInitial"]>[1];
export type TopicData<K extends TopicKey> = Awaited<ReturnType<(typeof topicDefinitions)[K]["fetchInitial"]>>;
```

### 3.2 Subscription manager interface

**File:** `packages/client/src/interest/manager.ts` (new)

```typescript
/**
 * The SubscriptionManager owns all realtime actor connections and cached state.
 *
 * Architecture:
 * - Each topic (app, organization, task, session, sandboxProcesses) maps to an actor + event.
 * - On first subscription, the manager opens a WebSocket connection, fetches initial state,
 *   and listens for events. Events carry full replacement payloads for the changed entity.
 * - Multiple subscribers to the same topic share one connection and one cached state.
 * - When the last subscriber leaves, a 30-second grace period keeps the connection alive
 *   to avoid thrashing during screen navigation or React double-renders.
 * - The interface is identical for mock and remote implementations.
 */
export interface SubscriptionManager {
  /**
   * Subscribe to a topic. Returns an unsubscribe function.
   * On first subscriber: opens connection, fetches initial state, starts listening.
   * On last unsubscribe: starts 30s grace period before teardown.
   */
  subscribe<K extends TopicKey>(
    topicKey: K,
    params: TopicParams<K>,
    listener: () => void,
  ): () => void;

  /** Get the current cached state for a topic. Returns undefined if not yet loaded. */
  getSnapshot<K extends TopicKey>(topicKey: K, params: TopicParams<K>): TopicData<K> | undefined;

  /** Get the connection/loading status for a topic. */
  getStatus<K extends TopicKey>(topicKey: K, params: TopicParams<K>): TopicStatus;

  /** Get the error (if any) for a topic. */
  getError<K extends TopicKey>(topicKey: K, params: TopicParams<K>): Error | null;

  /** Dispose all connections and cached state. */
  dispose(): void;
}

export type TopicStatus = "loading" | "connected" | "error";

export interface TopicState<K extends TopicKey> {
  data: TopicData<K> | undefined;
  status: TopicStatus;
  error: Error | null;
}
```

### 3.3 Remote implementation

**File:** `packages/client/src/interest/remote-manager.ts` (new)

```typescript
const GRACE_PERIOD_MS = 30_000;

/**
 * Remote implementation of SubscriptionManager.
 * Manages WebSocket connections to RivetKit actors via BackendClient.
 */
export class RemoteSubscriptionManager implements SubscriptionManager {
  private entries = new Map<string, TopicEntry<any, any, any>>();

  constructor(private backend: BackendClient) {}

  subscribe<K extends TopicKey>(topicKey: K, params: TopicParams<K>, listener: () => void): () => void {
    const def = topicDefinitions[topicKey];
    const cacheKey = def.key(params);
    let entry = this.entries.get(cacheKey);

    if (!entry) {
      entry = new TopicEntry(def, this.backend, params);
      this.entries.set(cacheKey, entry);
    }

    entry.cancelTeardown();
    entry.addListener(listener);
    entry.ensureStarted();

    return () => {
      entry!.removeListener(listener);
      if (entry!.listenerCount === 0) {
        entry!.scheduleTeardown(GRACE_PERIOD_MS, () => {
          this.entries.delete(cacheKey);
        });
      }
    };
  }

  getSnapshot<K extends TopicKey>(topicKey: K, params: TopicParams<K>): TopicData<K> | undefined {
    const cacheKey = topicDefinitions[topicKey].key(params);
    return this.entries.get(cacheKey)?.data;
  }

  getStatus<K extends TopicKey>(topicKey: K, params: TopicParams<K>): TopicStatus {
    const cacheKey = topicDefinitions[topicKey].key(params);
    return this.entries.get(cacheKey)?.status ?? "loading";
  }

  getError<K extends TopicKey>(topicKey: K, params: TopicParams<K>): Error | null {
    const cacheKey = topicDefinitions[topicKey].key(params);
    return this.entries.get(cacheKey)?.error ?? null;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.dispose();
    }
    this.entries.clear();
  }
}

/**
 * Internal entry managing one topic's connection, state, and listeners.
 *
 * Lifecycle:
 * 1. ensureStarted() — opens WebSocket, fetches initial state, subscribes to events.
 * 2. Events arrive — applyEvent() updates cached state, notifies listeners.
 * 3. Last listener leaves — scheduleTeardown() starts 30s timer.
 * 4. Timer fires or dispose() called — closes WebSocket, drops state.
 * 5. If a new subscriber arrives during grace period — cancelTeardown(), reuse connection.
 */
class TopicEntry<TData, TParams, TEvent> {
  data: TData | undefined = undefined;
  status: TopicStatus = "loading";
  error: Error | null = null;
  listenerCount = 0;

  private listeners = new Set<() => void>();
  private conn: ActorConn | null = null;
  private unsubscribeEvent: (() => void) | null = null;
  private teardownTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private startPromise: Promise<void> | null = null;

  constructor(
    private def: TopicDefinition<TData, TParams, TEvent>,
    private backend: BackendClient,
    private params: TParams,
  ) {}

  addListener(listener: () => void) {
    this.listeners.add(listener);
    this.listenerCount = this.listeners.size;
  }

  removeListener(listener: () => void) {
    this.listeners.delete(listener);
    this.listenerCount = this.listeners.size;
  }

  ensureStarted() {
    if (this.started || this.startPromise) return;
    this.startPromise = this.start().finally(() => { this.startPromise = null; });
  }

  private async start() {
    try {
      // Open connection
      this.conn = await this.def.connect(this.backend, this.params);

      // Subscribe to events
      this.unsubscribeEvent = this.conn.on(this.def.event, (event: TEvent) => {
        if (this.data !== undefined) {
          this.data = this.def.applyEvent(this.data, event);
          this.notify();
        }
      });

      // Fetch initial state
      this.data = await this.def.fetchInitial(this.backend, this.params);
      this.status = "connected";
      this.started = true;
      this.notify();
    } catch (err) {
      this.status = "error";
      this.error = err instanceof Error ? err : new Error(String(err));
      this.notify();
    }
  }

  scheduleTeardown(ms: number, onTeardown: () => void) {
    this.teardownTimer = setTimeout(() => {
      this.dispose();
      onTeardown();
    }, ms);
  }

  cancelTeardown() {
    if (this.teardownTimer) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
  }

  dispose() {
    this.cancelTeardown();
    this.unsubscribeEvent?.();
    if (this.conn) {
      void (this.conn as any).dispose?.();
    }
    this.conn = null;
    this.data = undefined;
    this.status = "loading";
    this.started = false;
  }

  private notify() {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
```

### 3.4 Mock implementation

**File:** `packages/client/src/interest/mock-manager.ts` (new)

Same `SubscriptionManager` interface. Uses in-memory state. Topic definitions provide mock data. Mutations call `applyEvent` directly on the entry to simulate broadcasts. No WebSocket connections.

### 3.5 React hook

**File:** `packages/client/src/interest/use-interest.ts` (new)

```typescript
import { useSyncExternalStore, useMemo } from "react";

/**
 * Subscribe to a realtime topic. Returns the current state, loading status, and error.
 *
 * - Pass `null` as params to disable the subscription (conditional interest).
 * - Data is cached for 30 seconds after the last subscriber leaves.
 * - Multiple components subscribing to the same topic share one connection.
 *
 * @example
 * // Subscribe to organization sidebar data
 * const organization = useSubscription("organization", { organizationId });
 *
 * // Subscribe to task detail (only when viewing a task)
 * const task = useSubscription("task", selectedTaskId ? { organizationId, repoId, taskId } : null);
 *
 * // Subscribe to active session content
 * const session = useSubscription("session", activeSessionId ? { organizationId, repoId, taskId, sessionId } : null);
 */
export function useSubscription<K extends TopicKey>(
  manager: SubscriptionManager,
  topicKey: K,
  params: TopicParams<K> | null,
): TopicState<K> {
  // Stabilize params reference to avoid unnecessary resubscriptions
  const paramsKey = params ? topicDefinitions[topicKey].key(params) : null;

  const subscribe = useMemo(() => {
    return (listener: () => void) => {
      if (!params) return () => {};
      return manager.subscribe(topicKey, params, listener);
    };
  }, [manager, topicKey, paramsKey]);

  const getSnapshot = useMemo(() => {
    return (): TopicState<K> => {
      if (!params) return { data: undefined, status: "loading", error: null };
      return {
        data: manager.getSnapshot(topicKey, params),
        status: manager.getStatus(topicKey, params),
        error: manager.getError(topicKey, params),
      };
    };
  }, [manager, topicKey, paramsKey]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
```

### 3.6 BackendClient additions

**File:** `packages/client/src/backend-client.ts`

Add to the `BackendClient` interface:

```typescript
// New connection methods (return WebSocket-based ActorConn)
connectWorkspace(organizationId: string): Promise<ActorConn>;
connectTask(organizationId: string, repoId: string, taskId: string): Promise<ActorConn>;
connectSandbox(organizationId: string, providerId: string, sandboxId: string): Promise<ActorConn>;

// New fetch methods (read from materialized state)
getWorkspaceSummary(organizationId: string): Promise<OrganizationSummarySnapshot>;
getTaskDetail(organizationId: string, repoId: string, taskId: string): Promise<WorkbenchTaskDetail>;
getSessionDetail(organizationId: string, repoId: string, taskId: string, sessionId: string): Promise<WorkbenchSessionDetail>;
```

Remove:
- `subscribeWorkbench`, `subscribeApp`, `subscribeSandboxProcesses` (replaced by subscription manager)
- `getWorkbench` (replaced by `getWorkspaceSummary` + `getTaskDetail`)

---

## 4. Frontend: Hook Consumption

### 4.1 Provider setup

**File:** `packages/frontend/src/lib/interest.ts` (new)

```typescript
import { RemoteSubscriptionManager } from "@sandbox-agent/foundry-client";
import { backendClient } from "./backend";

export const subscriptionManager = new RemoteSubscriptionManager(backendClient);
```

Or for mock mode:
```typescript
import { MockSubscriptionManager } from "@sandbox-agent/foundry-client";
export const subscriptionManager = new MockSubscriptionManager();
```

### 4.2 Replace MockLayout workbench subscription

**File:** `packages/frontend/src/components/mock-layout.tsx`

Before:
```typescript
const taskWorkbenchClient = useMemo(() => getTaskWorkbenchClient(organizationId), [organizationId]);
const viewModel = useSyncExternalStore(
  taskWorkbenchClient.subscribe.bind(taskWorkbenchClient),
  taskWorkbenchClient.getSnapshot.bind(taskWorkbenchClient),
);
const tasks = viewModel.tasks ?? [];
```

After:
```typescript
const organization = useSubscription(subscriptionManager, "organization", { organizationId });
const taskSummaries = organization.data?.taskSummaries ?? [];
const repos = organization.data?.repos ?? [];
```

### 4.3 Replace MockLayout task detail

When a task is selected, subscribe to its detail:

```typescript
const taskDetail = useSubscription(subscriptionManager, "task",
  selectedTaskId ? { organizationId, repoId: activeRepoId, taskId: selectedTaskId } : null
);
```

### 4.4 Replace session subscription

When a session tab is active:

```typescript
const sessionDetail = useSubscription(subscriptionManager, "session",
  activeSessionId ? { organizationId, repoId, taskId, sessionId: activeSessionId } : null
);
```

### 4.5 Replace organization-dashboard.tsx polling

Remove ALL `useQuery` with `refetchInterval` in this file:
- `tasksQuery` (2.5s polling) → `useSubscription("organization", ...)`
- `taskDetailQuery` (2.5s polling) → `useSubscription("task", ...)`
- `reposQuery` (10s polling) → `useSubscription("organization", ...)`
- `repoOverviewQuery` (5s polling) → `useSubscription("organization", ...)`
- `sessionsQuery` (3s polling) → `useSubscription("task", ...)` (sessionsSummary field)
- `eventsQuery` (2.5s polling) → `useSubscription("session", ...)`

### 4.6 Replace terminal-pane.tsx polling

- `taskQuery` (2s polling) → `useSubscription("task", ...)`
- `processesQuery` (3s polling) → `useSubscription("sandboxProcesses", ...)`
- Remove `subscribeSandboxProcesses` useEffect

### 4.7 Replace app client subscription

**File:** `packages/frontend/src/lib/mock-app.ts`

Before:
```typescript
export function useMockAppSnapshot(): FoundryAppSnapshot {
  return useSyncExternalStore(appClient.subscribe.bind(appClient), appClient.getSnapshot.bind(appClient));
}
```

After:
```typescript
export function useAppSnapshot(): FoundryAppSnapshot {
  const app = useSubscription(subscriptionManager, "app", {});
  return app.data ?? DEFAULT_APP_SNAPSHOT;
}
```

### 4.8 Mutations

Mutations (`createTask`, `renameTask`, `sendMessage`, etc.) no longer need manual `refetch()` or `refresh()` calls after completion. The backend mutation triggers a broadcast, which the subscription manager receives and applies automatically.

Before:
```typescript
const createSession = useMutation({
  mutationFn: async () => startSessionFromTask(),
  onSuccess: async (session) => {
    setActiveSessionId(session.id);
    await Promise.all([sessionsQuery.refetch(), eventsQuery.refetch()]);
  },
});
```

After:
```typescript
const createSession = useMutation({
  mutationFn: async () => startSessionFromTask(),
  onSuccess: (session) => {
    setActiveSessionId(session.id);
    // No refetch needed — server broadcast updates the task and session topics automatically
  },
});
```

---

## 5. Files to Delete / Remove

| File/Code | Reason |
|---|---|
| `packages/client/src/remote/workbench-client.ts` | Replaced by subscription manager `organization` + `task` topics |
| `packages/client/src/remote/app-client.ts` | Replaced by subscription manager `app` topic |
| `packages/client/src/workbench-client.ts` | Factory for above — no longer needed |
| `packages/client/src/app-client.ts` | Factory for above — no longer needed |
| `packages/frontend/src/lib/workbench.ts` | Workbench client singleton — replaced by subscription manager |
| `subscribeWorkbench` in `backend-client.ts` | Replaced by `connectWorkspace` + subscription manager |
| `subscribeSandboxProcesses` in `backend-client.ts` | Replaced by `connectSandbox` + subscription manager |
| `subscribeApp` in `backend-client.ts` | Replaced by `connectWorkspace("app")` + subscription manager |
| `buildWorkbenchSnapshot` in `organization/actions.ts` | Replaced by `getWorkspaceSummary` (local reads). Keep as `reconcileWorkbenchState` for recovery only. |
| `notifyWorkbenchUpdated` in `organization/actions.ts` | Replaced by `applyTaskSummaryUpdate` + `c.broadcast` with payload |
| `notifyWorkbenchUpdated` in `task/workbench.ts` | Replaced by `broadcastTaskUpdate` helper |
| `TaskWorkbenchSnapshot` in `shared/workbench.ts` | Replaced by `OrganizationSummarySnapshot` + `WorkbenchTaskDetail` |
| `WorkbenchTask` in `shared/workbench.ts` | Split into `WorkbenchTaskSummary` + `WorkbenchTaskDetail` |
| `getWorkbench` action on organization actor | Replaced by `getWorkspaceSummary` |
| `TaskWorkbenchClient` interface | Replaced by `SubscriptionManager` + `useSubscription` hook |
| All `useQuery` with `refetchInterval` in `organization-dashboard.tsx` | Replaced by `useSubscription` |
| All `useQuery` with `refetchInterval` in `terminal-pane.tsx` | Replaced by `useSubscription` |
| Mock workbench client (`packages/client/src/mock/workbench-client.ts`) | Replaced by `MockSubscriptionManager` |

---

## 6. Migration Order

Implement in this order to keep the system working at each step:

### Phase 1: Types and backend materialization
1. Add new types to `packages/shared` (`WorkbenchTaskSummary`, `WorkbenchTaskDetail`, `WorkbenchSessionSummary`, `WorkbenchSessionDetail`, `OrganizationSummarySnapshot`, event types).
2. Add `taskSummaries` table to organization actor schema.
3. Add `applyTaskSummaryUpdate`, `removeTaskSummary`, `getWorkspaceSummary` actions to organization actor.
4. Add `getTaskDetail`, `getSessionDetail` actions to task actor.
5. Replace all `notifyWorkbenchUpdated` call sites with `broadcastTaskUpdate` that pushes summary + broadcasts detail with payload.
6. Change app actor broadcast to include snapshot payload.
7. Change sandbox actor broadcast to include process list payload.
8. Add one-time reconciliation action to populate `taskSummaries` table from existing task actors (run on startup or on-demand).

### Phase 2: Client subscription manager
9. Add `SubscriptionManager` interface, `RemoteSubscriptionManager`, `MockSubscriptionManager` to `packages/client`.
10. Add topic definitions registry.
11. Add `useSubscription` hook.
12. Add `connectWorkspace`, `connectTask`, `connectSandbox`, `getWorkspaceSummary`, `getTaskDetail`, `getSessionDetail` to `BackendClient`.

### Phase 3: Frontend migration
13. Replace `useMockAppSnapshot` with `useSubscription("app", ...)`.
14. Replace `MockLayout` workbench subscription with `useSubscription("organization", ...)`.
15. Replace task detail view with `useSubscription("task", ...)` + `useSubscription("session", ...)`.
16. Replace `organization-dashboard.tsx` polling queries with `useSubscription`.
17. Replace `terminal-pane.tsx` polling queries with `useSubscription`.
18. Remove manual `refetch()` calls from mutations.

### Phase 4: Cleanup
19. Delete old files (workbench-client, app-client, old subscribe functions, old types).
20. Remove `buildWorkbenchSnapshot` from hot path (keep as `reconcileWorkbenchState`).
21. Verify `pnpm -w typecheck`, `pnpm -w build`, `pnpm -w test` pass.

---

## 7. Architecture Comments

Add doc comments at these locations:

- **Topic definitions** — explain the materialized state pattern, why events carry full entity state instead of patches, and the relationship between topics.
- **`broadcastTaskUpdate` helper** — explain the dual-broadcast pattern (push summary to organization + broadcast detail to direct subscribers).
- **`SubscriptionManager` interface** — explain the grace period, deduplication, and why mock/remote share the same interface.
- **`useSubscription` hook** — explain `useSyncExternalStore` integration, null params for conditional interest, and how params key stabilization works.
- **Organization actor `taskSummaries` table** — explain this is a materialized read projection maintained by task actor pushes, not a source of truth.
- **`applyTaskSummaryUpdate` action** — explain this is the write path for the materialized projection, called by task actors, not by clients.
- **`getWorkspaceSummary` action** — explain this reads from local SQLite only, no fan-out, and why that's the correct pattern.

---

## 8. Testing

- Subscription manager unit tests: subscribe/unsubscribe lifecycle, grace period, deduplication, event application.
- Mock implementation tests: verify same behavior as remote through shared test suite against the `SubscriptionManager` interface.
- Backend integration: verify `applyTaskSummaryUpdate` correctly materializes and broadcasts.
- E2E: verify that a task mutation (e.g. rename) updates the sidebar in realtime without polling.
