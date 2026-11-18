# Task Creation Should Return After Actor Bootstrap

Read `00-end-to-end-async-realtime-plan.md` first for the governing migration order, runtime constraints, and realtime client model this brief assumes.

## Problem

Task creation currently waits for full provisioning: naming, repo checks, sandbox creation/resume, sandbox-agent install/start, sandbox-instance wiring, and session creation.

That makes a user-facing action depend on queue-backed and provider-backed work that can take minutes. The client only needs the task actor to exist so it can navigate to the task and observe progress.

## Current Code Context

- Organization entry point: `foundry/packages/backend/src/actors/organization/actions.ts`
- Repository task creation path: `foundry/packages/backend/src/actors/repository/actions.ts`
- Task action surface: `foundry/packages/backend/src/actors/task/index.ts`
- Task workflow: `foundry/packages/backend/src/actors/task/workflow/index.ts`
- Task init/provision steps: `foundry/packages/backend/src/actors/task/workflow/init.ts`
- Provider-backed long steps currently happen inside the task provision workflow.

## Target Contract

- `createTask` returns once the task actor exists and initial task metadata is persisted.
- The response includes the task identity the client needs for follow-up reads and subscriptions.
- Provisioning continues in the background through the task workflow.
- Progress and failure are surfaced through task state, history events, and workbench updates.

## Proposed Fix

1. Restore the async split between `initialize` and `provision`.
2. Keep `task.command.initialize` responsible for:
   - creating the task actor
   - bootstrapping DB rows
   - persisting any immediately-known metadata
   - returning the current task record
3. After initialize completes, enqueue `task.command.provision` with `wait: false`.
4. Change `organization.createTask` to:
   - create or resolve the repository
   - create the task actor
   - call `task.initialize(...)`
   - stop awaiting `task.provision(...)`
   - broadcast a workbench/task update
   - return the task record immediately
5. Persist a clear queued/running state for provisioning so the frontend can distinguish:
   - `init_enqueue_provision`
   - `init_ensure_name`
   - `init_create_sandbox`
   - `init_ensure_agent`
   - `init_create_session`
   - `running`
   - `error`

## Files Likely To Change

- `foundry/packages/backend/src/actors/organization/actions.ts`
- `foundry/packages/backend/src/actors/repository/actions.ts`
- `foundry/packages/backend/src/actors/task/index.ts`
- `foundry/packages/backend/src/actors/task/workflow/index.ts`
- `foundry/packages/backend/src/actors/task/workflow/init.ts`
- `foundry/packages/frontend/src/components/organization-dashboard.tsx`
- `foundry/packages/client/src/remote/workbench-client.ts`

## Client Impact

- Task creation UI should navigate immediately to the task page.
- The page should render a provisioning state from task status instead of treating create as an all-or-nothing spinner.
- Any tab/session creation that depends on provisioning should observe task state and wait for readiness asynchronously.

## Acceptance Criteria

- Creating a task never waits on sandbox creation or session creation.
- A timeout in provider setup does not make the original create request fail after several minutes.
- After a backend restart, the task workflow can resume provisioning from durable state without requiring the client to retry create.

## Implementation Notes

- Preserve the existing task actor as the single writer for task runtime state.
- Do not introduce a second creator path for task actors; keep one create/bootstrap path and one background provision path.
- Fresh-agent check: verify that `createWorkbenchTask` and any dashboard create flow still have enough data to navigate immediately after this change.
