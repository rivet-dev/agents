# Foundry Agent Handoff

## Baseline

- Repo: `rivet-dev/sandbox-agent`
- Branch: `columbus-v2`
- Last pushed commit: `3174fe73` (`feat(foundry): checkpoint actor and workspace refactor`)
- Progress/spec tracker: [FOUNDRY-CHANGES.md](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/FOUNDRY-CHANGES.md)

## What is already landed

These spec slices are already implemented and pushed:

- Item `1`: backend actor rename `auth-user` -> `user`
- Item `2`: Better Auth mapping comments
- Item `5`: task raw SQL cleanup into migrations
- Item `6`: `history` -> `audit-log`
- Item `7`: default model moved to user-scoped app state
- Item `20`: admin action prefixing
- Item `23`: dead `getTaskEnriched` / `enrichTaskRecord` removal
- Item `25`: `Workbench` -> `Workspace` rename across backend/shared/client/frontend
- Item `26`: branch rename deleted
- Organization realtime was already collapsed to full-snapshot `organizationUpdated`
- Task realtime was already aligned to `taskUpdated`

## Known blocker

Spec item `3` is only partially done. The singleton constraint for the Better Auth `user` table is still blocked.

- File: [foundry/packages/backend/src/actors/user/db/schema.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/user/db/schema.ts)
- Reason: Better Auth still depends on external string `user.id`, so a literal singleton `CHECK (id = 1)` on that table is not a safe mechanical change.

## Important current state

There are uncommitted edits on top of the pushed checkpoint. Another agent should start from the current worktree, not just `origin/columbus-v2`.

Current dirty files:

- [foundry/packages/backend/src/actors/github-data/index.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/github-data/index.ts)
- [foundry/packages/backend/src/actors/organization/actions.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/organization/actions.ts)
- [foundry/packages/backend/src/actors/repository/actions.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/repository/actions.ts)
- [foundry/packages/backend/src/actors/task/workspace.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/task/workspace.ts)
- [foundry/packages/client/src/mock/backend-client.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/client/src/mock/backend-client.ts)

These files are the current hot path for the unfinished structural work.

## What is partially in place but not finished

### User-owned task UI state

The user actor already has the schema and CRUD surface for per-user task/session UI state:

- [foundry/packages/backend/src/actors/user/db/schema.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/user/db/schema.ts)
  `user_task_state`
- [foundry/packages/backend/src/actors/user/index.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/user/index.ts)
  `getTaskState`, `upsertTaskState`, `deleteTaskState`

But the task actor and UI are still reading/writing the old task-global fields:

- [foundry/packages/backend/src/actors/task/db/schema.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/task/db/schema.ts)
  still contains `task_runtime.active_session_id` and session `unread` / `draft_*`
- [foundry/packages/backend/src/actors/task/workspace.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/task/workspace.ts)
  still derives unread/draft/active-session from task-local rows
- [foundry/packages/frontend/src/components/mock-layout.tsx](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/frontend/src/components/mock-layout.tsx)
  still treats `activeSessionId` as frontend-local and uses task-level unread/draft state

So items `21`, `22`, `24`, and part of `19` are only half-done.

### Coordinator ownership

The current architecture still violates the intended coordinator pattern:

- Organization still owns `taskLookup` and `taskSummaries`
  - [foundry/packages/backend/src/actors/organization/db/schema.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/organization/db/schema.ts)
- Organization still resolves `taskId -> repoId`
  - [foundry/packages/backend/src/actors/organization/actions.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/organization/actions.ts)
- Task still pushes summary updates to organization instead of repository
  - [foundry/packages/backend/src/actors/task/workspace.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/task/workspace.ts)
- Repository still does not own a `tasks` projection table yet
  - [foundry/packages/backend/src/actors/repository/db/schema.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/repository/db/schema.ts)

So items `9`, `13`, and `15` are still open.

### Queue-only mutations

Task actor workspace commands already go through queue sends. Other actors still do not fully follow the queue-only mutation rule:

- [foundry/packages/backend/src/actors/user/index.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/user/index.ts)
- [foundry/packages/backend/src/actors/github-data/index.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/github-data/index.ts)
- [foundry/packages/backend/src/actors/organization/actions.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/organization/actions.ts)
- [foundry/packages/backend/src/actors/organization/app-shell.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/organization/app-shell.ts)

So items `4`, `10`, and `11` are still open.

### Dynamic model/agent data

The frontend/client still hardcode model groups:

- [foundry/packages/frontend/src/components/mock-layout/view-model.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/frontend/src/components/mock-layout/view-model.ts)
- [foundry/packages/client/src/workspace-model.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/client/src/workspace-model.ts)
- [foundry/packages/shared/src/workspace.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/shared/src/workspace.ts)
  `WorkspaceModelId` is still a hardcoded union

The repo already has the API source of truth available through the TypeScript SDK:

- [sdks/typescript/src/client.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/sdks/typescript/src/client.ts)
  `SandboxAgent.listAgents({ config: true })`
- [server/packages/sandbox-agent/src/router.rs](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/server/packages/sandbox-agent/src/router.rs)
  `/v1/agents`
- [server/packages/sandbox-agent/src/router/support.rs](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/server/packages/sandbox-agent/src/router/support.rs)
  `fallback_config_options`

So item `8` is still open.

### GitHub sync chunking/progress

GitHub data sync is still a delete-and-replace flow:

- [foundry/packages/backend/src/actors/github-data/index.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/github-data/index.ts)
  `replaceRepositories`, `replaceBranches`, `replaceMembers`, `replacePullRequests`, and full-sync flow
- [foundry/packages/backend/src/actors/github-data/db/schema.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/github-data/db/schema.ts)
  no generation/progress columns yet
- [foundry/packages/shared/src/app-shell.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/shared/src/app-shell.ts)
  no structured sync progress field yet

So item `16` is still open.

## Recommended next order

If another agent picks this up, this is the safest order:

1. Finish items `21`, `22`, `24`, `19` together.
   Reason: user-owned task UI state is already half-wired, and task schema cleanup depends on the same files.

2. Finish items `9`, `13`, `15` together.
   Reason: coordinator ownership, repo-owned task projections, and PR/task unification are the same refactor seam.

3. Finish item `16`.
   Reason: GitHub sync chunking is mostly isolated to `github-data` plus app-shell/shared snapshot wiring.

4. Finish item `8`.
   Reason: dynamic model/agent data is largely independent once user default model is already user-scoped.

5. Finish items `4`, `10`, `11`, `12`, `18`, final event audit.

6. Do item `17` last.

## Concrete file hotspots for the next agent

Backend:

- [foundry/packages/backend/src/actors/task/workspace.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/task/workspace.ts)
- [foundry/packages/backend/src/actors/task/db/schema.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/task/db/schema.ts)
- [foundry/packages/backend/src/actors/task/workflow/common.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/task/workflow/common.ts)
- [foundry/packages/backend/src/actors/task/workflow/commands.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/task/workflow/commands.ts)
- [foundry/packages/backend/src/actors/task/workflow/init.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/task/workflow/init.ts)
- [foundry/packages/backend/src/actors/repository/actions.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/repository/actions.ts)
- [foundry/packages/backend/src/actors/repository/db/schema.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/repository/db/schema.ts)
- [foundry/packages/backend/src/actors/organization/actions.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/organization/actions.ts)
- [foundry/packages/backend/src/actors/github-data/index.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/github-data/index.ts)
- [foundry/packages/backend/src/actors/user/index.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/backend/src/actors/user/index.ts)

Shared/client/frontend:

- [foundry/packages/shared/src/workspace.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/shared/src/workspace.ts)
- [foundry/packages/shared/src/contracts.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/shared/src/contracts.ts)
- [foundry/packages/shared/src/app-shell.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/shared/src/app-shell.ts)
- [foundry/packages/client/src/backend-client.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/client/src/backend-client.ts)
- [foundry/packages/client/src/workspace-model.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/client/src/workspace-model.ts)
- [foundry/packages/frontend/src/components/mock-layout.tsx](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/frontend/src/components/mock-layout.tsx)
- [foundry/packages/frontend/src/components/mock-layout/view-model.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/frontend/src/components/mock-layout/model-picker.tsx)
- [foundry/packages/frontend/src/features/tasks/status.ts](/Users/nathan/conductor/workspaces/sandbox-agent/columbus-v1/foundry/packages/frontend/src/features/tasks/status.ts)

## Notes that matter

- The pushed checkpoint is useful, but it is not the full current state. There are uncommitted edits in the hot-path backend files listed above.
- The current tree already contains a partially added `user_task_state` path. Do not duplicate that work; finish the migration by removing the old task-owned fields and rewiring readers/writers.
- The current task actor still reads mutable fields from `c.state` such as `repoRemote`, `branchName`, `title`, `task`, `sandboxProviderId`, and `agentType`. That is part of item `19`.
- The current frontend still synthesizes PR-only rows into fake tasks. That should go away as part of repo-owned task projection / PR unification.
