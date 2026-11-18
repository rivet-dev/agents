# End-To-End Async + Realtime Plan

## Purpose

This is the umbrella plan for the Foundry issues we traced across app shell, workbench, and actor runtime behavior:

- long-running work still sits inline in request/action paths
- monolithic snapshot reads fan out across too many actors
- the client uses polling and full refreshes where it should use realtime subscriptions
- websocket subscriptions reconnect too aggressively
- actor shutdown can race in-flight actions and clear `c.db` underneath them

The goal is not just to make individual endpoints faster. The goal is to move Foundry to a model where:

- request paths only validate, create minimal state, and enqueue background work
- list views read actor-owned projections instead of recomputing deep state
- detail views connect directly to the actor that owns the visible state
- polling is replaced by actor events and bounded bootstrap fetches
- actor shutdown drains active work before cleaning up resources

## Problem Summary

### App shell

- `getAppSnapshot` still rebuilds app shell state by reading the app session row and fanning out to every eligible organization actor.
- `RemoteFoundryAppStore` still polls every `500ms` while any org is `syncing`.
- Org sync/import is now off the select path, but the steady-state read path is still snapshot-based instead of subscription-based.

### Workbench

- `getWorkbench` still represents a monolithic organization read that aggregates repo, repository, and task state.
- The remote workbench store still responds to every event by pulling a full fresh snapshot.
- Some task/workbench detail is still too expensive to compute inline and too broad to refresh after every mutation.

### Realtime transport

- `subscribeWorkbench` and related connection helpers keep one connection per shared key, but the client contract still treats the socket as an invalidation channel for a later snapshot pull.
- Reconnect/error handling is weak, so connection churn amplifies backend load instead of settling into long-lived subscriptions.

### Runtime

- RivetKit currently lets shutdown proceed far enough to clean up actor resources while actions can still be in flight or still be routed to the actor.
- That creates the `Database not enabled` / missing `c.db` failure mode under stop/replay pressure.

## Target Architecture

### Request-path rule

Every request/action should do only one of these:

1. return actor-owned cached state
2. persist a cheap mutation
3. enqueue or signal background work

Requests should not block on provider calls, repo sync, sandbox provisioning, transcript enumeration, or deep cross-actor fan-out unless the UI cannot render at all without the result.

### View-model rule

- App shell view connects to app/session state and only the org actors visible on screen.
- Organization/task-list view connects to a organization-owned summary projection.
- Task detail view connects directly to the selected task actor.
- Sandbox/session detail connects only when the user opens that detail.

Do not replace one monolith with one connection per row. List screens should still come from actor-owned projections.

### Runtime rule

Stopping actors must stop accepting new work and must not clear actor resources until active actions and requests have drained or been cancelled.

## Workstreams

### 1. Runtime hardening first

This is the only workstream that is not Foundry-only. It should start immediately because it is the only direct fix for the `c.db` shutdown race.

#### Changes

1. Add active action/request accounting in RivetKit actor instances.
2. Mark actors as draining before cleanup starts.
3. Reject or reroute new requests/actions once draining begins.
4. Wait for active actions to finish or abort before `#cleanupDatabase()` runs.
5. Delay clearing `#db` until no active actions remain.
6. Add actor stop logs with:
   - actor id
   - active action count
   - active request count
   - drain start/end timestamps
   - cleanup start/end timestamps

#### Acceptance criteria

- No action can successfully enter user code after actor draining begins.
- `Database not enabled` cannot be produced by an in-flight action after stop has begun.
- Stop logs make it obvious whether shutdown delay is run-handler time, active-action drain time, background promise time, or routing delay.

### 2. App shell moves from snapshot polling to subscriptions

The app shell should stop using `/app/snapshot` as the steady-state read model.

#### Changes

1. Introduce a small app-shell projection owned by the app organization actor:
   - auth status
   - current user summary
   - active org id
   - visible org ids
   - per-org lightweight status summary
2. Add app actor events, for example:
   - `appSessionUpdated`
   - `activeOrganizationChanged`
   - `organizationSyncStatusChanged`
3. Expose connection helpers from the backend client for:
   - app actor subscription
   - organization actor subscription by id
4. Update `RemoteFoundryAppStore` so it:
   - does one bootstrap fetch on first subscribe
   - connects to the app actor for ongoing updates
   - connects only to the org actors needed for the current view
   - disposes org subscriptions when they are no longer visible
5. Remove `scheduleSyncPollingIfNeeded()` and the `500ms` refresh loop.

#### Likely files

- `foundry/packages/backend/src/actors/organization/app-shell.ts`
- `foundry/packages/client/src/backend-client.ts`
- `foundry/packages/client/src/remote/app-client.ts`
- `foundry/packages/shared/src/app-shell.ts`
- app shell frontend consumers

#### Acceptance criteria

- No app shell polling loop remains.
- Selecting an org returns quickly and the UI updates from actor events.
- App shell refresh cost is bounded by visible state, not every eligible organization on every poll.

### 3. Organization summary becomes a projection, not a full snapshot

The task list should read a organization-owned summary projection instead of calling into every task actor on each refresh.

#### Changes

1. Define a durable organization summary model with only list-screen fields:
   - repo summary
   - repository summary
   - task summary
   - selected/open task ids
   - unread/session status summary
   - coarse git/PR state summary
2. Update organization actor workflows so task/repository changes incrementally update this projection.
3. Change `getWorkbench` to return the projection only.
4. Change `workbenchUpdated` from "invalidate and refetch everything" to "here is the updated projection version or changed entity ids".
5. Remove task-actor fan-out from the default list read path.

#### Likely files

- `foundry/packages/backend/src/actors/organization/actions.ts`
- `foundry/packages/backend/src/actors/repository/actions.ts`
- `foundry/packages/backend/src/actors/task/index.ts`
- `foundry/packages/backend/src/actors/task/workbench.ts`
- task/organization DB schema and migrations
- `foundry/packages/client/src/remote/workbench-client.ts`

#### Acceptance criteria

- Workbench list refresh does not call every task actor.
- A websocket event does not force a full cross-actor rebuild.
- Initial task-list load time scales roughly with organization summary size, not repo count times task count times detail reads.

### 4. Task detail moves to direct actor reads and events

Heavy task detail should move out of the organization summary and into the selected task actor.

#### Changes

1. Split task detail into focused reads/subscriptions:
   - task header/meta
   - tabs/session summary
   - transcript stream
   - diff/file tree
   - sandbox process state
2. Open a task actor connection only for the selected task.
3. Open sandbox/session subscriptions only for the active tab/pane.
4. Dispose those subscriptions when the user changes selection.
5. Keep expensive derived state cached in actor-owned tables and update it from background jobs or event ingestion.

#### Acceptance criteria

- Opening the task list does not open connections to every task actor.
- Opening a task shows staged loading for heavy panes instead of blocking the whole workbench snapshot.
- Transcript, diff, and file-tree reads are not recomputed for unrelated tasks.

### 5. Finish moving long-running mutations to background workflows

This extends and completes the existing async-action briefs in this folder.

#### Existing briefs to implement under this workstream

1. `01-task-creation-bootstrap-only.md`
2. `02-repo-overview-from-cached-projection.md`
3. `03-repo-actions-via-background-workflow.md`
4. `04-workbench-session-creation-without-inline-provisioning.md`
5. `05-workbench-snapshot-from-derived-state.md`
6. `06-daytona-provisioning-staged-background-flow.md`

#### Additional rule

Every workflow-backed mutation should leave behind durable status rows or events that realtime clients can observe without polling.

### 6. Subscription lifecycle and reconnect behavior need one shared model

The current client-side connection pattern is too ad hoc. It needs a single lifecycle policy so sockets are long-lived and bounded.

#### Changes

1. Create one shared subscription manager in the client for:
   - reference counting
   - connection reuse
   - reconnect backoff
   - connection state events
   - clean disposal
2. Make invalidation optional. Prefer payload-bearing events or projection version updates.
3. Add structured logs/metrics in the client for:
   - connection created/disposed
   - reconnect attempts
   - subscription count per actor key
   - refresh triggered by event vs bootstrap vs mutation
4. Stop calling full `refresh()` after every mutation when the mutation result or follow-up event already contains enough state to update locally.

#### Acceptance criteria

- Idle screens maintain stable websocket counts.
- Transient socket failures do not create refresh storms.
- The client can explain why any given refresh happened.

### 7. Clean up HTTP surface after realtime migration

Do not delete bootstrap endpoints first. Shrink them after the subscription model is working.

#### Changes

1. Keep one-shot bootstrap/read endpoints only where they still add value:
   - initial app load
   - initial workbench load
   - deep-link fallback
2. Remove or de-emphasize monolithic snapshot endpoints for steady-state use.
3. Keep HTTP for control-plane and external integrations.

#### Acceptance criteria

- Main interactive screens do not depend on polling.
- Snapshot endpoints are bootstrap/fallback paths, not the primary UI contract.

## Suggested Implementation Order

1. Runtime hardening in RivetKit
2. `01-task-creation-bootstrap-only.md`
3. `03-repo-actions-via-background-workflow.md`
4. `06-daytona-provisioning-staged-background-flow.md`
5. App shell realtime subscription model
6. `02-repo-overview-from-cached-projection.md`
7. Organization summary projection
8. `04-workbench-session-creation-without-inline-provisioning.md`
9. `05-workbench-snapshot-from-derived-state.md`
10. Task-detail direct actor reads/subscriptions
11. Client subscription lifecycle cleanup
12. `07-auth-identity-simplification.md`

## Why This Order

- Runtime hardening removes the most dangerous correctness bug before more UI load shifts onto actor connections.
- The first async workflow items reduce the biggest user-visible stalls quickly.
- App shell realtime is smaller and lower-risk than the workbench migration, and it removes the current polling loop.
- Organization summary and task-detail split should happen after the async workflow moves so the projection model does not encode old synchronous assumptions.
- Auth simplification is valuable but not required to remove the current refresh/polling/runtime problems.

## Observability Requirements

Before or alongside implementation, add metrics/logs for:

- app snapshot bootstrap duration
- workbench bootstrap duration
- actor connection count by actor type and view
- reconnect count by actor key
- projection rebuild/update duration
- workflow queue latency
- actor drain duration and active-action counts during stop

Each log line should include a request id or actor/event correlation id where possible.

## Rollout Strategy

1. Ship runtime hardening and observability first.
2. Ship app-shell realtime behind a client flag while keeping snapshot bootstrap.
3. Ship organization summary projection behind a separate flag.
4. Migrate one heavy detail pane at a time off the monolithic workbench payload.
5. Remove polling once the matching event path is proven stable.
6. Only then remove or demote the old snapshot-heavy steady-state flows.

## Done Means

This initiative is done when all of the following are true:

- no user-visible screen depends on `500ms` polling
- no list view recomputes deep task/session/diff state inline on every refresh
- long-running repo/provider/sandbox work always runs in durable background workflows
- the client connects only to actors relevant to the current view and disposes them when the view changes
- websocket counts stay stable on idle screens
- actor shutdown cannot invalidate `c.db` underneath active actions
