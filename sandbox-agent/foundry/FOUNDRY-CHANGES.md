# Foundry Planned Changes

## How to use this document

Work through items checking boxes as you go. Some items have dependencies — do not start an item until its dependencies are checked off. After each item, run `pnpm -w typecheck && pnpm -w build && pnpm -w test` to validate. If an item includes a "CLAUDE.md update" section, apply it in the same change. Commit after each item passes validation.

## Progress Log

- 2026-03-14 10: Initial architecture mapping complete.
  - Confirmed the current hot spots match the spec: `auth-user` is still mutation-by-action, `history` is still a separate actor with an `append` action wrapper, organization still owns `taskLookup`/`taskSummaries`, and the `Workbench*` surface is still shared across backend/client/frontend.
  - Started foundational rename and migration planning for items `1`, `6`, and `25` because they drive most of the later fallout.
- 2026-03-14 11: Audit-log rename slice landed.
  - Renamed the backend actor from `history` to `audit-log`, switched the queue name to `auditLog.command.append`, and removed the `append` action wrapper.
  - Updated task/repository/organization call sites to send directly to the audit-log queue or read through the renamed audit-log handle.
- 2026-03-14 12: Foundational naming and dead-surface cleanup landed.
  - Renamed the backend auth actor surface from `authUser` to `user`, including actor registration, key helpers, handles, and Better Auth service routing.
  - Deleted the dead `getTaskEnriched` / `enrichTaskRecord` fan-out path and changed organization task reads to go straight to the task actor.
  - Renamed admin-only GitHub rebuild/reload actions with the `admin*` prefix across backend, client, and frontend.
  - Collapsed organization realtime to full-snapshot `organizationUpdated` events and aligned task events to `type: "taskUpdated"`.
- 2026-03-14 13: Task schema migration cleanup landed.
  - Removed the task actor's runtime `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` helpers from `task/workbench.ts` and `task/workflow/init.ts`.
  - Updated the checked-in task migration artifacts so the schema-defined task/session/runtime columns are created directly by migrations.
- 2026-03-14 14: Item 3 blocker documented.
  - The spec's requested literal singleton `CHECK (id = 1)` on the Better Auth `user` table conflicts with the existing Better Auth adapter contract, which relies on external string `user.id`.
  - Proceeding safely will require a design adjustment for that table rather than a straight mechanical migration.
- 2026-03-14 15: Better Auth mapping comments landed.
  - Added Better Auth vs custom Foundry table/action comments in the user and organization actor schema/action surfaces so the adapter-constrained paths are explicit.
- 2026-03-15 09: Branch rename surface deleted and stale organization subscription fixed.
  - Removed the remaining branch-rename surface from the client, mock backend, frontend UI, and repository action layer. There are no remaining `renameBranch` / `renameWorkbenchBranch` references in Foundry.
  - Fixed the remote backend client to listen for `organizationUpdated` on the organization connection instead of the dead `workspaceUpdated` event name.
- 2026-03-15 10: Backend workspace rename landed.
  - Renamed the backend task UI/workflow surface from `workbench` to `workspace`, including the task actor file, queue topic family, organization proxy actions, and the task session table name (`task_workspace_sessions`).
  - Backend actor code no longer contains `Workbench` / `workbench` references, so the remaining shared/client/frontend rename can align to a stable backend target.
- 2026-03-15 11: Default model moved to user-scoped app state.
  - Removed `defaultModel` from the organization schema/snapshot and stored it on the user profile instead, exposed through the app snapshot as a user preference.
  - Wired `setAppDefaultModel` through the backend/app clients and changed the model picker to persist the starred/default model instead of resetting local React state on reload.
- 2026-03-15 11: Workspace surface completed across Foundry packages.
  - Renamed the shared/client/frontend surface from `Workbench` to `Workspace`, including `workspace.ts`, workspace client/model files, DTO/type names, backend-client method names, frontend view-model imports, and the affected e2e/test files.
  - Verified that Foundry backend/shared/client/frontend packages no longer contain `Workbench` / `workbench` references.
- 2026-03-15 11: Singleton constraints tightened where safe.
  - Added `CHECK (id = 1)` enforcement for `github_meta`, `repo_meta`, `organization_profile`, and `user_profiles`, and updated the affected code paths/migrations to use row id `1`.
  - The Better Auth `user` table remains blocked by the adapter contract, so item `3` is still open overall.
- 2026-03-14 12: Confirmed blocker for later user-table singleton work.
  - Item `3` conflicts with the current Better Auth adapter contract for the `user` table: the adapter depends on the external string `user.id`, while the spec also asks for a literal singleton `CHECK (id = 1)` on that same table.
  - That cannot be applied mechanically without redesigning the Better Auth adapter contract or introducing a separate surrogate identity column. I have not forced that change yet.
- 2026-03-15 13: Task/repository durable-state cleanup and auth-scoped workspace reads landed.
  - Removed the remaining task/repository actor durable-state duplication: task `createState` now holds only `(organizationId, repoId, taskId)`, repository `createState` now holds only `(organizationId, repoId)`, task initialization seeds SQLite from the initialize queue payload, and task record reads fetch `repoRemote` through repository metadata instead of stale actor state.
  - Removed the repository creation-time `remoteUrl` dependency from actor handles/callers and changed repository metadata to backfill/persist `remoteUrl` from GitHub data when needed.
  - Wired Better Auth session ids through the remote client workspace/task-detail reads and through the task workflow queue handlers so user-scoped workspace state is no longer dropped on the floor by the organization/task proxy path.
- 2026-03-15 14: Coordinator routing boundary tightened.
  - Removed the organization actor's fallback `taskId -> repoId` scan across repositories; task proxy actions now require `repoId` and route directly to the repository/task coordinator path the client already uses.
  - Updated backend architecture notes to reflect the live repo-owned task projection (`tasks`) and the removal of the old organization-owned `taskLookup` / `taskSummaries` indexes.
- 2026-03-15 15: Workspace session-selection and dead task-status cleanup landed.
  - Surfaced viewer-scoped `activeSessionId` through workspace task summary/detail DTOs, threaded it through the backend/client/mock surfaces, and added a dedicated workspace `select_session` mutation so session-tab selection now persists in `user_task_state` instead of living only in frontend local state.
  - Removed dead task `diffStat` and sandbox `statusMessage` fields from the live workspace/task contracts and backend writes, and updated stale frontend/mock/e2e consumers to stop reading them.
- 2026-03-15 16: GitHub sync progress is now live on the organization topic.
  - Added persisted GitHub sync phase/generation/progress fields to the github-data actor meta row and the organization profile projection, and exposed them through `organizationUpdated` snapshots so workspace consumers no longer wait on stale app-topic state during repo imports.
  - Chunked branch and pull-request fetches by repository batches, added generation markers to imported GitHub rows, switched sync refreshes to upsert+sweep instead of delete-then-replace, and updated the workspace shell/dev panel to show live sync phase progress from the organization subscription.
- 2026-03-15 17: Foundry-local model lists now route through shared Sandbox Agent config resources.
  - Removed the remaining duplicated hardcoded model tables from the frontend/client workspace view-model layer and switched backend default-model / agent-inference fallbacks to the shared catalog helpers in `shared/src/models.ts`.
  - Updated mock/default app state to stop seeding deleted `claude-sonnet-4` / `claude-opus-4` ids, and aligned the user-profile default-model migration fallback with the shared catalog default.
- 2026-03-15 17: Shared model catalog moved off the old fixed union.
  - Replaced the shared `WorkspaceModelId` closed union with string ids, introduced a shared model catalog derived from the sandbox-agent agent-config resources, and switched the client/frontend picker label helpers to consume that catalog instead of maintaining separate hardcoded `MODEL_GROUPS` arrays.
  - Updated backend default-model and model→agent fallback logic to use the shared catalog/default id, and relaxed e2e env parsing so new sandbox-agent model ids can flow through without patching Foundry first.
- 2026-03-15 18: Workspace task status collapsed to a single live field.
  - Removed the duplicate `runtimeStatus` field from workspace task/detail DTOs and all current backend/client/frontend consumers, so workspace task `status` is now the only task-state field on that surface.
  - Removed the remaining synthetic `"new"` task status from the live workspace path; mock task creation now starts in the first concrete init state instead of exposing a frontend-only status.
- 2026-03-15 19: GitHub sync now persists branch and PR batches as they are fetched.
  - The branch and pull-request phases now upsert each fetched repository batch immediately and only sweep stale rows after the phase completes, instead of buffering the full dataset in memory until the end of the sync.
  - This aligns chunked progress reporting with chunked persistence and tightens recovery behavior for large repository imports.
- 2026-03-15 20: Repository-owned task projection artifacts are now aligned with runtime.
  - Removed the last stale `task_lookup` Drizzle artifacts from the organization actor so the checked-in schema snapshots match the live repository-owned `tasks` projection.
  - There are no remaining org/repo runtime references to the old org-side task lookup table.
- 2026-03-15 21: Legacy task/runtime fields are fully gone from the live Foundry surface.
  - Confirmed the old task-table/runtime fields from item `21` are removed across backend/shared/client/frontend, and renamed the last leftover `agentTypeForModel()` helper to the neutral `sandboxAgentIdForModel()`.
  - Deleted the final dead frontend diff-stat formatter/test that only referenced already-removed task diff state.
- 2026-03-15 22: Task status tracking is now fully collapsed to the canonical task status enum.
  - With the earlier backend `statusMessage` removal plus this turn's workspace contract cleanup, the workspace/task surface now derives all task status UI from the canonical backend `status` enum.
  - There are no remaining live workspace `runtimeStatus` or synthetic `"new"` task-state branches.
- 2026-03-15 23: Per-user workspace UI state is fully sourced from the user actor overlay.
  - Confirmed the shared task actor no longer stores per-user `activeSessionId`, unread, or draft columns; those values are persisted in `user_task_state` and only projected back into workspace DTOs for the current viewer.
  - The remaining active-session/unread/draft references in client/frontend code are consumer fields of that user-scoped overlay, not shared task-actor storage.
- 2026-03-15 24: Subscription topics are now fully normalized to single-snapshot events.
  - Confirmed the shared realtime contracts now expose one full replacement event per topic (`appUpdated`, `organizationUpdated`, `taskUpdated`, `sessionUpdated`, `processesUpdated`) with matching wire event names and type fields.
  - The client subscription manager already treats organization/task topics as full-snapshot refreshes, so there are no remaining multi-variant organization events or `taskDetailUpdated` name mismatches in live code.
- 2026-03-15 25: Sidebar PR/task split dead branches trimmed further.
  - Removed the remaining dead `pr:`-id sidebar branch and switched the workspace sidebar to the real `pullRequest.isDraft` field instead of stale `pullRequest.status` reads.
  - This does not finish item `15`, but it reduces the remaining synthetic PR/task split surface in the frontend.
- 2026-03-15 26: User-actor mutations now flow through a dedicated workflow queue.
  - Added [user/workflow.ts](/home/nathan/sandbox-agent/foundry/packages/backend/src/actors/user/workflow.ts) plus shared query helpers, wired the user actor up with explicit queue names, and moved auth/profile/session/task-state mutations behind workflow handlers instead of direct action bodies.
- 2026-03-15 27: Organization GitHub/shell/billing mutations now route through workflow queues.
  - Added shared organization queue definitions in `organization/queues.ts`, taught the organization workflow to handle the remaining GitHub projection, org-profile, and billing mutation commands, and switched the app-shell, Better Auth, GitHub-data actor, and org-isolation test to send queue messages instead of calling direct org mutation actions.
  - Deleted the dead organization shell mutation actions that no longer had callers (`applyOrganizationSyncCompleted`, `markOrganizationSyncFailed`, `applyGithubInstallationCreated`, `applyGithubInstallationRemoved`, `applyGithubRepositoryChanges`), which moves items `4`, `10`, and `12` forward even though the broader org action split is still open.
- 2026-03-15 28: Organization action split trimmed more of the monolith and removed dead event types.
  - Moved `starSandboxAgentRepo` into `organization/actions/onboarding.ts` and the admin GitHub reload actions into `organization/actions/github.ts`, so `organization/actions.ts` is carrying fewer unrelated app-shell responsibilities.
  - Deleted the dead backend-only `actors/events.ts` type file after confirming nothing in Foundry still imports those old task/PR event interfaces.
- 2026-03-15 29: Repo overview branch rows now carry a single PR object.
  - Replaced the repo-overview branch DTO's scalar PR fields (`prNumber`, `prState`, `prUrl`, `reviewStatus`, `reviewer`) with `pullRequest: WorkspacePullRequestSummary | null`, and updated repository overview assembly plus the organization dashboard to consume that unified PR shape.
  - This does not finish item `15`, but it removes another synthetic PR-only read surface and makes the repo overview align better with the task summary PR model.
- 2026-03-15 30: Repo overview stopped falling back to raw GitHub PR rows.
  - Changed repository overview assembly to read PR metadata only from the repo-owned task projection instead of rejoining live GitHub PR rows on read, so the dashboard is one step closer to treating PRs as task data rather than a separate UI entity.
- 2026-03-15 31: GitHub organization-shell repair now uses the org workflow queue.
  - Converted `syncOrganizationShellFromGithub` from a direct org action into a workflow-backed mutation command and updated the GitHub org sync path to send `organization.command.github.organization_shell.sync_from_github` instead of calling the action directly.
  - Updated Better Auth adapter writes and task user-overlay writes to send directly to the user workflow queue, which partially lands item `4` and sets up item `11` for the user actor.
- 2026-03-15 27: Workflow layout standardized and queue-only write paths expanded.
  - Split the remaining inline actor workflows into dedicated files for `audit-log`, `repository`, `github-data`, and `organization`, and moved user read actions into `user/actions/*` with Better Auth-prefixed action names.
  - Removed the task actor's public mutation action wrappers entirely, moved organization/repository/github-data/task coordination onto direct queue sends, and made repository metadata reads stop mutating `repo_meta` on cache misses.
- 2026-03-15 28: PR-only admin/UI seams trimmed and PR branches now claim real tasks.
  - Removed the remaining dedicated "reload pull requests" / "reload pull request" admin hooks from the backend/client/frontend surfaces and deleted the sidebar PR-only context action.
  - Repository PR refresh now lazily creates a branch-owned task when a pull request arrives for an unclaimed branch, so PR-only branches stop living purely as a side table in GitHub sync flows.
- 2026-03-15 29: Organization Better Auth writes now use workflow queues.
  - Split the organization actor's Better Auth routing and verification reads into `organization/actions/better-auth.ts`, moved `APP_SHELL_ORGANIZATION_ID` to `organization/constants.ts`, and renamed the org Better Auth read surface to the `betterAuth*` form.
  - Added dedicated organization workflow queue handlers for session/email/account index writes plus verification CRUD, and updated `services/better-auth.ts` to send those mutations directly to organization queues instead of calling mutation actions.
- 2026-03-15 30: Shared model routing metadata is now centralized.
  - Extended the shared model catalog with explicit `agentKind` and `sandboxAgentId` metadata, changed `WorkspaceAgentKind` to a dynamic string, and switched backend task session creation to resolve sandbox agent ids through the shared catalog instead of hardcoded `Codex` vs `Claude` branching.
  - Updated the mock app/workspace and frontend model picker/new-task flows to consume the shared catalog/default model instead of forcing stale `Claude`/`Codex` fallbacks or a baked-in `gpt-5.3-codex` create-task default.
- 2026-03-15 31: Dead GitHub-data PR reload surface removed and fixture PR shapes aligned.
  - Deleted the unused GitHub-data `reloadPullRequest` workflow command plus the dead `listOpenPullRequests` / `getPullRequestForBranch` action surface that no longer has live Foundry callers.
  - Fixed the stale client `workspace-model.ts` pull-request fixtures to use the live `WorkspacePullRequestSummary` shape, which removes the last targeted client type errors in the touched slice.
- 2026-03-15 32: Organization action splitting continued past Better Auth.
  - Moved the app snapshot/default-model/org-profile actions into `organization/actions/organization.ts`, onboarding actions into `organization/actions/onboarding.ts`, and app-level GitHub token/import actions into `organization/actions/github.ts`, then composed those files at the actor boundary.
  - `organization/app-shell.ts` now exports shared helpers for those domains and no longer directly defines the moved action handlers, shrinking the remaining monolith and advancing item `10`.
- 2026-03-15 33: Task PR detail now reads the repository-owned task projection.
  - Removed duplicate scalar PR fields from `TaskRecord` and `WorkspaceTaskDetail`, switched the remaining frontend/client consumers to the canonical `pullRequest` object, and trimmed stale mock/test scaffolding that still populated those dead fields.
  - Replaced the task actor's PR lookup path with a repository projection read (`getProjectedTaskSummary`) so task detail/summary no longer ask the repo actor to re-query GitHub PR rows by branch.
- 2026-03-15 34: Workspace model catalogs now come from the live sandbox-agent API.
  - Added a shared normalizer for `/v1/agents?config=true` payloads, exposed sandbox-scoped `listWorkspaceModelGroups()` from the task sandbox actor, and switched backend workspace session creation to resolve sandbox agent ids from the live sandbox catalog instead of only the checked-in default tables.
  - Updated the frontend workspace model picker to query the active sandbox for model groups and use that live catalog for labels/options, while keeping the shared default catalog only as a fallback when no sandbox is available yet or the sandbox-agent connection is unavailable.
- 2026-03-15 35: Backend-only organization snapshot refresh is now queue-backed.
  - Added `organization.command.snapshot.broadcast` to the organization workflow, switched repository and app-import callers to send that queue message instead of calling the organization actor's `refreshOrganizationSnapshot` action directly, and removed the direct action wrapper.
  - Deleted the dead `adminReconcileWorkspaceState` organization action/interface entry after confirming nothing in Foundry still calls it.
- 2026-03-15 36: Dead backend actor export cleanup continued.
  - Removed the stale `export * from "./events.js"` line from `backend/src/actors/index.ts`, which was left behind after deleting the dead backend event type file.
  - This keeps the backend actor barrel aligned with the live file set and advances the final dead-code/event audit.
- 2026-03-15 34: Item 17 removed from this checklist; do not leave started items half-finished.
  - By request, item `17` (`Type all actor context parameters — remove c: any`) is deferred out of this Foundry task and should not block completion here.
  - Process note for the remaining checklist work: once an item is started, finish that item to completion before opening a different partial seam. Item `15` is the current priority under that rule.
- 2026-03-15 35: Task/PR unification now routes live PR changes through repository-owned task summaries only.
  - GitHub PR sync and webhook handling now send concrete PR summaries directly to the repository coordinator, which lazily creates a real branch-owned task when needed and persists PR metadata on the task projection instead of re-querying raw `github_pull_requests` rows from repository reads.
  - Cleared the last stale scalar PR test references (`prUrl`, `reviewStatus`, `reviewer`) so the remaining Foundry surfaces consistently use the canonical `pullRequest` object.
- 2026-03-15 36: Organization action entrypoints are now fully organized under `actions/`, and the public mutation surface is queue-only.
  - Moved organization task/workspace proxy actions plus `createTaskMutation` into `organization/actions/tasks.ts`, added `organization/actions/app.ts` so every composed org action bundle now lives under `organization/actions/*`, and removed dead `app-shell` exports that no longer had external callers.
  - Audited the remaining public organization actor actions and confirmed the write paths go through organization/repository/task/github-data workflow queues instead of direct mutation actions, which closes item `4` and item `10`.
- 2026-03-15 37: Organization dead-code audit completed.
  - Removed the leftover exported-only Better Auth predicate helper from `organization/actions/better-auth.ts`; it is now module-private because nothing outside that file uses it.
  - Audited the remaining organization actor surface and confirmed the live public reads/writes still in use are the composed `actions/*` bundles plus workflow mutation helpers. There are no remaining dead org action exports from the pre-refactor monolith.
- 2026-03-15 38: Final dead-event and dead-surface audit completed for the in-scope Foundry refactor.
  - Confirmed the live Foundry realtime topics each have a single event type (`appUpdated`, `organizationUpdated`, `taskUpdated`, `sessionUpdated`), and the deleted legacy event names (`workspaceUpdated`, `taskSummaryUpdated`, `taskDetailUpdated`, `pullRequestUpdated`, `pullRequestRemoved`) no longer exist in live Foundry code.
  - Re-audited the major removed compatibility seams (`Workbench`, branch rename, PR-only sidebar ids, duplicate runtime task status, `getTaskEnriched`, organization-owned task lookup tables) and found no remaining live references beyond expected domain strings like GitHub webhook event names or CLI `pr` labels.
- 2026-03-15 39: Item 15 was finished for real by moving PR ownership into the task actor.
  - Added task-local `pull_request_json` storage, switched task detail/summary reads to the task DB, and added `task.command.pull_request.sync` so GitHub/repository flows update PR metadata through the task coordinator instead of overlaying it in the repository projection.
  - The mock right sidebar now trusts the canonical `task.pullRequest.url` field instead of rebuilding a PR URL from repo name + PR number.
- 2026-03-15 40: Better Auth user singleton constraint is now enforced without breaking the adapter contract.
  - The user actor's `user` table now uses an integer singleton primary key with `CHECK (id = 1)` plus a separate `auth_user_id` column for Better Auth's external string identity.
  - Updated the user actor query/join/mutation helpers so Better Auth still reads and writes logical `user.id` as the external string id while SQLite enforces the singleton row invariant locally.

No backwards compatibility — delete old code, don't deprecate. If something is removed, remove it everywhere (backend, client, shared types, frontend, tests, mocks).

### Suggested execution order (respects dependencies)

**Wave 1 — no dependencies, can be done in any order:**
1, 2, 3, 4, 5, 6, 13, 16, 20, 21, 23, 25

**Wave 2 — depends on wave 1:**
7 (after 1), 9 (after 13), 10 (after 1+6), 11 (after 4), 22 (after 1), 24 (after 21), 26 (after 25)

**Wave 3 — depends on wave 2:**
8 (after 7+25), 12 (after 10), 15 (after 9+13), 19 (after 21+24)

**Wave 4 — depends on wave 3:**
14 (after 15)

**Final:**
18 (after everything), final audit pass (after everything)

### Index

- [x] 1. Rename Auth User actor → User actor
- [x] 2. Add Better Auth mapping comments to user/org actor tables
- [x] 3. Enforce `id = 1` CHECK constraint on single-row tables
- [x] 4. Move all mutation actions to queue messages
- [x] 5. Migrate task actor raw SQL to Drizzle migrations
- [x] 6. Rename History actor → Audit Log actor
- [x] 7. Move starred/default model to user actor settings *(depends on: 1)*
- [x] 8. Replace hardcoded model/agent lists with sandbox-agent API data *(depends on: 7, 25)*
- [x] 9. Flatten `taskLookup` + `taskSummaries` into single `tasks` table *(depends on: 13)*
- [x] 10. Reorganize user and org actor actions into `actions/` folders *(depends on: 1, 6)*
- [x] 11. Standardize workflow file structure across all actors *(depends on: 4)*
- [x] 12. Audit and remove dead code in organization actor *(depends on: 10)*
- [x] 13. Enforce coordinator pattern and fix ownership violations
- [x] 14. Standardize one event per subscription topic *(depends on: 15)*
- [x] 15. Unify tasks and pull requests — PRs are just task data *(depends on: 9, 13)*
- [x] 16. Chunk GitHub data sync and publish progress
- [x] 18. Final pass: remove all dead code *(depends on: all other items)*
- [x] 19. Remove duplicate data between `c.state` and SQLite *(depends on: 21, 24)*
- [x] 20. Prefix admin/recovery actions with `admin`
- [x] 21. Remove legacy/session-scoped fields from task table
- [x] 22. Move per-user UI state from task actor to user actor *(depends on: 1)*
- [x] 23. Delete `getTaskEnriched` and `enrichTaskRecord` (dead code)
- [x] 24. Clean up task status tracking *(depends on: 21)*
- [x] 25. Remove "Workbench" prefix from all types, functions, files, tables
- [x] 26. Delete branch rename (branches immutable after creation) *(depends on: 25)*
- [x] Final audit pass: dead events scan *(depends on: all other items)*

Deferred follow-up outside this checklist:

- 17. Type all actor context parameters — remove `c: any` *(removed from this task's scope by request)*

---

## [ ] 1. Rename Auth User actor → User actor

**Rationale:** The actor is already a single per-user actor storing all user data. The "Auth" prefix is unnecessary.

### Files to change

- **`foundry/packages/backend/src/actors/auth-user/`** → rename directory to `user/`
  - `index.ts` — rename export `authUser` → `user`, display name `"Auth User"` → `"User"`
  - `db/schema.ts`, `db/db.ts`, `db/migrations.ts`, `db/drizzle.config.ts` — update any auth-prefixed references
- **`foundry/packages/backend/src/actors/keys.ts`** — `authUserKey()` → `userKey()`
- **`foundry/packages/backend/src/actors/handles.ts`** — `getOrCreateAuthUser` → `getOrCreateUser`, `getAuthUser` → `getUser`, `selfAuthUser` → `selfUser`
- **`foundry/packages/backend/src/actors/index.ts`** — update import path and registration
- **`foundry/packages/backend/src/services/better-auth.ts`** — update all `authUser` references
- **Action names** — consider dropping "Auth" prefix from `createAuthRecord`, `findOneAuthRecord`, `updateAuthRecord`, `deleteAuthRecord`, `countAuthRecords`, etc.

---

## [ ] 2. Add Better Auth mapping comments to user/org actor tables, actions, and queues

**Rationale:** The user and organization actors contain a mix of Better Auth-driven and custom Foundry code. Tables, actions, and queues that exist to serve Better Auth's adapter need comments so developers know which pieces are constrained by Better Auth's schema/contract and which are ours to change freely.

### Table mapping

| Actor | Table | Better Auth? | Notes |
|---|---|---|---|
| user | `user` | Yes — 1:1 `user` model | All fields from Better Auth |
| user | `session` | Yes — 1:1 `session` model | All fields from Better Auth |
| user | `account` | Yes — 1:1 `account` model | All fields from Better Auth |
| user | `user_profiles` | No — custom Foundry | GitHub login, role, eligible orgs, starter repo status |
| user | `session_state` | No — custom Foundry | Active organization per session |
| org | `auth_verification` | Yes — Better Auth `verification` model | Lives on org actor because verification happens before user exists |
| org | `auth_session_index` | No — custom routing index | Maps session tokens → user actor IDs for Better Auth adapter routing |
| org | `auth_email_index` | No — custom routing index | Maps emails → user actor IDs for Better Auth adapter routing |
| org | `auth_account_index` | No — custom routing index | Maps OAuth accounts → user actor IDs for Better Auth adapter routing |

### Action/queue mapping (user actor)

| Action/Queue | Better Auth? | Notes |
|---|---|---|
| `createAuthRecord` | Yes — Better Auth adapter | Called by Better Auth adapter to create user/session/account records |
| `findOneAuthRecord` | Yes — Better Auth adapter | Called by Better Auth adapter for single-record lookups with joins |
| `findManyAuthRecords` | Yes — Better Auth adapter | Called by Better Auth adapter for multi-record queries |
| `updateAuthRecord` | Yes — Better Auth adapter | Called by Better Auth adapter to update records |
| `updateManyAuthRecords` | Yes — Better Auth adapter | Called by Better Auth adapter for bulk updates |
| `deleteAuthRecord` | Yes — Better Auth adapter | Called by Better Auth adapter to delete records |
| `deleteManyAuthRecords` | Yes — Better Auth adapter | Called by Better Auth adapter for bulk deletes |
| `countAuthRecords` | Yes — Better Auth adapter | Called by Better Auth adapter for count queries |
| `getAppAuthState` | No — custom Foundry | Aggregates auth state for frontend consumption |
| `upsertUserProfile` | No — custom Foundry | Manages Foundry-specific user profile data |
| `upsertSessionState` | No — custom Foundry | Manages Foundry-specific session state |

### Action/queue mapping (organization actor app-shell)

| Action/Queue | Better Auth? | Notes |
|---|---|---|
| App-shell auth index CRUD actions | Yes — Better Auth adapter routing | Maintain lookup indexes so the adapter can route by session/email/account to the correct user actor |
| `auth_verification` CRUD | Yes — Better Auth `verification` model | Used for email verification and password resets |

### Files to change

- **`foundry/packages/backend/src/actors/auth-user/db/schema.ts`** — add doc comments to each table:
  - `user`, `session`, `account`: "Better Auth core model — schema defined at https://better-auth.com/docs/concepts/database"
  - `user_profiles`, `session_state`: "Custom Foundry table — not part of Better Auth"
- **`foundry/packages/backend/src/actors/auth-user/index.ts`** — add doc comments to each action/queue:
  - Better Auth adapter actions: "Better Auth adapter — called by the Better Auth adapter in better-auth.ts. Schema constrained by Better Auth."
  - Custom actions: "Custom Foundry action — not part of Better Auth"
- **`foundry/packages/backend/src/actors/organization/db/schema.ts`** — add doc comments to `auth_verification` (Better Auth core), and the three index tables (Better Auth adapter routing)
- **`foundry/packages/backend/src/actors/organization/app-shell.ts`** — add doc comments to auth index actions marking them as Better Auth adapter routing infrastructure

---

## [x] 3. Enforce `id = 1` CHECK constraint on all single-row actor tables

**Rationale:** When an actor instance represents a single entity, tables that hold exactly one row should enforce this at the DB level with a `CHECK (id = 1)` constraint. The task actor already does this correctly; other actors don't.

### Tables needing the constraint

| Actor | Table | Current enforcement | Fix needed |
|---|---|---|---|
| auth-user (→ user) | `user` | None | Add `CHECK (id = 1)`, use integer PK |
| auth-user (→ user) | `user_profiles` | None | Add `CHECK (id = 1)`, use integer PK |
| github-data | `github_meta` | Hardcoded `id=1` in code only | Add `CHECK (id = 1)` in schema |
| organization | `organization_profile` | None | Add `CHECK (id = 1)`, use integer PK |
| repository | `repo_meta` | Hardcoded `id=1` in code only | Add `CHECK (id = 1)` in schema |
| task | `task` | CHECK constraint | Already correct |
| task | `task_runtime` | CHECK constraint | Already correct |

### Files to change

- **`foundry/packages/backend/src/actors/auth-user/db/schema.ts`** — change `user` and `user_profiles` tables to integer PK with CHECK constraint
- **`foundry/packages/backend/src/actors/auth-user/index.ts`** — update queries to use `id = 1` pattern
- **`foundry/packages/backend/src/services/better-auth.ts`** — update adapter to use fixed `id = 1`
- **`foundry/packages/backend/src/actors/github-data/db/schema.ts`** — add CHECK constraint to `github_meta` (already uses `id=1` in code)
- **`foundry/packages/backend/src/actors/organization/db/schema.ts`** — change `organization_profile` to integer PK with CHECK constraint
- **`foundry/packages/backend/src/actors/organization/actions.ts`** — update queries to use `id = 1`
- **`foundry/packages/backend/src/actors/repository/db/schema.ts`** — add CHECK constraint to `repo_meta` (already uses `id=1` in code)
- All affected actors — regenerate `db/migrations.ts`

### CLAUDE.md update

- **`foundry/packages/backend/CLAUDE.md`** — add constraint: "Single-row tables (tables that hold exactly one record per actor instance, e.g. metadata or profile tables) must use an integer primary key with a `CHECK (id = 1)` constraint to enforce the singleton invariant at the database level. Follow the pattern established in the task actor's `task` and `task_runtime` tables."

---

## [x] 4. Move all mutation actions to queue messages

**Rationale:** Actions should be read-only (queries). All mutations (INSERT/UPDATE/DELETE) should go through queue messages processed by workflow handlers. This ensures single-writer consistency and aligns with the actor model. No actor currently does this correctly — the history actor has the mutation in the workflow handler, but the `append` action wraps a `wait: true` queue send, which is the same anti-pattern (callers should send to the queue directly).

### Violations by actor

**User actor (auth-user)** — `auth-user/index.ts` — 7 mutation actions:
- `createAuthRecord` (INSERT, line 164)
- `updateAuthRecord` (UPDATE, line 205)
- `updateManyAuthRecords` (UPDATE, line 219)
- `deleteAuthRecord` (DELETE, line 234)
- `deleteManyAuthRecords` (DELETE, line 243)
- `upsertUserProfile` (UPSERT, line 283)
- `upsertSessionState` (UPSERT, line 331)

**GitHub Data actor** — `github-data/index.ts` — 7 mutation actions:
- `fullSync` (batch INSERT/DELETE/UPDATE, line 686)
- `reloadOrganization` (batch, line 690)
- `reloadAllPullRequests` (batch, line 694)
- `reloadRepository` (INSERT/UPDATE, line 698)
- `reloadPullRequest` (INSERT/DELETE/UPDATE, line 763)
- `clearState` (batch DELETE, line 851)
- `handlePullRequestWebhook` (INSERT/UPDATE/DELETE, line 879)

**Organization actor — `actions.ts`** — 5 mutation actions:
- `applyTaskSummaryUpdate` (UPSERT, line 464)
- `removeTaskSummary` (DELETE, line 476)
- `applyGithubRepositoryProjection` (UPSERT, line 521)
- `applyGithubDataProjection` (INSERT/UPDATE/DELETE, line 547)
- `recordGithubWebhookReceipt` (UPDATE, line 620)

**Organization actor — `app-shell.ts`** — 38 mutation actions:

Better Auth index mutations (11):
- `authUpsertSessionIndex` (UPSERT)
- `authDeleteSessionIndex` (DELETE)
- `authUpsertEmailIndex` (UPSERT)
- `authDeleteEmailIndex` (DELETE)
- `authUpsertAccountIndex` (UPSERT)
- `authDeleteAccountIndex` (DELETE)
- `authCreateVerification` (INSERT)
- `authUpdateVerification` (UPDATE)
- `authUpdateManyVerification` (UPDATE)
- `authDeleteVerification` (DELETE)
- `authDeleteManyVerification` (DELETE)

Organization profile/state mutations (13):
- `updateOrganizationShellProfile` (UPDATE on organizationProfile)
- `markOrganizationSyncStarted` (UPDATE on organizationProfile)
- `applyOrganizationSyncCompleted` (UPDATE on organizationProfile)
- `markOrganizationSyncFailed` (UPDATE on organizationProfile)
- `applyOrganizationStripeCustomer` (UPDATE on organizationProfile)
- `applyOrganizationStripeSubscription` (UPSERT on organizationProfile)
- `applyOrganizationFreePlan` (UPDATE on organizationProfile)
- `setOrganizationBillingPaymentMethod` (UPDATE on organizationProfile)
- `setOrganizationBillingStatus` (UPDATE on organizationProfile)
- `upsertOrganizationInvoice` (UPSERT on invoices)
- `recordOrganizationSeatUsage` (UPSERT on seatAssignments)
- `applyGithubInstallationCreated` (UPDATE on organizationProfile)
- `applyGithubInstallationRemoved` (UPDATE on organizationProfile)

App-level mutations that delegate + mutate (8):
- `skipAppStarterRepo` (calls upsertUserProfile)
- `starAppStarterRepo` (calls upsertUserProfile + child mutation)
- `selectAppOrganization` (calls setActiveOrganization)
- `triggerAppRepoImport` (calls markOrganizationSyncStarted)
- `createAppCheckoutSession` (calls applyOrganizationFreePlan + applyOrganizationStripeCustomer)
- `finalizeAppCheckoutSession` (calls applyOrganizationStripeCustomer)
- `cancelAppScheduledRenewal` (calls setOrganizationBillingStatus)
- `resumeAppSubscription` (calls setOrganizationBillingStatus)
- `recordAppSeatUsage` (calls recordOrganizationSeatUsage)
- `handleAppStripeWebhook` (calls multiple org mutations)
- `handleAppGithubWebhook` (calls org mutations + github-data mutations)
- `syncOrganizationShellFromGithub` (multiple DB operations)
- `applyGithubRepositoryChanges` (calls applyGithubRepositoryProjection)

**Task actor workbench** — `task/workbench.ts` — 14 mutation actions:
- `renameWorkbenchTask` (UPDATE, line 970)
- `renameWorkbenchBranch` (UPDATE, line 988)
- `createWorkbenchSession` (INSERT, line 1039)
- `renameWorkbenchSession` (UPDATE, line 1125)
- `setWorkbenchSessionUnread` (UPDATE, line 1136)
- `updateWorkbenchDraft` (UPDATE, line 1143)
- `changeWorkbenchModel` (UPDATE, line 1152)
- `sendWorkbenchMessage` (UPDATE, line 1205)
- `stopWorkbenchSession` (UPDATE, line 1255)
- `syncWorkbenchSessionStatus` (UPDATE, line 1265)
- `closeWorkbenchSession` (UPDATE, line 1331)
- `markWorkbenchUnread` (UPDATE, line 1363)
- `publishWorkbenchPr` (UPDATE, line 1375)
- `revertWorkbenchFile` (UPDATE, line 1403)

**Repository actor** — `repository/actions.ts` — 5 mutation actions/helpers:
- `createTask` → calls `createTaskMutation()` (INSERT on taskIndex + creates task actor)
- `registerTaskBranch` → calls `registerTaskBranchMutation()` (INSERT/UPDATE on taskIndex)
- `reinsertTaskIndexRow()` (INSERT/UPDATE, called from `getTaskEnriched`)
- `deleteStaleTaskIndexRow()` (DELETE)
- `persistRemoteUrl()` (INSERT/UPDATE on repoMeta, called from `getRepoOverview`)

### History (audit log) actor — `append` action must also be removed

The history actor's workflow handler is correct (mutation in queue handler), but the `append` action (line 77) is a `wait: true` wrapper around the queue send — same anti-pattern. Delete the `append` action. Callers (the `appendHistory()` helper in `task/workflow/common.ts`) should send directly to the `auditLog.command.append` queue with `wait: false` (audit log writes are fire-and-forget, no need to block the caller).

### Reference patterns (queue handlers only, no action wrappers)
- **Task actor core** — initialize, attach, push, sync, merge, archive, kill all use queue messages directly

### Migration approach

This is NOT about wrapping queue sends inside actions. The mutation actions must be **removed entirely** and replaced with queue messages that callers (including `packages/client`) send directly.

Each actor needs:
1. Define queue message types for each mutation
2. Move mutation logic from action handlers into workflow/queue handlers
3. **Delete the mutation actions** — do not wrap them
4. Update `packages/client` to send queue messages directly to the actor instead of calling the old action
5. Update any inter-actor callers (e.g. `better-auth.ts`, `app-shell.ts`, other actors) to send queue messages instead of calling actions

### CLAUDE.md update

- **`foundry/packages/backend/CLAUDE.md`** — add constraint: "Actions must be read-only. All database mutations (INSERT, UPDATE, DELETE, UPSERT) must be queue messages processed by workflow handlers. Callers (client, other actors, services) send messages directly to the queue — do not wrap queue sends inside actions. Follow the pattern established in the task workflow actor's queue handlers."

---

## [ ] 5. Migrate task actor raw SQL to Drizzle migrations

**Rationale:** The task actor uses raw `db.execute()` with `ALTER TABLE ... ADD COLUMN` in `workbench.ts` and `workflow/init.ts` instead of proper Drizzle migrations. All actor DBs should use the standard Drizzle migration pattern.

### Files to change

- **`foundry/packages/backend/src/actors/task/workbench.ts`** (lines 24-56) — remove `ALTER TABLE` raw SQL, add columns to `db/schema.ts` and generate a proper migration
- **`foundry/packages/backend/src/actors/task/workflow/init.ts`** (lines 12-15) — same treatment
- **`foundry/packages/backend/src/actors/task/db/schema.ts`** — add the missing columns that are currently added via `ALTER TABLE`
- **`foundry/packages/backend/src/actors/task/db/migrations.ts`** — regenerate with new migration

### CLAUDE.md update

- **`foundry/packages/backend/CLAUDE.md`** — add constraint: "All actor databases must use Drizzle ORM with proper schema definitions and generated migrations. No raw SQL (`db.execute()`, `ALTER TABLE`, etc.). Schema changes must go through `schema.ts` + migration generation."

---

## [ ] 6. Rename History actor → Audit Log actor

**Rationale:** The actor functions as a comprehensive audit log tracking task lifecycle events. "Audit Log" better describes its purpose.

### Files to change

- **`foundry/packages/backend/src/actors/history/`** → rename directory to `audit-log/`
  - `index.ts` — rename export `history` → `auditLog`, display name `"History"` → `"Audit Log"`, queue `history.command.append` → `auditLog.command.append`
  - Internal types: `HistoryInput` → `AuditLogInput`, `AppendHistoryCommand` → `AppendAuditLogCommand`, `ListHistoryParams` → `ListAuditLogParams`
- **`foundry/packages/backend/src/actors/keys.ts`** — `historyKey()` → `auditLogKey()`
- **`foundry/packages/backend/src/actors/handles.ts`** — `getOrCreateHistory` → `getOrCreateAuditLog`, `selfHistory` → `selfAuditLog`
- **`foundry/packages/backend/src/actors/index.ts`** — update import path and registration
- **`foundry/packages/shared/src/contracts.ts`** — `HistoryEvent` → `AuditLogEvent`
- **`foundry/packages/backend/src/actors/organization/actions.ts`** — `history()` action → `auditLog()`, update imports
- **`foundry/packages/backend/src/actors/repository/actions.ts`** — update `getOrCreateHistory` calls
- **`foundry/packages/backend/src/actors/task/workflow/common.ts`** — `appendHistory()` → `appendAuditLog()`
- **`foundry/packages/backend/src/actors/task/workflow/init.ts`** — update imports and calls
- **`foundry/packages/backend/src/actors/task/workflow/commands.ts`** — update imports and calls
- **`foundry/packages/backend/src/actors/task/workflow/push.ts`** — update imports and calls

### Coverage gaps to fix

The audit log only covers 9 of ~24 significant events (37.5%). The entire `task/workbench.ts` file has zero logging. Add audit log calls for:

**High priority (missing lifecycle events):**
- `task.switch` — in `task/workflow/index.ts` handleSwitchActivity
- `task.session.created` — in `task/workbench.ts` createWorkbenchSession
- `task.session.closed` — in `task/workbench.ts` closeWorkbenchSession
- `task.session.stopped` — in `task/workbench.ts` stopWorkbenchSession

**Medium priority (missing user actions):**
- `task.session.renamed` — renameWorkbenchSession
- `task.message.sent` — sendWorkbenchMessage
- `task.model.changed` — changeWorkbenchModel
- `task.title.changed` — renameWorkbenchTask
- `task.branch.renamed` — renameWorkbenchBranch
- `task.pr.published` — publishWorkbenchPr
- `task.file.reverted` — revertWorkbenchFile

**Low priority / debatable:**
- `task.draft.updated`, `task.session.unread`, `task.derived.refreshed`, `task.transcript.refreshed`

### CLAUDE.md updates needed

- **`foundry/packages/backend/CLAUDE.md`** — rename `HistoryActor` → `AuditLogActor` in actor hierarchy, add maintenance rule: "Every new action or command handler that represents a user-visible or workflow-significant event must append to the audit log actor. The audit log must remain a comprehensive record of all significant operations."
- **`foundry/CLAUDE.md`** — rename "History Events" section → "Audit Log Events", update the list to include all events above, add note: "When adding new task/workbench commands, always add a corresponding audit log event."

---

## [ ] 7. Move starred/default model to user actor settings

**Dependencies:** item 1

**Rationale:** The starred/default model preference is currently broken — the frontend stores it in local React state that resets on reload. The org actor's `organizationProfile` table has a `defaultModel` column but there's no action to update it and it's the wrong scope anyway. This is a per-user preference, not an org setting.

### Current state (broken)

- **Frontend** (`mock-layout.tsx` line 313) — `useState<ModelId>("claude-sonnet-4")` — local state, lost on reload
- **Model picker UI** (`model-picker.tsx`) — has star icons + `onSetDefault` callback, but it only updates local state
- **Org actor** (`organization/db/schema.ts` line 43) — `defaultModel` column exists but nothing writes to it
- **No backend persistence** — starred model is not saved anywhere

### Changes needed

1. **Add `user_settings` table to user actor** (or add `defaultModel` column to `user_profiles`):
   - `defaultModel` (text) — the user's starred/preferred model
   - File: `foundry/packages/backend/src/actors/auth-user/db/schema.ts`

2. **Add queue message to user actor** to update the default model:
   - File: `foundry/packages/backend/src/actors/auth-user/index.ts`

3. **Remove `defaultModel` from org actor** `organizationProfile` table (wrong scope):
   - File: `foundry/packages/backend/src/actors/organization/db/schema.ts`

4. **Update frontend** to read starred model from user settings (via `app` subscription) and send queue message on star click:
   - File: `foundry/packages/frontend/src/components/mock-layout/model-picker.tsx`
   - File: `foundry/packages/frontend/src/components/mock-layout.tsx`

5. **Update shared types** — move `defaultModel` from `FoundryOrganizationSettings` to user settings type:
   - File: `foundry/packages/shared/src/app-shell.ts`

6. **Update client** to send the queue message to user actor:
   - File: `foundry/packages/client/`

---

## [ ] 8. Replace hardcoded model/agent lists with sandbox-agent API data

**Dependencies:** items 7, 25

**Rationale:** The frontend hardcodes 8 models in a static list and ignores the sandbox-agent API's `GET /v1/agents` endpoint which already exposes the full agent config — models, modes, and reasoning/thought levels per agent. The frontend should consume this API 1:1 instead of maintaining its own stale copy.

### Current state (hardcoded)

- **`foundry/packages/frontend/src/components/mock-layout/view-model.ts`** (lines 20-39) — hardcoded `MODEL_GROUPS` with 8 models
- **`foundry/packages/client/src/workbench-model.ts`** (lines 18-37) — identical hardcoded `MODEL_GROUPS` copy
- **`foundry/packages/shared/src/workbench.ts`** (lines 5-13) — `WorkbenchModelId` hardcoded union type
- No modes or thought/reasoning levels exposed in UI at all
- No API calls to discover available models

### What the sandbox-agent API already provides (`GET /v1/agents`)

Per agent, the API returns:
- **models** — full list with display names (Claude: 4, Codex: 6, Cursor: 35+, OpenCode: 239)
- **modes** — execution modes (Claude: 5, Codex: 3, OpenCode: 2)
- **thought_level** — reasoning levels (Codex: low/medium/high/xhigh, Mock: low/medium/high)
- **capabilities** — plan_mode, reasoning, status support
- **credentialsAvailable** / **installed** — agent availability

### Changes needed

1. **Remove hardcoded model lists** from:
   - `foundry/packages/frontend/src/components/mock-layout/view-model.ts` — delete `MODEL_GROUPS`
   - `foundry/packages/client/src/workbench-model.ts` — delete `MODEL_GROUPS`
   - `foundry/packages/shared/src/workbench.ts` — replace `WorkbenchModelId` union type with `string` (dynamic from API)

2. **Backend: fetch and cache agent config from sandbox-agent API**
   - Add an action or startup flow that calls `GET /v1/agents?config=true` on the sandbox-agent API
   - Cache the result (agent list + models + modes + thought levels) in the appropriate actor
   - Expose it to the frontend via the existing subscription/event system

3. **Frontend: consume API-driven config**
   - Model picker reads available models from backend-provided agent config, not hardcoded list
   - Expose modes selector per agent
   - Expose thought/reasoning level selector for agents that support it (Codex, Mock)
   - Group models by agent as the API does (not by arbitrary provider grouping)

4. **Update shared types** — make model/mode/thought_level types dynamic strings rather than hardcoded unions:
   - `foundry/packages/shared/src/workbench.ts`

5. **No backwards compatibility needed** — we're cleaning up, not preserving old behavior

---

## [ ] 9. Flatten `taskLookup` + `taskSummaries` into single `tasks` table on org actor

**Dependencies:** item 13

**Rationale:** `taskLookup` (taskId → repoId) is a strict subset of `taskSummaries` (which also has repoId + title, status, branch, PR, sessions). There's no reason for two tables with the same primary key. Flatten into one `tasks` table.

### Current state

- **`taskLookup`** — `taskId` (PK), `repoId` — used only for taskId → repoId resolution
- **`taskSummaries`** — `taskId` (PK), `repoId`, `title`, `status`, `repoName`, `updatedAtMs`, `branch`, `pullRequestJson`, `sessionsSummaryJson` — materialized sidebar data

### Changes needed

1. **Merge into single `tasks` table** in `foundry/packages/backend/src/actors/organization/db/schema.ts`:
   - Drop `taskLookup` table
   - Rename `taskSummaries` → `tasks`
   - Keep all columns from `taskSummaries` (already includes `repoId`)

2. **Update all references**:
   - `foundry/packages/backend/src/actors/organization/actions.ts` — replace `taskLookup` queries with `tasks` table lookups
   - `foundry/packages/backend/src/actors/organization/app-shell.ts` — if it references either table
   - Any imports of the old table names from schema

3. **Regenerate migrations** — `foundry/packages/backend/src/actors/organization/db/migrations.ts`

---

## [x] 10. Reorganize user and organization actor actions into `actions/` folders

**Dependencies:** items 1, 6

**Rationale:** Both actors cram too many concerns into single files. The organization actor has `app-shell.ts` (1,947 lines) + `actions.ts` mixing Better Auth, Stripe, GitHub, onboarding, workbench proxying, and org state. The user actor mixes Better Auth adapter CRUD with custom Foundry actions. Split into `actions/` folders grouped by domain, with `betterAuth` prefix on all Better Auth actions.

### User actor → `user/actions/`

| File | Actions | Source |
|---|---|---|
| `actions/better-auth.ts` | `betterAuthCreateRecord`, `betterAuthFindOneRecord`, `betterAuthFindManyRecords`, `betterAuthUpdateRecord`, `betterAuthUpdateManyRecords`, `betterAuthDeleteRecord`, `betterAuthDeleteManyRecords`, `betterAuthCountRecords` + all helper functions (`tableFor`, `columnFor`, `normalizeValue`, `clauseToExpr`, `buildWhere`, `applyJoinToRow`, `applyJoinToRows`) | Currently in `index.ts` |
| `actions/user.ts` | `getAppAuthState`, `upsertUserProfile`, `upsertSessionState` | Currently in `index.ts` |

### Organization actor → `organization/actions/`

**Delete `app-shell.ts`** — split its ~50 actions + helpers across these files:

| File | Actions | Source |
|---|---|---|
| `actions/better-auth.ts` | `betterAuthFindSessionIndex`, `betterAuthUpsertSessionIndex`, `betterAuthDeleteSessionIndex`, `betterAuthFindEmailIndex`, `betterAuthUpsertEmailIndex`, `betterAuthDeleteEmailIndex`, `betterAuthFindAccountIndex`, `betterAuthUpsertAccountIndex`, `betterAuthDeleteAccountIndex`, `betterAuthCreateVerification`, `betterAuthFindOneVerification`, `betterAuthFindManyVerification`, `betterAuthUpdateVerification`, `betterAuthUpdateManyVerification`, `betterAuthDeleteVerification`, `betterAuthDeleteManyVerification`, `betterAuthCountVerification` + auth clause builder helpers | Currently in `app-shell.ts` |
| `actions/stripe.ts` | `createAppCheckoutSession`, `finalizeAppCheckoutSession`, `createAppBillingPortalSession`, `cancelAppScheduledRenewal`, `resumeAppSubscription`, `recordAppSeatUsage`, `handleAppStripeWebhook`, `applyOrganizationStripeCustomer`, `applyOrganizationStripeSubscription`, `applyOrganizationFreePlan`, `setOrganizationBillingPaymentMethod`, `setOrganizationBillingStatus`, `upsertOrganizationInvoice`, `recordOrganizationSeatUsage` | Currently in `app-shell.ts` |
| `actions/github.ts` | `resolveAppGithubToken`, `beginAppGithubInstall`, `triggerAppRepoImport`, `handleAppGithubWebhook`, `syncOrganizationShellFromGithub`, `syncGithubOrganizations`, `applyGithubInstallationCreated`, `applyGithubInstallationRemoved`, `applyGithubRepositoryChanges`, `reloadGithubOrganization`, `reloadGithubPullRequests`, `reloadGithubRepository`, `reloadGithubPullRequest`, `applyGithubRepositoryProjection`, `applyGithubDataProjection`, `recordGithubWebhookReceipt`, `refreshTaskSummaryForGithubBranch` | Currently split across `app-shell.ts` and `actions.ts` |
| `actions/onboarding.ts` | `skipAppStarterRepo`, `starAppStarterRepo`, `starSandboxAgentRepo`, `selectAppOrganization` | Currently in `app-shell.ts` |
| `actions/organization.ts` | `getAppSnapshot`, `getOrganizationShellState`, `getOrganizationShellStateIfInitialized`, `updateOrganizationShellProfile`, `updateAppOrganizationProfile`, `markOrganizationSyncStarted`, `applyOrganizationSyncCompleted`, `markOrganizationSyncFailed`, `useOrganization`, `getOrganizationSummary`, `reconcileWorkbenchState` | Currently split across `app-shell.ts` and `actions.ts` |
| `actions/tasks.ts` | `createTask`, `createWorkbenchTask`, `listTasks`, `getTask`, `switchTask`, `applyTaskSummaryUpdate`, `removeTaskSummary`, `findTaskForGithubBranch`, `applyOpenPullRequestUpdate`, `removeOpenPullRequest`, `attachTask`, `pushTask`, `syncTask`, `mergeTask`, `archiveTask`, `killTask` | Currently in `actions.ts` |
| `actions/workbench.ts` | `markWorkbenchUnread`, `renameWorkbenchTask`, `renameWorkbenchBranch`, `createWorkbenchSession`, `renameWorkbenchSession`, `setWorkbenchSessionUnread`, `updateWorkbenchDraft`, `changeWorkbenchModel`, `sendWorkbenchMessage`, `stopWorkbenchSession`, `closeWorkbenchSession`, `publishWorkbenchPr`, `revertWorkbenchFile` | Currently in `actions.ts` (proxy calls to task actor) |
| `actions/repos.ts` | `listRepos`, `getRepoOverview` | Currently in `actions.ts` |
| `actions/history.ts` | `history` (→ `auditLog` after rename) | Currently in `actions.ts` |

Also move:
- `APP_SHELL_ORGANIZATION_ID` constant → `organization/constants.ts`
- `runOrganizationWorkflow` → `organization/workflow.ts`
- Private helpers (`buildAppSnapshot`, `assertAppOrganization`, `collectAllTaskSummaries`, etc.) → colocate with the action file that uses them

### Files to update

- **`foundry/packages/backend/src/services/better-auth.ts`** — update all action name references to use `betterAuth` prefix
- **`foundry/packages/backend/src/actors/organization/index.ts`** — import and spread action objects from `actions/` files instead of `app-shell.ts` + `actions.ts`
- **`foundry/packages/backend/src/actors/auth-user/index.ts`** (or `user/index.ts`) — import actions from `actions/` files

---

## [ ] 11. Standardize workflow file structure across all actors

**Dependencies:** item 4

**Rationale:** Workflow logic is inconsistently placed — inline in `index.ts`, in `actions.ts`, or in a `workflow/` directory. Standardize: every actor with a workflow gets a `workflow.ts` file. If the workflow is large, use `workflow/{index,...}.ts`.

### Changes per actor

| Actor | Current location | New location | Notes |
|---|---|---|---|
| user (auth-user) | None | `workflow.ts` (new) | Needs a workflow for mutations (item 4) |
| github-data | Inline in `index.ts` (~57 lines) | `workflow.ts` | Extract `runGithubDataWorkflow` + handler |
| history (→ audit-log) | Inline in `index.ts` (~18 lines) | `workflow.ts` | Extract `runHistoryWorkflow` + `appendHistoryRow` |
| organization | In `actions.ts` (~51 lines) | `workflow.ts` | Extract `runOrganizationWorkflow` + queue handlers |
| repository | In `actions.ts` (~42 lines) | `workflow.ts` | Extract `runRepositoryWorkflow` + queue handlers |
| task | `workflow/` directory (926 lines) | `workflow/` directory — already correct | Keep as-is: `workflow/index.ts`, `workflow/queue.ts`, `workflow/common.ts`, `workflow/init.ts`, `workflow/commands.ts`, `workflow/push.ts` |
| sandbox | None (wrapper) | N/A | No custom workflow needed |

### Pattern

- **Small workflows** (< ~200 lines): single `workflow.ts` file
- **Large workflows** (> ~200 lines): `workflow/index.ts` holds the main loop, other files hold step groups:
  - `workflow/index.ts` — main loop + handler dispatch
  - `workflow/queue.ts` — queue name definitions (if many)
  - `workflow/{group}.ts` — step/activity functions grouped by domain

### CLAUDE.md update

- **`foundry/packages/backend/CLAUDE.md`** — add constraint: "Every actor with a message queue must have its workflow logic in a dedicated `workflow.ts` file (or `workflow/index.ts` for complex actors). Do not inline workflow logic in `index.ts` or `actions.ts`. Actions are read-only handlers; workflow handlers process queue messages and perform mutations."

---

---

## [ ] 12. Audit and remove dead code in organization actor

**Dependencies:** item 10

**Rationale:** The organization actor has ~50+ actions across `app-shell.ts` and `actions.ts`. Likely some are unused or vestigial. Audit all actions and queues for dead code and remove anything that has no callers.

### Scope

- All actions in `organization/actions.ts` and `organization/app-shell.ts`
- All queue message types and their handlers
- Helper functions that may no longer be called
- Shared types in `packages/shared` that only served removed actions

### Approach

- Trace each action/queue from caller → handler to confirm it's live
- Remove any action with no callers (client, other actors, services, HTTP endpoints)
- Remove any queue handler with no senders
- Remove associated types and helpers

---

## [ ] 13. Enforce coordinator pattern and fix ownership violations

**Rationale:** The actor hierarchy follows a coordinator pattern: org → repo → task → session. The coordinator owns the index/summary of its children, handles create/destroy, and children push updates up to their coordinator. Several violations exist where levels are skipped.

### Coordinator hierarchy (add to CLAUDE.md)

```
Organization (coordinator for repos)
├── Repository (coordinator for tasks)
│   └── Task (coordinator for sessions)
│       └── Session
```

**Rules:**
- The coordinator owns the index/summary table for its direct children
- The coordinator handles create/destroy of its direct children
- Children push summary updates UP to their direct coordinator (not skipping levels)
- Read paths go through the coordinator, not direct cross-level access
- No backwards compatibility needed — we're cleaning up

### Violations to fix

#### V1: Task index tables on wrong actor (HIGH)

`taskLookup` and `taskSummaries` (item 9 merges these into `tasks`) are on the **organization** actor but should be on the **repository** actor, since repo is the coordinator for tasks.

**Fix:**
- Move the merged `tasks` table (from item 9) to `repository/db/schema.ts`
- Repository owns task summaries, not organization
- Organization gets a `repoSummaries` table instead (repo count, latest activity, etc.) — the repo pushes its summary up to org

#### V2: Tasks push summaries directly to org, skipping repo (HIGH)

Task actors call `organization.applyTaskSummaryUpdate()` directly (line 464 in `actions.ts`), bypassing the repository coordinator.

**Fix:**
- Task pushes summary to `repository.applyTaskSummaryUpdate()` instead
- Repository updates its `tasks` table, then pushes a repo summary up to organization
- Organization never receives task-level updates directly

#### V3: Org resolves taskId → repoId from its own table (MEDIUM)

`resolveRepoId(c, taskId)` in `organization/actions.ts` queries `taskLookup` directly. Used by `switchTask`, `attachTask`, `pushTask`, `syncTask`, `mergeTask`, `archiveTask`, `killTask` (7 actions).

**Fix:**
- Remove `resolveRepoId()` from org actor
- Org must know the `repoId` from the caller (frontend already knows which repo a task belongs to) or query the repo actor
- Update all 7 proxy actions to require `repoId` in their input instead of looking it up

#### V4: Duplicate task creation bookkeeping at org level (MEDIUM)

`createTaskMutation` in org actor calls `repository.createTask()`, then independently inserts `taskLookup` and seeds `taskSummaries`. Repository already inserts its own `taskIndex` row.

**Fix:**
- Org calls `repository.createTask()` — that's it
- Repository handles all task index bookkeeping internally
- Repository pushes the new task summary back up to org as part of its repo summary update

### Files to change

- **`foundry/packages/backend/src/actors/organization/db/schema.ts`** — remove `taskLookup` and `taskSummaries`, add `repoSummaries` if needed
- **`foundry/packages/backend/src/actors/repository/db/schema.ts`** — add merged `tasks` table (task summaries)
- **`foundry/packages/backend/src/actors/organization/actions.ts`** — remove `resolveRepoId()`, `applyTaskSummaryUpdate`, `removeTaskSummary`, `findTaskForGithubBranch`, `refreshTaskSummaryForGithubBranch`; update proxy actions to require `repoId` in input
- **`foundry/packages/backend/src/actors/repository/actions.ts`** — add `applyTaskSummaryUpdate` action (receives from task), push repo summary to org
- **`foundry/packages/backend/src/actors/task/workflow/common.ts`** — change summary push target from org → repo
- **`foundry/packages/shared/src/contracts.ts`** — update input types to include `repoId` where needed
- **`foundry/packages/client/`** — update calls to pass `repoId`

### CLAUDE.md update

- **`foundry/packages/backend/CLAUDE.md`** — add coordinator pattern rules:
  ```
  ## Coordinator Pattern

  The actor hierarchy follows a strict coordinator pattern:
  - Organization = coordinator for repositories
  - Repository = coordinator for tasks
  - Task = coordinator for sessions

  Rules:
  - Each coordinator owns the index/summary table for its direct children.
  - Only the coordinator handles create/destroy of its direct children.
  - Children push summary updates to their direct coordinator only (never skip levels).
  - Cross-level access (e.g. org directly querying task state) is not allowed — go through the coordinator.
  - Proxy actions at higher levels (e.g. org.pushTask) must delegate to the correct coordinator, not bypass it.
  ```

---

---

## [ ] 14. Standardize one event per subscription topic across all actors

**Dependencies:** item 15

**Rationale:** Each subscription topic should have exactly one event type carrying the full replacement snapshot. The organization topic currently violates this with 7 subtypes. Additionally, event naming is inconsistent across actors. Standardize all of them.

### Current state

| Topic | Wire event name | Event type field | Subtypes | Issue |
|---|---|---|---|---|
| `app` | `appUpdated` | `type: "appUpdated"` | 1 | Name is fine |
| `organization` | `organizationUpdated` | 7 variants | **7** | Needs consolidation |
| `task` | `taskUpdated` | `type: "taskDetailUpdated"` | 1 | Wire name ≠ type name |
| `session` | `sessionUpdated` | `type: "sessionUpdated"` | 1 | Fine |
| `sandboxProcesses` | `processesUpdated` | `type: "processesUpdated"` | 1 | Fine |

### Target state

Every topic gets exactly one event. Wire event name = type field = `{topic}Updated`. Each carries the full snapshot for that topic.

| Topic | Event name | Payload |
|---|---|---|
| `app` | `appUpdated` | `FoundryAppSnapshot` |
| `organization` | `organizationUpdated` | `OrganizationSummarySnapshot` |
| `task` | `taskUpdated` | `WorkbenchTaskDetail` |
| `session` | `sessionUpdated` | `WorkbenchSessionDetail` |
| `sandboxProcesses` | `processesUpdated` | `SandboxProcessSnapshot[]` |

### Organization — consolidate 7 subtypes into 1

Remove the discriminated union. Replace all 7 subtypes:
- `taskSummaryUpdated`, `taskRemoved`, `repoAdded`, `repoUpdated`, `repoRemoved`, `pullRequestUpdated`, `pullRequestRemoved`

With a single `organizationUpdated` event carrying the full `OrganizationSummarySnapshot`. The client replaces its cached state — same pattern as every other topic.

### Task — fix event type name mismatch

Wire event is `taskUpdated` but the type field says `taskDetailUpdated`. Rename to `taskUpdated` everywhere for consistency.

### Files to change

- **`foundry/packages/shared/src/realtime-events.ts`** — replace `OrganizationEvent` union with single event type; rename `TaskEvent.type` from `taskDetailUpdated` → `taskUpdated`
- **`foundry/packages/backend/src/actors/organization/actions.ts`** — update all 7 `c.broadcast("organizationUpdated", { type: "taskSummaryUpdated", ... })` calls to emit single event with full snapshot
- **`foundry/packages/backend/src/actors/organization/app-shell.ts`** — same for any broadcasts here
- **`foundry/packages/backend/src/actors/task/workbench.ts`** — rename `taskDetailUpdated` → `taskUpdated` in broadcast calls
- **`foundry/packages/client/src/subscription/topics.ts`** — simplify `applyEvent` for organization topic (no more discriminated union handling); update task event type name
- **`foundry/packages/client/src/subscription/mock-manager.ts`** — update mock event handling
- **`foundry/packages/frontend/`** — update any direct references to event type names

### CLAUDE.md update

- **`foundry/packages/backend/CLAUDE.md`** — add constraint: "Each subscription topic must have exactly one event type. The event carries the full replacement snapshot for that topic — no discriminated unions, no partial patches, no subtypes. Event name must match the pattern `{topic}Updated` (e.g. `organizationUpdated`, `taskUpdated`). When state changes, broadcast the full snapshot; the client replaces its cached state."

---

## [x] 15. Unify tasks and pull requests — PRs are just task data

**Dependencies:** items 9, 13

**Rationale:** From the client's perspective, tasks and PRs are the same thing — a branch with work on it. The frontend already merges them into one sorted list, converting PRs to synthetic task objects with `pr:{prId}` IDs. The distinction is artificial. A "task" should represent any branch, and the task actor lazily wraps it. PR metadata is just data the task holds.

### Current state (separate entities)

- **Tasks**: stored in task actor SQLite, surfaced via `WorkbenchTaskSummary`, events via `taskSummaryUpdated`
- **PRs**: stored in GitHub data actor (`githubPullRequests` table), surfaced via `WorkbenchOpenPrSummary`, events via `pullRequestUpdated`/`pullRequestRemoved`
- **Frontend hack**: converts PRs to fake task objects with `pr:{prId}` IDs, merges into one list
- **Filtering logic**: org actor silently swallows `pullRequestUpdated` if a task claims the same branch — fragile coupling
- **Two separate types**: `WorkbenchTaskSummary` and `WorkbenchOpenPrSummary` with overlapping fields

### Target state (unified)

- **One entity**: a "task" represents a branch. Task actors are lazily created when needed (user creates one, or a PR arrives for an unclaimed branch).
- **PR data lives on the task**: the task actor stores PR metadata (number, title, state, url, isDraft, authorLogin, etc.) as part of its state, not as a separate entity
- **One type**: `WorkbenchTaskSummary` includes full PR fields (nullable). No separate `WorkbenchOpenPrSummary`.
- **One event**: `organizationUpdated` carries task summaries that include PR data. No separate PR events.
- **No synthetic IDs**: every item in the sidebar is a real task with a real taskId

### Changes needed

1. **Remove `WorkbenchOpenPrSummary` type** from `packages/shared/src/workbench.ts` — merge its fields into `WorkbenchTaskSummary`
2. **Expand task's `pullRequest` field** from `{ number, status }` to full PR metadata (number, title, state, url, headRefName, baseRefName, isDraft, authorLogin, updatedAtMs)
3. **Remove `openPullRequests` from `OrganizationSummarySnapshot`** — all items are tasks now
4. **Remove PR-specific events** from `realtime-events.ts`: `pullRequestUpdated`, `pullRequestRemoved`
5. **Remove PR-specific actions** from organization actor: `applyOpenPullRequestUpdate`, `removeOpenPullRequest`
6. **Remove branch-claiming filter logic** in org actor (the `if task claims branch, skip PR` check)
7. **GitHub data actor PR sync**: when PRs arrive (webhook or sync), create/update a task for that branch lazily via the repository coordinator
8. **Task actor**: store PR metadata in its DB (new columns or table), update when GitHub data pushes changes
9. **Frontend**: remove `toOpenPrTaskModel` conversion, remove `pr:` ID prefix hack, remove separate `openPullRequests` state — sidebar is just tasks
10. **Repository actor**: when a PR arrives for a branch with no task, lazily create a task actor for it (lightweight, no sandbox needed)

### Implications for coordinator pattern (item 13)

This reinforces: repo is the coordinator for tasks. When GitHub data detects a new PR for a branch, it tells the repo coordinator, which creates/updates the task. The task holds the PR data and pushes its summary to the repo coordinator.

### No backwards compatibility needed

The `authSessionIndex`, `authEmailIndex`, `authAccountIndex`, and `authVerification` tables stay on the org actor. They're routing indexes needed by the Better Auth adapter to resolve user identity before the user actor can be accessed (e.g. session token → userId lookup). Already covered in item 2 for adding comments explaining this.

---

## [ ] 16. Chunk GitHub data sync and publish progress

**Rationale:** `runFullSync` in the github-data actor fetches everything at once (all repos, branches, members, PRs), replaces all tables atomically, and has a 5-minute timeout. For large orgs this will timeout or lose all data mid-sync (replace pattern deletes everything first). Needs to be chunked with incremental progress.

### Current state (broken for large orgs)

- `runFullSync()` (`github-data/index.ts` line 486-538):
  1. Fetches ALL repos, branches, members, PRs in 4 sequential calls
  2. `replaceRepositories/Branches/Members/PullRequests` — deletes all rows then inserts all new rows
  3. Single 5-minute timeout wraps the entire operation
  4. No progress reporting to the client — just "Syncing GitHub data..." → "Synced N repositories"
  5. If it fails mid-sync, data is partially deleted with no recovery

### Changes needed

1. **Chunk the sync by repository** — sync repos first (paginated from GitHub API), then for each repo chunk, sync its branches and PRs. Members can be a separate chunk.

2. **Incremental upsert, not replace** — don't delete-then-insert. Use upsert per row so partial sync doesn't lose data. Mark rows with a sync generation ID; after full sync completes, delete rows from previous generations.

3. **Run in a loop, not a single step** — each chunk is a separate workflow step with its own timeout. If one chunk fails, previous chunks are persisted.

4. **Publish progress per chunk** — after each chunk completes:
   - Update `github_meta` with progress (e.g. `syncedRepos: 15/42`)
   - Push progress to the organization actor
   - Organization broadcasts to clients so the UI shows progress (e.g. "Syncing repositories... 15/42")

5. **Initial sync uses the same chunked approach** — `github-data-initial-sync` step should kick off the chunked loop, not call `runFullSync` directly

### Files to change

- **`foundry/packages/backend/src/actors/github-data/index.ts`**:
  - Refactor `runFullSync` into chunked loop
  - Replace `replaceRepositories/Branches/Members/PullRequests` with upsert + generation sweep
  - Add progress metadata to `github_meta` table
  - Publish progress to org actor after each chunk
- **`foundry/packages/backend/src/actors/github-data/db/schema.ts`** — add sync generation column to all tables, add progress fields to `github_meta`
- **`foundry/packages/backend/src/actors/organization/actions.ts`** (or `app-shell.ts`) — handle sync progress updates and broadcast to clients
- **`foundry/packages/shared/src/app-shell.ts`** — add sync progress fields to `FoundryGithubState` (e.g. `syncProgress: { current: number; total: number } | null`)
- **`foundry/packages/frontend/`** — show sync progress in UI (e.g. "Syncing repositories... 15/42")

---

---

# Deferred follow-up outside this task

## 17. Type all actor context parameters — remove `c: any`

**Rationale:** 272+ instances of `c: any`, `ctx: any`, `loopCtx: any` across all actor code. This eliminates type safety for DB access, state access, broadcasts, and queue operations. All context parameters should use RivetKit's proper context types.

### Scope (by file, approximate count)

| File | `any` contexts |
|---|---|
| `organization/app-shell.ts` | ~108 |
| `organization/actions.ts` | ~56 |
| `task/workbench.ts` | ~53 |
| `github-data/index.ts` | ~23 |
| `repository/actions.ts` | ~22 |
| `sandbox/index.ts` | ~21 |
| `handles.ts` | ~19 |
| `task/workflow/commands.ts` | ~10 |
| `task/workflow/init.ts` | ~4 |
| `auth-user/index.ts` | ~2 |
| `history/index.ts` | ~2 |
| `task/workflow/index.ts` | ~2 |
| `task/workflow/common.ts` | ~2 |
| `task/workflow/push.ts` | ~1 |
| `polling.ts` | ~1 |

### Changes needed

1. **Determine correct RivetKit context types** — check RivetKit exports for `ActionContext`, `ActorContextOf`, `WorkflowContext`, `LoopContext`, or equivalent. Reference `polling.ts` which already defines typed contexts (`PollingActorContext<TState>`, `WorkflowPollingActorContext<TState>`).

2. **Define per-actor context types** — each actor has its own state shape and DB schema, so the context type should be specific (e.g. `ActionContext<typeof organization>` or similar).

3. **Replace all `c: any`** with the proper typed context across every file listed above.

4. **Type workflow/loop contexts** — `ctx: any` in workflow functions and `loopCtx: any` in loop callbacks need proper types too.

### CLAUDE.md update

- **`foundry/packages/backend/CLAUDE.md`** — add constraint: "All actor context parameters (`c`, `ctx`, `loopCtx`) must be properly typed using RivetKit's context types. Never use `any` for actor contexts. Each actor should define or derive its context type from the actor definition."

---

## [ ] 18. Final pass: remove all dead code

**Dependencies:** all other items (do this last, after 17)

**Rationale:** After completing all changes above, many actions, queues, SQLite tables, workflow steps, shared types, and helper functions will be orphaned. Do a full scan to find and remove everything that's dead.

### Scope

Scan the entire foundry codebase for:
- **Dead actions** — actions with no callers (client, other actors, services, HTTP endpoints)
- **Dead queues** — queue message types with no senders
- **Dead SQLite tables** — tables with no reads or writes
- **Dead workflow steps** — step names that are no longer referenced
- **Dead shared types** — types in `packages/shared` that are no longer imported
- **Dead helper functions** — private functions with no callers
- **Dead imports** — unused imports across all files

### When to do this

After all items 1–17 are complete. Not before — removing code while other items are in progress will create conflicts.

---

## [ ] 19. Remove duplicate data between `c.state` and SQLite

**Dependencies:** items 21, 24

**Rationale:** Several actors store the same data in both `c.state` (RivetKit durable state) and their SQLite tables. Mutable fields that exist in both can silently diverge — `c.state` becomes stale when the SQLite copy is updated. Per the existing CLAUDE.md rule, `c.state` should hold only small scalars/identifiers; anything queryable or mutable belongs in SQLite.

### Duplicates found

**Task actor** — `c.state` (`createState` in `task/index.ts` lines 124-139) vs `task`/`taskRuntime` tables:

| Field | In SQLite? | Mutable? | Verdict |
|---|---|---|---|
| `organizationId` | No | No | **KEEP** — identity field |
| `repoId` | No | No | **KEEP** — identity field |
| `taskId` | No | No | **KEEP** — identity field |
| `repoRemote` | No (but org `repos` table has it) | No | **DELETE** — not needed on task, read from repo/org |
| `branchName` | Yes (`task.branch_name`) | Yes | **REMOVE from c.state** — HIGH risk, goes stale on rename |
| `title` | Yes (`task.title`) | Yes | **REMOVE from c.state** — HIGH risk, goes stale on rename |
| `task` (description) | Yes (`task.task`) | No | **REMOVE from c.state** — redundant |
| `sandboxProviderId` | Yes (`task.sandbox_provider_id`) | No | **REMOVE from c.state** — redundant |
| `agentType` | Yes (`task.agent_type`) | Yes | **DELETE entirely** — session-specific (item 21) |
| `explicitTitle` | No | No | **MOVE to SQLite** — creation metadata |
| `explicitBranchName` | No | No | **MOVE to SQLite** — creation metadata |
| `initialPrompt` | No | No | **DELETE entirely** — dead code, session-specific (item 21) |
| `initialized` | No | Yes | **DELETE entirely** — dead code, `status` already tracks init progress |
| `previousStatus` | No | No | **DELETE entirely** — never set, never read |

**Repository actor** — `c.state` (`createState` in `repository/index.ts`) vs `repoMeta` table:

| Field | Mutable? | Risk |
|---|---|---|
| `remoteUrl` | No | Low — redundant but safe |

### Fix

Remove all duplicated fields from `c.state`. Keep only identity fields needed for actor key resolution (e.g. `organizationId`, `repoId`, `taskId`). Read mutable data from SQLite.

**Task actor `c.state` should become:**
```typescript
createState: (_c, input) => ({
  organizationId: input.organizationId,
  repoId: input.repoId,
  taskId: input.taskId,
})
```

Fields already in SQLite (`branchName`, `title`, `task`, `sandboxProviderId`) — remove from `c.state`, read from SQLite only. Fields not yet in SQLite (`explicitTitle`, `explicitBranchName`) — add to `task` table, remove from `c.state`. Dead code to delete entirely: `agentType`, `initialPrompt` (item 21), `initialized`, `previousStatus`, `repoRemote`.

**Repository actor `c.state` should become:**
```typescript
createState: (_c, input) => ({
  organizationId: input.organizationId,
  repoId: input.repoId,
})
```

`remoteUrl` is removed from repo actor `c.state` entirely. The repo actor reads `remoteUrl` from its own `repoMeta` SQLite table when needed. The org actor already stores `remoteUrl` in its `repos` table (source of truth from GitHub data). The `getOrCreateRepository()` helper in `handles.ts` currently requires `remoteUrl` as a parameter and passes it as `createWithInput` — this parameter must be removed. Every call site in `organization/actions.ts` and `organization/app-shell.ts` currently does a DB lookup for `remoteUrl` just to pass it to `getOrCreateRepository()` — all of those lookups go away. On actor creation, the repo actor should populate its `repoMeta.remoteUrl` by querying the org actor or github-data actor, not by receiving it as a create input.

### Files to change

- **`foundry/packages/backend/src/actors/task/index.ts`** — trim `createState`, update all `c.state.*` reads for removed fields to read from SQLite instead
- **`foundry/packages/backend/src/actors/task/workbench.ts`** — update `c.state.*` reads
- **`foundry/packages/backend/src/actors/task/workflow/*.ts`** — update `c.state.*` reads
- **`foundry/packages/backend/src/actors/repository/index.ts`** — trim `createState`, remove `remoteUrl` from input type
- **`foundry/packages/backend/src/actors/repository/actions.ts`** — update all `c.state.remoteUrl` reads to query `repoMeta` table; remove `persistRemoteUrl()` helper
- **`foundry/packages/backend/src/actors/handles.ts`** — remove `remoteUrl` parameter from `getOrCreateRepository()`
- **`foundry/packages/backend/src/actors/organization/actions.ts`** — remove all `remoteUrl` lookups done solely to pass to `getOrCreateRepository()` (~10 call sites)
- **`foundry/packages/backend/src/actors/organization/app-shell.ts`** — same cleanup for app-shell call sites

### CLAUDE.md update

- **`foundry/packages/backend/CLAUDE.md`** — add constraint: "Never duplicate data between `c.state` and SQLite. `c.state` holds only immutable identity fields needed for actor key resolution (e.g. `organizationId`, `repoId`, `taskId`). All mutable data and anything queryable must live exclusively in SQLite. If a field can change after actor creation, it must not be in `c.state`."

---

## [ ] 20. Prefix all admin/recovery actions with `admin`

**Rationale:** Several actions are admin-only recovery/rebuild operations but their names don't distinguish them from normal product flows. Prefix with `admin` so it's immediately clear these are not part of regular user flows.

### Actions to rename

**Organization actor:**

| Current name | New name | Why it's admin |
|---|---|---|
| `reconcileWorkbenchState` | `adminReconcileWorkbenchState` | Full fan-out rebuild of task summary projection |
| `reloadGithubOrganization` | `adminReloadGithubOrganization` | Manual trigger to refetch all org GitHub data |
| `reloadGithubPullRequests` | `adminReloadGithubPullRequests` | Manual trigger to refetch all PR data |
| `reloadGithubRepository` | `adminReloadGithubRepository` | Manual trigger to refetch single repo |
| `reloadGithubPullRequest` | `adminReloadGithubPullRequest` | Manual trigger to refetch single PR |

**GitHub Data actor:**

| Current name | New name | Why it's admin |
|---|---|---|
| `fullSync` | `adminFullSync` | Full replace of all GitHub data — recovery operation |
| `reloadOrganization` | `adminReloadOrganization` | Triggers full sync manually |
| `reloadAllPullRequests` | `adminReloadAllPullRequests` | Triggers full sync manually |
| `clearState` | `adminClearState` | Deletes all GitHub data — recovery from lost access |

**NOT renamed** (these are triggered by webhooks/normal flows, not manual admin actions):
- `reloadRepository` — called by push/create/delete webhooks (incremental, normal flow)
- `reloadPullRequest` — called by PR webhooks (incremental, normal flow)
- `handlePullRequestWebhook` — webhook handler (normal flow)
- `syncGithubOrganizations` — called during OAuth callback (normal flow, though also used for repair)

### Files to change

- **`foundry/packages/backend/src/actors/github-data/index.ts`** — rename actions
- **`foundry/packages/backend/src/actors/organization/actions.ts`** — rename actions
- **`foundry/packages/client/src/backend-client.ts`** — update method names
- **`foundry/packages/frontend/`** — update any references to renamed actions

### CLAUDE.md update

- **`foundry/packages/backend/CLAUDE.md`** — add constraint: "Admin-only actions (recovery, rebuild, manual resync, state reset) must be prefixed with `admin` (e.g. `adminReconcileState`, `adminClearState`). This makes it clear they are not part of normal product flows and should not be called from regular client code paths."

---

## [ ] 21. Remove legacy/session-scoped fields from task table

**Rationale:** The `task` table has fields that either belong on the session, are redundant with data from other actors, or are dead code from the removed local git clone. These should be cleaned up.

### Fields to remove from `task` table and `c.state`

**`agentType`** — Legacy from when task = 1 session. Only used for `defaultModelForAgent(c.state.agentType)` to pick the default model when creating a new session. Sessions already have their own `model` column in `taskWorkbenchSessions`. The default model for new sessions should come from user settings (see item 16 — starred model stored in user actor). Remove `agentType` from task table, `c.state`, `createState`, `TaskRecord`, and all `defaultModelForAgent()` call sites. Replace with user settings lookup.

**`initialPrompt`** — Stored on `c.state` at task creation but **never read anywhere**. Completely dead code. This is also session-specific, not task-specific — the initial prompt belongs on the first session, not the task. Remove from `c.state`, `createState` input type, and `CreateTaskCommand`/`CreateTaskInput` types. Remove from `repository/actions.ts` create flow.

**`prSubmitted`** — Redundant boolean set when `submitPullRequest` runs. PR state already flows from GitHub webhooks → github-data actor → branch name lookup. This boolean can go stale (PR closed and reopened, PR deleted, etc.). Remove entirely — PR existence is derivable from github-data by branch name (already how `enrichTaskRecord` and `buildTaskSummary` work).

### Dead fields on `taskRuntime` table

**`provisionStage`** — Values: `"queued"`, `"ready"`, `"error"`. Redundant with `status` — `init_complete` implies ready, `error` implies error. Never read in business logic. Delete.

**`provisionStageUpdatedAt`** — Timestamp for `provisionStage` changes. Never read anywhere. Delete.

### Dead fields on `TaskRecord` (in `workflow/common.ts`)

These are always hardcoded to `null` — remnants of the removed local git clone:

- `diffStat` — was populated from `branches` table (deleted)
- `hasUnpushed` — was populated from `branches` table (deleted)
- `conflictsWithMain` — was populated from `branches` table (deleted)
- `parentBranch` — was populated from `branches` table (deleted)

Remove from `TaskRecord` type, `getCurrentRecord()`, and all consumers (contracts, mock client, tests, frontend).

### Files to change

- **`foundry/packages/backend/src/actors/task/db/schema.ts`** — remove `agentType` and `prSubmitted` columns from `task` table; remove `provisionStage` and `provisionStageUpdatedAt` from `taskRuntime` table
- **`foundry/packages/backend/src/actors/task/index.ts`** — remove `agentType`, `initialPrompt`, `initialized`, `previousStatus`, `repoRemote` from `createState` and input type
- **`foundry/packages/backend/src/actors/task/workbench.ts`** — remove `defaultModelForAgent()`, `agentTypeForModel()`, update session creation to use user settings for default model; remove `prSubmitted` set in `submitPullRequest`
- **`foundry/packages/backend/src/actors/task/workflow/common.ts`** — remove `agentType`, `prSubmitted`, `diffStat`, `hasUnpushed`, `conflictsWithMain`, `parentBranch` from `getCurrentRecord()` and `TaskRecord` construction
- **`foundry/packages/backend/src/actors/task/workflow/init.ts`** — remove `agentType` from task row inserts
- **`foundry/packages/shared/src/contracts.ts`** — remove `agentType`, `prSubmitted`, `diffStat`, `prUrl`, `hasUnpushed`, `conflictsWithMain`, `parentBranch` from `TaskRecord` schema (note: `prUrl` and `prAuthor` should stay if still populated by `enrichTaskRecord`, or move to the unified task/PR model from item 15)
- **`foundry/packages/client/src/mock/backend-client.ts`** — update mock to remove dead fields
- **`foundry/packages/client/test/view-model.test.ts`** — update test fixtures
- **`foundry/packages/frontend/src/features/tasks/model.test.ts`** — update test fixtures
- **`foundry/packages/backend/src/actors/organization/actions.ts`** — remove any references to `agentType` in task creation input
- **`foundry/packages/backend/src/actors/repository/actions.ts`** — update `enrichTaskRecord()` to stop setting dead fields

---

## [ ] 22. Move per-user UI state from task actor to user actor

**Dependencies:** item 1

**Rationale:** The task actor stores UI-facing state that is user-specific, not task-global. With multiplayer (multiple users viewing the same task), this breaks — each user has their own active session, their own unread state, their own drafts. These must live on the user actor, keyed by `(taskId, sessionId)`, not on the shared task actor.

### Per-user state currently on the task actor (wrong)

**`taskRuntime.activeSessionId`** — Which session the user is "looking at." Used to:
- Determine which session's status drives the task-level status (running/idle) — this is wrong, the task status should reflect ALL sessions, not one user's active tab
- Return a "current" session in `attachTask` responses — this is per-user
- Migration path for legacy single-session tasks in `ensureWorkbenchSeeded`

This should move to the user actor as `activeSessionId` per `(userId, taskId)`.

**`taskWorkbenchSessions.unread`** — Per-user unread state stored globally on the session. If user A reads a session, user B's unread state is also cleared. Move to user actor keyed by `(userId, taskId, sessionId)`.

**`taskWorkbenchSessions.draftText` / `draftAttachmentsJson` / `draftUpdatedAt`** — Per-user draft state stored globally. If user A starts typing a draft, it overwrites user B's draft. Move to user actor keyed by `(userId, taskId, sessionId)`.

### What stays on the task actor (correct — task-global state)

- `taskRuntime.activeSandboxId` — which sandbox is running (global to the task)
- `taskRuntime.activeSwitchTarget` / `activeCwd` — sandbox connection state (global)
- `taskRuntime.statusMessage` — provisioning/runtime status (global)
- `taskWorkbenchSessions.model` — which model the session uses (global)
- `taskWorkbenchSessions.status` — session runtime status (global)
- `taskWorkbenchSessions.transcriptJson` — session transcript (global)

### Fix

Add a `userTaskState` table to the user actor:

```typescript
export const userTaskState = sqliteTable("user_task_state", {
  taskId: text("task_id").notNull(),
  sessionId: text("session_id").notNull(),
  activeSessionId: text("active_session_id"),  // per-user active tab
  unread: integer("unread").notNull().default(0),
  draftText: text("draft_text").notNull().default(""),
  draftAttachmentsJson: text("draft_attachments_json").notNull().default("[]"),
  draftUpdatedAt: integer("draft_updated_at"),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({
  pk: primaryKey(table.taskId, table.sessionId),
}));
```

Remove `activeSessionId` from `taskRuntime`. Remove `unread`, `draftText`, `draftAttachmentsJson`, `draftUpdatedAt` from `taskWorkbenchSessions`.

The task-level status should be derived from ALL sessions (e.g., task is "running" if ANY session is running), not from one user's `activeSessionId`.

### Files to change

- **`foundry/packages/backend/src/actors/auth-user/db/schema.ts`** — add `userTaskState` table
- **`foundry/packages/backend/src/actors/task/db/schema.ts`** — remove `activeSessionId` from `taskRuntime`; remove `unread`, `draftText`, `draftAttachmentsJson`, `draftUpdatedAt` from `taskWorkbenchSessions`
- **`foundry/packages/backend/src/actors/task/workbench.ts`** — remove all `activeSessionId` reads/writes; remove draft/unread mutation functions; task status derivation should check all sessions
- **`foundry/packages/backend/src/actors/task/workflow/common.ts`** — remove `activeSessionId` from `getCurrentRecord()`
- **`foundry/packages/backend/src/actors/task/workflow/commands.ts`** — remove `activeSessionId` references in `attachTask`
- **`foundry/packages/backend/src/actors/task/workflow/init.ts`** — remove `activeSessionId` initialization
- **`foundry/packages/client/`** — draft/unread/activeSession operations route to user actor instead of task actor
- **`foundry/packages/frontend/`** — update subscription to fetch per-user state from user actor

### CLAUDE.md update

- **`foundry/packages/backend/CLAUDE.md`** — add constraint: "Per-user UI state (active session tab, unread counts, draft text, draft attachments) must live on the user actor, not on shared task/session actors. Task actors hold only task-global state visible to all users. This is critical for multiplayer correctness — multiple users may view the same task simultaneously with different active sessions, unread states, and in-progress drafts."

---

## [ ] 23. Delete `getTaskEnriched` and `enrichTaskRecord` (dead code)

**Rationale:** `getTaskEnriched` is dead code with zero callers from the client. It's also the worst fan-out pattern in the codebase: org → repo actor → task actor (`.get()`) → github-data actor (`listPullRequestsForRepository` fetches ALL PRs, then `.find()`s by branch name). This is exactly the pattern the coordinator model eliminates — task detail comes from `getTaskDetail` on the task actor, sidebar data comes from materialized `taskSummaries` on the org actor.

### What to delete

- **`enrichTaskRecord()`** — `repository/actions.ts:117-143`. Fetches all PRs for a repo to find one by branch name. Dead code.
- **`getTaskEnriched` action** — `repository/actions.ts:432-450`. Only caller of `enrichTaskRecord`. Dead code.
- **`getTaskEnriched` org proxy** — `organization/actions.ts:838-849`. Only caller of the repo action. Dead code.
- **`GetTaskEnrichedCommand` type** — wherever defined.

### Files to change

- **`foundry/packages/backend/src/actors/repository/actions.ts`** — delete `enrichTaskRecord()` and `getTaskEnriched` action
- **`foundry/packages/backend/src/actors/organization/actions.ts`** — delete `getTaskEnriched` proxy action

---

## [ ] 24. Clean up task status tracking

**Dependencies:** item 21

**Rationale:** Task status tracking is spread across `c.state`, the `task` SQLite table, and the `taskRuntime` table with redundant and dead fields. Consolidate to a single `status` enum on the `task` table. Remove `statusMessage` — human-readable status text should be derived on the client from the `status` enum, not stored on the backend.

### Fields to delete

| Field | Location | Why |
|---|---|---|
| `initialized` | `c.state` | Dead code — never read. `status` already tracks init progress. |
| `previousStatus` | `c.state` | Dead code — never set, never read. |
| `statusMessage` | `taskRuntime` table | Client concern — the client should derive display text from the `status` enum. The backend should not store UI copy. |
| `provisionStage` | `taskRuntime` table | Redundant — `status` already encodes provision progress (`init_bootstrap_db` → `init_enqueue_provision` → `init_complete`). |
| `provisionStageUpdatedAt` | `taskRuntime` table | Dead — never read. |

### What remains

- **`status`** on the `task` table — the single canonical state machine enum. Values: `init_bootstrap_db`, `init_enqueue_provision`, `init_complete`, `running`, `idle`, `error`, `archive_*`, `kill_*`, `archived`, `killed`.

### Files to change

- **`foundry/packages/backend/src/actors/task/db/schema.ts`** — remove `statusMessage`, `provisionStage`, `provisionStageUpdatedAt` from `taskRuntime` table
- **`foundry/packages/backend/src/actors/task/index.ts`** — remove `initialized`, `previousStatus` from `createState`
- **`foundry/packages/backend/src/actors/task/workflow/common.ts`** — remove `statusMessage` parameter from `setTaskState()`, remove it from `getCurrentRecord()` query
- **`foundry/packages/backend/src/actors/task/workflow/init.ts`** — remove `statusMessage`, `provisionStage`, `provisionStageUpdatedAt` from taskRuntime inserts/updates; remove `ensureTaskRuntimeCacheColumns()` raw ALTER TABLE for these columns
- **`foundry/packages/backend/src/actors/task/workflow/commands.ts`** — remove `statusMessage` from handler updates
- **`foundry/packages/backend/src/actors/task/workflow/push.ts`** — remove `statusMessage` updates
- **`foundry/packages/backend/src/actors/task/workbench.ts`** — remove `statusMessage` from `buildTaskDetail()`, remove `ensureTaskRuntimeCacheColumns()` for these columns
- **`foundry/packages/shared/src/workbench.ts`** — remove `statusMessage` from `WorkbenchTaskDetail`
- **`foundry/packages/frontend/`** — derive display text from `status` enum instead of reading `statusMessage`

---

## [ ] 25. Remove "Workbench" prefix from all types, functions, files, and tables

**Rationale:** "Workbench" is not a real concept in the system. It's a namespace prefix applied to every type, function, file, and table name. The actual entities are Task, Session, Repository, Sandbox, Transcript, Draft, etc. — "Workbench" adds zero information and obscures what things actually are.

### Rename strategy

Drop "Workbench" everywhere. If the result collides with an existing name (e.g., auth `Session`), use the domain prefix (e.g., `TaskSession` vs auth `Session`).

### Type renames (`shared/src/workbench.ts`)

| Before | After |
|---|---|
| `WorkbenchTaskStatus` | `TaskStatus` (already exists as base, merge) |
| `WorkbenchAgentKind` | `AgentKind` |
| `WorkbenchModelId` | `ModelId` |
| `WorkbenchSessionStatus` | `SessionStatus` |
| `WorkbenchTranscriptEvent` | `TranscriptEvent` |
| `WorkbenchComposerDraft` | `ComposerDraft` |
| `WorkbenchSessionSummary` | `SessionSummary` |
| `WorkbenchSessionDetail` | `SessionDetail` |
| `WorkbenchFileChange` | `FileChange` |
| `WorkbenchFileTreeNode` | `FileTreeNode` |
| `WorkbenchLineAttachment` | `LineAttachment` |
| `WorkbenchHistoryEvent` | `HistoryEvent` |
| `WorkbenchDiffLineKind` | `DiffLineKind` |
| `WorkbenchParsedDiffLine` | `ParsedDiffLine` |
| `WorkbenchPullRequestSummary` | `PullRequestSummary` |
| `WorkbenchOpenPrSummary` | `OpenPrSummary` |
| `WorkbenchSandboxSummary` | `SandboxSummary` |
| `WorkbenchTaskSummary` | `TaskSummary` |
| `WorkbenchTaskDetail` | `TaskDetail` |
| `WorkbenchRepositorySummary` | `RepositorySummary` |
| `WorkbenchSession` | `TaskSession` (avoids auth `Session` collision) |
| `WorkbenchTask` | `TaskSnapshot` (avoids `task` table collision) |
| `WorkbenchRepo` | `RepoSnapshot` |
| `WorkbenchRepositorySection` | `RepositorySection` |
| `TaskWorkbenchSnapshot` | `DashboardSnapshot` |
| `WorkbenchModelOption` | `ModelOption` |
| `WorkbenchModelGroup` | `ModelGroup` |
| `TaskWorkbenchSelectInput` | `SelectTaskInput` |
| `TaskWorkbenchCreateTaskInput` | `CreateTaskInput` |
| `TaskWorkbenchRenameInput` | `RenameTaskInput` |
| `TaskWorkbenchSendMessageInput` | `SendMessageInput` |
| `TaskWorkbenchSessionInput` | `SessionInput` |
| `TaskWorkbenchRenameSessionInput` | `RenameSessionInput` |
| `TaskWorkbenchChangeModelInput` | `ChangeModelInput` |
| `TaskWorkbenchUpdateDraftInput` | `UpdateDraftInput` |
| `TaskWorkbenchSetSessionUnreadInput` | `SetSessionUnreadInput` |
| `TaskWorkbenchDiffInput` | `DiffInput` |
| `TaskWorkbenchCreateTaskResponse` | `CreateTaskResponse` |
| `TaskWorkbenchAddSessionResponse` | `AddSessionResponse` |

### File renames

| Before | After |
|---|---|
| `shared/src/workbench.ts` | `shared/src/types.ts` (or split into `task.ts`, `session.ts`, etc.) |
| `backend/src/actors/task/workbench.ts` | `backend/src/actors/task/sessions.ts` (already planned in item 7) |
| `client/src/workbench-client.ts` | `client/src/task-client.ts` |
| `client/src/workbench-model.ts` | `client/src/model.ts` |
| `client/src/remote/workbench-client.ts` | `client/src/remote/task-client.ts` |
| `client/src/mock/workbench-client.ts` | `client/src/mock/task-client.ts` |

### Table rename

| Before | After |
|---|---|
| `task_workbench_sessions` | `task_sessions` |

### Function renames (backend — drop "Workbench" infix)

All functions in `backend/src/actors/task/workbench.ts`:
- `createWorkbenchSession` → `createSession`
- `closeWorkbenchSession` → `closeSession`
- `changeWorkbenchModel` → `changeModel`
- `sendWorkbenchMessage` → `sendMessage`
- `stopWorkbenchSession` → `stopSession`
- `renameWorkbenchBranch` → deleted (see item 26)
- `renameWorkbenchTask` → `renameTask`
- `renameWorkbenchSession` → `renameSession`
- `revertWorkbenchFile` → `revertFile`
- `publishWorkbenchPr` → `publishPr`
- `updateWorkbenchDraft` → `updateDraft`
- `setWorkbenchSessionUnread` → `setSessionUnread`
- `markWorkbenchUnread` → `markUnread`
- `syncWorkbenchSessionStatus` → `syncSessionStatus`
- `ensureWorkbenchSeeded` → `ensureSessionSeeded`

### Queue/command type renames (backend)

- `TaskWorkbenchValueCommand` → `TaskValueCommand`
- `TaskWorkbenchSessionTitleCommand` → `SessionTitleCommand`
- `TaskWorkbenchSessionUnreadCommand` → `SessionUnreadCommand`

### Scope

~420 occurrences across shared (35+ types), backend (200+ refs), client (324 refs), frontend (96 refs). Mechanical find-and-replace once the rename map is settled.

### Files to change

- **`foundry/packages/shared/src/workbench.ts`** — rename file, rename all exported types
- **`foundry/packages/shared/src/index.ts`** — update re-export path
- **`foundry/packages/shared/src/app-shell.ts`** — update `WorkbenchModelId` → `ModelId` import
- **`foundry/packages/shared/src/realtime-events.ts`** — update all `Workbench*` type imports
- **`foundry/packages/backend/src/actors/task/workbench.ts`** — rename file + all functions
- **`foundry/packages/backend/src/actors/task/index.ts`** — update imports and action registrations
- **`foundry/packages/backend/src/actors/task/db/schema.ts`** — rename `taskWorkbenchSessions` → `taskSessions`
- **`foundry/packages/backend/src/actors/task/workflow/`** — update all workbench references
- **`foundry/packages/backend/src/actors/organization/`** — update type imports and action names
- **`foundry/packages/backend/src/actors/repository/`** — update type imports
- **`foundry/packages/client/src/`** — rename files + update all type/function references
- **`foundry/packages/frontend/src/`** — update all type imports

### CLAUDE.md update

Update `foundry/packages/backend/CLAUDE.md` coordinator hierarchy diagram: `taskWorkbenchSessions` → `taskSessions`.

---

## [ ] 26. Delete branch rename (branches immutable after creation)

**Dependencies:** item 25

**Rationale:** Branch name is assigned once at task creation and never changes. Branch rename is unused in the frontend UI and SDK, adds ~80 lines of code, and creates a transactional consistency risk (git rename succeeds but index update fails).

### Delete

- **`task/workbench.ts`** — delete `renameWorkbenchBranch()` (~50 lines)
- **`task/index.ts`** — delete `renameWorkbenchBranch` action
- **`task/workflow/queue.ts`** — remove `"task.command.workbench.rename_branch"` queue type
- **`task/workflow/index.ts`** — remove `"task.command.workbench.rename_branch"` handler
- **`organization/actions.ts`** — delete `renameWorkbenchBranch` proxy action
- **`repository/actions.ts`** — delete `registerTaskBranch` action (only caller was rename flow)
- **`client/src/workbench-client.ts`** — remove `renameBranch` from interface
- **`client/src/remote/workbench-client.ts`** — delete `renameBranch()` method
- **`client/src/mock/workbench-client.ts`** — delete `renameBranch()` method
- **`client/src/backend-client.ts`** — delete `renameWorkbenchBranch` from interface + implementation
- **`client/src/mock/backend-client.ts`** — delete `renameWorkbenchBranch` implementation
- **`frontend/src/components/mock-layout.tsx`** — remove `renameBranch` from client interface, delete `onRenameBranch` callbacks and all `renameBranch` wiring (~8 refs)
- **`shared/src/workbench.ts`** — delete `TaskWorkbenchRenameInput` (if only used by branch rename; check if task title rename shares it)

### Keep

- `deriveFallbackTitle()` + `sanitizeBranchName()` + `resolveCreateFlowDecision()` — initial branch derivation at creation
- `registerTaskBranchMutation()` — used during task creation for `onBranch` path
- `renameWorkbenchTask()` — title rename is independent, stays
- `taskIndex` table — still the coordinator index for branch→task mapping

---

## [ ] Final audit pass (run after all items above are complete)

### Dead code scan

Already tracked in item 18: once all changes are complete, do a full scan to find dead actions, queues, SQLite tables, and workflow steps that need to be removed.

### Dead events audit

Scan all event types emitted by actors (in `packages/shared/src/realtime-events.ts` and anywhere actors call `c.broadcast()` or similar). Cross-reference against all client subscribers (in `packages/client/` and `packages/frontend/`). Remove any events that are emitted but never subscribed to by any client. This includes events that may have been superseded by the consolidated single-topic-per-actor pattern (item 14).
