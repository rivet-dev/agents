# Repo Sync And Stack Actions Should Run In Background Workflows

Read `00-end-to-end-async-realtime-plan.md` first for the governing migration order, runtime constraints, and realtime client model this brief assumes.

## Problem

Repo stack actions currently run inside a synchronous action and surround the action with forced sync before and after. Branch-backed task creation also forces repo sync inline before it can proceed.

These flows depend on repo/network state and can take minutes. They should not hold an action open.

## Current Code Context

- Organization repo action entry point: `foundry/packages/backend/src/actors/organization/actions.ts`
- Repository repo action implementation: `foundry/packages/backend/src/actors/repository/actions.ts`
- Branch/task index state lives in the repository actor SQLite DB.
- Current forced sync uses the PR and branch polling actors before and after the action.

## Target Contract

- Repo-affecting actions are accepted quickly and run in the background.
- The repository actor owns a durable action record with progress and final result.
- Clients observe status via repository/task state instead of waiting for a single response.

## Proposed Fix

1. Introduce a repository-level workflow/job model for repo actions, for example:
   - `sync_repo`
   - `restack_repo`
   - `restack_subtree`
   - `rebase_branch`
   - `reparent_branch`
   - `register_existing_branch`
2. Persist a job row with:
   - job id
   - action kind
   - target branch fields
   - status
   - message
   - timestamps
3. Change `runRepoStackAction` to:
   - validate cheap local inputs only
   - create a job row
   - enqueue the workflow with `wait: false`
   - return the job id and accepted status immediately
4. Move pre/post sync into the background workflow.
5. For branch-backed task creation:
   - use the cached branch projection if present
   - if branch data is stale or missing, enqueue branch registration/refresh work and surface pending state instead of blocking create

## Files Likely To Change

- `foundry/packages/backend/src/actors/organization/actions.ts`
- `foundry/packages/backend/src/actors/repository/actions.ts`
- `foundry/packages/backend/src/actors/repository/db/schema.ts`
- `foundry/packages/backend/src/actors/repository/db/migrations.ts`
- `foundry/packages/frontend/src/components/organization-dashboard.tsx`
- Any shared types in `foundry/packages/shared/src`

## Client Impact

- Repo action buttons should show queued/running/completed/error job state.
- Task creation from an existing branch may produce a task in a pending branch-attach state rather than blocking on repo sync.

## Acceptance Criteria

- No repo stack action waits for full git-spice execution inside the request.
- No action forces branch sync or PR sync inline.
- Action result state survives retries and backend restarts because the workflow status is persisted.

## Implementation Notes

- Keep validation cheap in the request path; expensive repo inspection belongs in the workflow.
- If job rows are added, decide whether they are repository-owned only or also mirrored into history events for UI consumption.
- Fresh-agent check: branch-backed task creation and explicit repo stack actions should use the same background job/status vocabulary where possible.
