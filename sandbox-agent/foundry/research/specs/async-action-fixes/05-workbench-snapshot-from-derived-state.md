# Workbench Snapshots Should Read Derived State, Not Recompute It

Read `00-end-to-end-async-realtime-plan.md` first for the governing migration order, runtime constraints, and realtime client model this brief assumes.

## Problem

Workbench snapshot reads currently execute expensive sandbox commands and transcript reads inline:

- `git status`
- `git diff --numstat`
- one diff per changed file
- file tree enumeration
- transcript reads for each session
- session status lookups

The remote workbench client refreshes after each action and on update events, so this synchronous snapshot work is amplified.

## Current Code Context

- Organization workbench snapshot builder: `foundry/packages/backend/src/actors/organization/actions.ts`
- Task workbench snapshot builder: `foundry/packages/backend/src/actors/task/workbench.ts`
- Sandbox session event persistence: `foundry/packages/backend/src/actors/sandbox-instance/persist.ts`
- Remote workbench client refresh loop: `foundry/packages/client/src/remote/workbench-client.ts`
- Mock layout consumer: `foundry/packages/frontend/src/components/mock-layout.tsx`

## Target Contract

- `getWorkbench` reads a cached projection only.
- Expensive sandbox- or session-derived data is updated asynchronously and stored in actor-owned tables.
- Detail-heavy payloads are fetched separately when the user actually opens that view.

## Proposed Fix

1. Split the current monolithic workbench snapshot into:
   - lightweight task/workbench summary
   - session transcript endpoint
   - file diff endpoint
   - file tree endpoint
2. Cache derived git state in SQLite, updated by background jobs or targeted invalidation after mutating actions.
3. Cache transcript/session metadata incrementally from sandbox events instead of reading full transcripts on every snapshot.
4. Keep `getWorkbench` limited to summary fields needed for the main screen.
5. Update the remote workbench client to rely more on push updates and less on immediate full refresh after every mutation.

## Files Likely To Change

- `foundry/packages/backend/src/actors/organization/actions.ts`
- `foundry/packages/backend/src/actors/task/workbench.ts`
- `foundry/packages/backend/src/actors/task/db/schema.ts`
- `foundry/packages/backend/src/actors/task/db/migrations.ts`
- `foundry/packages/client/src/remote/workbench-client.ts`
- `foundry/packages/shared/src`
- `foundry/packages/frontend/src/components/mock-layout.tsx`

## Client Impact

- Main workbench loads faster and remains responsive with many tasks/files/sessions.
- Heavy panes can show their own loading states when opened.

## Acceptance Criteria

- `getWorkbench` does not run per-file diff commands inline.
- `getWorkbench` does not read full transcripts for every tab inline.
- Full workbench refresh cost stays roughly proportional to task count, not task count times changed files times sessions.

## Implementation Notes

- This is the broadest UI-facing refactor in the set.
- Prefer introducing lighter cached summary fields first, then moving heavy detail into separate reads.
- Fresh-agent check: define the final snapshot contract before changing frontend consumers, otherwise the refactor will sprawl.
