# Async Action Fixes Handoff

## Purpose

This folder contains implementation briefs for removing long-running synchronous waits from Foundry request and action paths.

Start with `00-end-to-end-async-realtime-plan.md`. It is the umbrella plan for the broader migration away from monolithic snapshots and polling, and it adds the missing runtime hardening and subscription-lifecycle work that the numbered implementation briefs did not previously cover.

The governing policy now lives in `foundry/CLAUDE.md`:

- always await `send(...)`
- default to `wait: false`
- only use `wait: true` for short, bounded mutations
- do not force repo/provider sync in read paths
- only block until the minimum client-needed resource exists

## Shared Context

- Backend actor entry points live under `foundry/packages/backend/src/actors`.
- Provider-backed long-running work lives under `foundry/packages/backend/src/providers`.
- The main UI consumers are:
  - `foundry/packages/frontend/src/components/organization-dashboard.tsx`
  - `foundry/packages/frontend/src/components/mock-layout.tsx`
  - `foundry/packages/client/src/remote/workbench-client.ts`
- Existing non-blocking examples already exist in app-shell GitHub auth/import flows. Use those as the reference pattern for request returns plus background completion.

## Suggested Implementation Order

1. `00-end-to-end-async-realtime-plan.md`
2. `01-task-creation-bootstrap-only.md`
3. `03-repo-actions-via-background-workflow.md`
4. `06-daytona-provisioning-staged-background-flow.md`
5. App shell realtime subscription work from `00-end-to-end-async-realtime-plan.md`
6. `02-repo-overview-from-cached-projection.md`
7. Organization summary projection work from `00-end-to-end-async-realtime-plan.md`
8. `04-workbench-session-creation-without-inline-provisioning.md`
9. `05-workbench-snapshot-from-derived-state.md`
10. Task-detail direct subscription work from `00-end-to-end-async-realtime-plan.md`
11. `07-auth-identity-simplification.md`

## Why This Order

- Runtime hardening and the first async workflow items remove the highest-risk correctness and timeout issues first.
- App shell realtime is a smaller migration than the workbench and removes the current polling loop early.
- Organization summary and task-detail subscription work are easier once long-running mutations already report durable background state.
- Auth simplification is important, but it should not block the snapshot/polling/runtime fixes.

## Fresh Agent Checklist

Before implementing any item:

1. Read `foundry/CLAUDE.md` runtime and actor rules.
2. Read the specific item doc in this folder.
3. Confirm the current code paths named in that doc still match the repo.
4. Preserve actor single-writer ownership.
5. Prefer workflow status and push updates over synchronous completion.
