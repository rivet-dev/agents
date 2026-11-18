# Workbench Session Creation Must Not Trigger Inline Provisioning

Read `00-end-to-end-async-realtime-plan.md` first for the governing migration order, runtime constraints, and realtime client model this brief assumes.

## Problem

Creating a workbench tab currently provisions the whole task if no active sandbox exists. A user action that looks like "open tab" can therefore block on sandbox creation and agent setup.

## Current Code Context

- Organization workbench action entry point: `foundry/packages/backend/src/actors/organization/actions.ts`
- Task workbench behavior: `foundry/packages/backend/src/actors/task/workbench.ts`
- Task provision action: `foundry/packages/backend/src/actors/task/index.ts`
- Sandbox session creation path: `foundry/packages/backend/src/actors/sandbox-instance/index.ts`
- Remote workbench refresh behavior: `foundry/packages/client/src/remote/workbench-client.ts`

## Target Contract

- Creating a tab returns quickly.
- If the task is not provisioned yet, the tab enters a pending state and becomes usable once provisioning completes.
- Provisioning remains a task workflow concern, not a workbench request concern.

## Proposed Fix

1. Split tab creation from sandbox session creation.
2. On `createWorkbenchSession`:
   - create session metadata or a placeholder tab row immediately
   - if the task is not provisioned, enqueue the required background work and return the placeholder id
   - if the task is provisioned, enqueue background session creation if that step can also be slow
3. Add a tab/session state model such as:
   - `pending_provision`
   - `pending_session_create`
   - `ready`
   - `error`
4. When provisioning or session creation finishes, update the placeholder row with the real sandbox/session identifiers and notify the workbench.

## Files Likely To Change

- `foundry/packages/backend/src/actors/organization/actions.ts`
- `foundry/packages/backend/src/actors/task/workbench.ts`
- `foundry/packages/backend/src/actors/task/index.ts`
- `foundry/packages/backend/src/actors/task/db/schema.ts`
- `foundry/packages/backend/src/actors/task/db/migrations.ts`
- `foundry/packages/client/src/remote/workbench-client.ts`
- `foundry/packages/frontend/src/components/mock-layout.tsx`

## Client Impact

- The workbench can show a disabled composer or "Preparing environment" state for a pending tab.
- The UI no longer needs to block on the mutation itself.

## Acceptance Criteria

- `createWorkbenchSession` never calls task provisioning inline.
- Opening a tab on an unprovisioned task returns promptly with a placeholder tab id.
- The tab transitions to ready through background updates only.

## Implementation Notes

- The main design choice here is placeholder identity. Decide early whether placeholder tab ids are durable synthetic ids or whether a pending row can be updated in place once a real session exists.
- Avoid coupling this design to Daytona specifically; it should work for local and remote providers.
- Fresh-agent check: confirm composer, unread state, and tab close behavior all handle pending/error tabs cleanly.
