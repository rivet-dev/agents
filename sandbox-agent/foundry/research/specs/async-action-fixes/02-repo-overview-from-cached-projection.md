# Repo Overview Should Read Cached State Only

Read `00-end-to-end-async-realtime-plan.md` first for the governing migration order, runtime constraints, and realtime client model this brief assumes.

## Problem

Repo overview currently forces PR sync and branch sync inline before returning data. That turns a read path into:

- repo fetch
- branch enumeration
- diff/conflict calculations
- GitHub PR listing

The frontend polls repo overview repeatedly, so this design multiplies slow work and ties normal browsing to sync latency.

## Current Code Context

- Organization overview entry point: `foundry/packages/backend/src/actors/organization/actions.ts`
- Repository overview implementation: `foundry/packages/backend/src/actors/repository/actions.ts`
- Branch sync poller: `foundry/packages/backend/src/actors/repository-branch-sync/index.ts`
- PR sync poller: `foundry/packages/backend/src/actors/repository-pr-sync/index.ts`
- Repo overview client polling: `foundry/packages/frontend/src/components/organization-dashboard.tsx`

## Target Contract

- `getRepoOverview` returns the latest cached repo projection immediately.
- Sync happens on a background cadence or on an explicit async refresh trigger.
- Overview responses include freshness metadata so the client can show "refreshing" or "stale" state without blocking.

## Proposed Fix

1. Remove inline `forceProjectSync()` from `getRepoOverview`.
2. Add freshness fields to the repository projection, for example:
   - `branchSyncAt`
   - `prSyncAt`
   - `branchSyncStatus`
   - `prSyncStatus`
3. Let the existing polling actors own cache refresh.
4. If the client needs a manual refresh, add a non-blocking command such as `repository.requestOverviewRefresh` that:
   - enqueues refresh work
   - updates sync status to `queued` or `running`
   - returns immediately
5. Keep `getRepoOverview` as a pure read over repository SQLite state.

## Files Likely To Change

- `foundry/packages/backend/src/actors/organization/actions.ts`
- `foundry/packages/backend/src/actors/repository/actions.ts`
- `foundry/packages/backend/src/actors/repository/db/schema.ts`
- `foundry/packages/backend/src/actors/repository/db/migrations.ts`
- `foundry/packages/backend/src/actors/repository-branch-sync/index.ts`
- `foundry/packages/backend/src/actors/repository-pr-sync/index.ts`
- `foundry/packages/frontend/src/components/organization-dashboard.tsx`

## Client Impact

- The repo overview screen should render cached rows immediately.
- If the user requests a refresh, the UI should show a background sync indicator instead of waiting for the GET call to complete.
- Polling frequency can be reduced because reads are now cheap and sync is event-driven.

## Acceptance Criteria

- `getRepoOverview` does not call `force()` on polling actors.
- Opening the repo overview page does not trigger network/git work inline.
- Slow branch sync or PR sync no longer blocks the page request.

## Implementation Notes

- Favor adding explicit freshness metadata over implicit timing assumptions in the frontend.
- The overview query should remain safe to call frequently even if the UI still polls during the transition.
- Fresh-agent check: confirm no other read paths call `forceProjectSync()` inline after this change.
