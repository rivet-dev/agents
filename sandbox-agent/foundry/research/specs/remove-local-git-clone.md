# Remove Local Git Clone from Backend

## Goal

The Foundry backend stores zero git state. No clones, no refs, no working trees, no git-spice. All git operations execute inside sandboxes. Repo metadata (branches, default branch, PRs) comes from GitHub API/webhooks which we already have.

## Terminology renames

Rename Foundry domain terms across the entire `foundry/` directory. All changes are breaking — no backwards compatibility needed. Execute as separate atomic commits in this order. `pnpm -w typecheck && pnpm -w build && pnpm -w test` must pass between each.

| New name | Old name (current code) |
|---|---|
| **Organization** | Workspace |
| **Repository** | Project |
| **Session** (not "tab") | Tab / Session (mixed) |
| **Subscription** | Interest |
| **SandboxProviderId** | ProviderId |

### Rename 1: `interest` → `subscription`

The realtime pub/sub system in `client/src/interest/`. Rename the directory, all types (`InterestManager` → `SubscriptionManager`, `MockInterestManager` → `MockSubscriptionManager`, `RemoteInterestManager` → `RemoteSubscriptionManager`, `DebugInterestTopic` → `DebugSubscriptionTopic`), the `useInterest` hook → `useSubscription`, and all imports in client + frontend. Rename `frontend/src/lib/interest.ts` → `subscription.ts`. Rename test file `client/test/interest-manager.test.ts` → `subscription-manager.test.ts`.

### Rename 2: `tab` → `session`

The UI "tab" concept is really a session. Rename `TabStrip` → `SessionStrip`, `tabId` → `sessionId`, `closeTab` → `closeSession`, `addTab` → `addSession`, `WorkbenchAgentTab` → `WorkbenchAgentSession`, `TaskWorkbenchTabInput` → `TaskWorkbenchSessionInput`, `TaskWorkbenchAddTabResponse` → `TaskWorkbenchAddSessionResponse`, and all related props/DOM attrs (`activeTabId` → `activeSessionId`, `onSwitchTab` → `onSwitchSession`, `onCloseTab` → `onCloseSession`, `data-tab` → `data-session`, `editingSessionTabId` → `editingSessionId`). Rename file `tab-strip.tsx` → `session-strip.tsx`. **Leave "diff tabs" alone** (`isDiffTab`, `diffTabId`) — those are file viewer panes, a different concept.

### Rename 3: `ProviderId` → `SandboxProviderId`

The `ProviderId` type (`"e2b" | "local"`) is specifically a sandbox provider. Rename the type (`ProviderId` → `SandboxProviderId`), schema (`ProviderIdSchema` → `SandboxProviderIdSchema`), and all `providerId` fields that refer to sandbox hosting (`CreateTaskInput`, `TaskRecord`, `SwitchResult`, `WorkbenchSandboxSummary`, task DB schema `task.provider_id` → `sandbox_provider_id`, `task_sandboxes.provider_id` → `sandbox_provider_id`, topic params). Rename config key `providers` → `sandboxProviders`. DB column renames need Drizzle migrations.

**Do NOT rename**: `model.provider` (AI model provider), `auth_account_index.provider_id` (auth provider), `providerAgent()` (model→agent mapping), `WorkbenchModelGroup.provider`.

Also **delete the `providerProfiles` table entirely** — it's written but never read (dead code). Remove the table definition from the organization actor DB schema, all writes in organization actions, and the `refreshProviderProfiles` queue command/handler/interface.

### Rename 4: `project` → `repository`

The "project" actor/entity is a git repository. Rename:
- Actor directory `actors/project/` → `actors/repository/`
- Actor directory `actors/project-branch-sync/` → `actors/repository-branch-sync/`
- Actor registry keys `project` → `repository`, `projectBranchSync` → `repositoryBranchSync`
- Actor name string `"Project"` → `"Repository"`
- All functions: `projectKey` → `repositoryKey`, `getOrCreateProject` → `getOrCreateRepository`, `getProject` → `getRepository`, `selfProject` → `selfRepository`, `projectBranchSyncKey` → `repositoryBranchSyncKey`, `projectPrSyncKey` → `repositoryPrSyncKey`, `projectWorkflowQueueName` → `repositoryWorkflowQueueName`
- Types: `ProjectInput` → `RepositoryInput`, `WorkbenchProjectSection` → `WorkbenchRepositorySection`, `PROJECT_QUEUE_NAMES` → `REPOSITORY_QUEUE_NAMES`
- Queue names: `"project.command.*"` → `"repository.command.*"`
- Actor key strings: change `"project"` to `"repository"` in key arrays (e.g. `["ws", id, "project", repoId]` → `["org", id, "repository", repoId]`)
- Frontend: `projects` → `repositories`, `collapsedProjects` → `collapsedRepositories`, `hoveredProjectId` → `hoveredRepositoryId`, `PROJECT_COLORS` → `REPOSITORY_COLORS`, `data-project-*` → `data-repository-*`, `groupWorkbenchProjects` → `groupWorkbenchRepositories`
- Client keys: `projectKey()` → `repositoryKey()`, `projectBranchSyncKey()` → `repositoryBranchSyncKey()`, `projectPrSyncKey()` → `repositoryPrSyncKey()`

### Rename 5: `workspace` → `organization`

The "workspace" is really an organization. Rename:
- Actor directory `actors/workspace/` → `actors/organization/`
- Actor registry key `workspace` → `organization`
- Actor name string `"Workspace"` → `"Organization"`
- All types: `WorkspaceIdSchema` → `OrganizationIdSchema`, `WorkspaceId` → `OrganizationId`, `WorkspaceEvent` → `OrganizationEvent`, `WorkspaceSummarySnapshot` → `OrganizationSummarySnapshot`, `WorkspaceUseInputSchema` → `OrganizationUseInputSchema`, `WorkspaceHandle` → `OrganizationHandle`, `WorkspaceTopicParams` → `OrganizationTopicParams`
- All `workspaceId` fields/params → `organizationId` (~20+ schemas in contracts.ts, plus topic params, task snapshot, etc.)
- `FoundryOrganization.workspaceId` → `FoundryOrganization.organizationId` (or just `id`)
- All functions: `workspaceKey` → `organizationKey`, `getOrCreateWorkspace` → `getOrCreateOrganization`, `selfWorkspace` → `selfOrganization`, `resolveWorkspaceId` → `resolveOrganizationId`, `defaultWorkspace` → `defaultOrganization`, `workspaceWorkflowQueueName` → `organizationWorkflowQueueName`, `WORKSPACE_QUEUE_NAMES` → `ORGANIZATION_QUEUE_NAMES`
- Actor key strings: change `"ws"` to `"org"` in key arrays (e.g. `["ws", id]` → `["org", id]`)
- Queue names: `"workspace.command.*"` → `"organization.command.*"`
- Topic keys: `"workspace:${id}"` → `"organization:${id}"`, event `"workspaceUpdated"` → `"organizationUpdated"`
- Methods: `connectWorkspace` → `connectOrganization`, `getWorkspaceSummary` → `getOrganizationSummary`, `useWorkspace` → `useOrganization`
- Files: `shared/src/workspace.ts` → `organization.ts`, `backend/src/config/workspace.ts` → `organization.ts`
- Config keys: `config.workspace.default` → `config.organization.default`
- URL paths: `/workspaces/$workspaceId` → `/organizations/$organizationId`
- UI strings: `"Loading workspace..."` → `"Loading organization..."`
- Tests: rename `workspace-*.test.ts` files, update `workspaceSnapshot()` → `organizationSnapshot()`, `workspaceId: "ws-1"` → `organizationId: "org-1"`

### After all renames: update CLAUDE.md files

Update `foundry/CLAUDE.md` and `foundry/packages/backend/CLAUDE.md` to use new terminology throughout (organization instead of workspace, repository instead of project, etc.). The rest of this spec already uses the new names.

## What gets deleted

### Entire directories/files

| Path (relative to `packages/backend/src/`) | Reason |
|---|---|
| `integrations/git/index.ts` | All local git operations |
| `integrations/git-spice/index.ts` | Stack management via git-spice |
| `actors/repository-branch-sync/` (currently `project-branch-sync/`) | Polling actor that fetches + reads local clone every 5s |
| `actors/project-pr-sync/` | Empty directory, already dead |
| `actors/repository/stack-model.ts` (currently `project/stack-model.ts`) | Stack parent/sort model (git-spice dependent) |
| `test/git-spice.test.ts` | Tests for deleted git-spice integration |
| `test/git-validate-remote.test.ts` | Tests for deleted git validation |
| `test/stack-model.test.ts` | Tests for deleted stack model |

### Driver interfaces removed from `driver.ts`

- `GitDriver` — entire interface deleted
- `StackDriver` — entire interface deleted
- `BackendDriver.git` — removed
- `BackendDriver.stack` — removed
- All imports from `integrations/git/` and `integrations/git-spice/`

`BackendDriver` keeps only `github` and `tmux`.

### Test driver cleanup (`test/helpers/test-driver.ts`)

- Delete `createTestGitDriver()`
- Delete `createTestStackDriver()`
- Remove `git` and `stack` from `createTestDriver()`

### Docker volume removed (`compose.dev.yaml`, `compose.preview.yaml`)

- Remove `foundry_git_repos` volume and its mount at `/root/.local/share/foundry/repos`
- Remove the CLAUDE.md note about the repos volume

### Actor registry cleanup (`actors/index.ts`, `actors/keys.ts`, `actors/handles.ts`)

- Remove `RepositoryBranchSyncActor` (currently `ProjectBranchSyncActor`) registration
- Remove `repositoryBranchSyncKey` (currently `projectBranchSyncKey`)
- Remove branch sync handle helpers

### Client key cleanup (`packages/client/src/keys.ts`, `packages/client/test/keys.test.ts`)

- Remove `repositoryBranchSyncKey` (currently `projectBranchSyncKey`) if exported

### Dead code removal: `providerProfiles` table

The `providerProfiles` table in the organization actor (currently workspace actor) DB is written but never read. Delete:

- Table definition in `actors/organization/db/schema.ts` (currently `workspace/db/schema.ts`)
- All writes in `actors/organization/actions.ts` (currently `workspace/actions.ts`)
- The `refreshProviderProfiles` queue command and handler
- The `RefreshProviderProfilesCommand` interface
- Add a DB migration to drop the `provider_profiles` table

### Ensure pattern cleanup (`actors/repository/actions.ts`, currently `project/actions.ts`)

Delete all `ensure*` functions that block action handlers on external I/O or cross-actor fan-out:

- **`ensureLocalClone()`** — Delete (git clone removal).
- **`ensureProjectReady()`** / **`ensureRepositoryReady()`** — Delete (wrapper around `ensureLocalClone` + sync actors).
- **`ensureProjectReadyForRead()`** / **`ensureRepositoryReadyForRead()`** — Delete (dispatches ensure with 10s wait on read path).
- **`ensureProjectSyncActors()`** / **`ensureRepositorySyncActors()`** — Delete (spawns branch sync actor which is being removed).
- **`forceProjectSync()`** / **`forceRepositorySync()`** — Delete (triggers branch sync actor).
- **`ensureTaskIndexHydrated()`** — Delete. This is the migration path from `HistoryActor` → `task_index` table. Since we assume fresh repositories, no migration needed. The task index is populated on write (`createTask` inserts the row).
- **`ensureTaskIndexHydratedForRead()`** — Delete (wrapper that dispatches `hydrateTaskIndex`).
- **`taskIndexHydrated` state flag** — Delete from repository actor state.

The `ensureAskpassScript()` is fine — it's a fast local operation.

### Dead schema tables and helpers (`actors/repository/db/schema.ts`, `actors/repository/actions.ts`)

With the branch sync actor and git-spice stack operations deleted, these tables have no writer and should be removed:

- **`branches` table** — populated by `RepositoryBranchSyncActor` from the local clone. Delete the table, its schema definition, and all reads from it (including `enrichTaskRecord` which reads `diffStat`, `hasUnpushed`, `conflictsWithMain`, `parentBranch` from this table).
- **`repoActionJobs` table** — populated by `runRepoStackAction()` for git-spice stack operations. Delete the table, its schema definition, and all helpers: `ensureRepoActionJobsTable()`, `writeRepoActionJob()`, `listRepoActionJobRows()`.

## What gets modified

### `actors/repository/actions.ts` (currently `project/actions.ts`)

This is the biggest change. Current git operations in this file:

1. **`createTaskMutation()`** — Currently calls `listLocalRemoteRefs` to check branch name conflicts against remote branches. Replace: branch conflict checking uses only the repository actor's `task_index` table (which branches are already taken by tasks). We don't need to check against remote branches — if the branch already exists on the remote, `git push` in the sandbox will handle it.
2. **`registerTaskBranch()`** — Currently does `fetch` + `remoteDefaultBaseRef` + `revParse` + git-spice stack tracking. Replace: default base branch comes from GitHub repo metadata (already stored from webhook/API at repo add time). SHA resolution is not needed at task creation — the sandbox handles it. Delete all git-spice stack tracking.
3. **`getRepoOverview()`** — Currently calls `listLocalRemoteRefs` + `remoteDefaultBaseRef` + `stack.available` + `stack.listStack`. Replace: branch data comes from GitHub API data we already store from webhooks (push/create/delete events feed branch state). Stack data is deleted. The overview returns branches from stored GitHub webhook data.
4. **`runRepoStackAction()`** — Delete entirely (all git-spice stack operations).
5. **All `normalizeBaseBranchName` imports from git-spice** — Inline or move to a simple utility if still needed.
6. **All `ensureTaskIndexHydrated*` / `ensureRepositoryReady*` call sites** — Remove. Read actions query the `task_index` table directly; if it's empty, it's empty. Write actions populate it on create.

### `actors/repository/index.ts` (currently `project/index.ts`)

- Remove local clone path from state/initialization
- Remove branch sync actor spawning
- Remove any `ensureLocalClone` calls in lifecycle

### `actors/task/workbench.ts`

- **`ensureSandboxRepo()` line 405**: Currently calls `driver.git.remoteDefaultBaseRef()` on the local clone. Replace: read default branch from repository actor state (which gets it from GitHub API/webhook data at repo add time).

### `actors/organization/actions.ts` (currently `workspace/actions.ts`)

- **`addRemote()` line 320**: Currently calls `driver.git.validateRemote()` which runs `git ls-remote`. Replace: validate via GitHub API — `GET /repos/{owner}/{repo}` returns 404 for invalid repos. We already parse the remote URL into owner/repo for GitHub operations.

### `actors/keys.ts` / `actors/handles.ts`

- Remove `repositoryBranchSyncKey` (currently `projectBranchSyncKey`) export
- Remove branch sync handle creation

## What stays the same

- `driver.github.*` — already uses GitHub API, no changes
- `driver.tmux.*` — unrelated, no changes
- `integrations/github/index.ts` — already GitHub API based, keeps working
- All sandbox execution (`executeInSandbox()`) — already correct pattern
- Webhook handlers for push/create/delete events — already feed GitHub data into backend

## CLAUDE.md updates

### `foundry/packages/backend/CLAUDE.md`

Remove `RepositoryBranchSyncActor` (currently `ProjectBranchSyncActor`) from the actor hierarchy tree:

```text
OrganizationActor
├─ HistoryActor(organization-scoped global feed)
├─ GithubDataActor
├─ RepositoryActor(repo)
│  └─ TaskActor(task)
│     ├─ TaskSessionActor(session) x N
│     │  └─ SessionStatusSyncActor(session) x 0..1
│     └─ Task-local workbench state
└─ SandboxInstanceActor(sandboxProviderId, sandboxId) x N
```

Add to Ownership Rules:

> - The backend stores no local git state. No clones, no refs, no working trees, no git-spice. Repo metadata (branches, default branch) comes from GitHub API and webhook events. All git operations that require a working tree execute inside sandboxes via `executeInSandbox()`.

### `foundry/CLAUDE.md`

Add a new section:

```markdown
## Git State Policy

- The backend stores **zero git state**. No local clones, no refs, no working trees, no git-spice.
- Repo metadata (branches, default branch, PRs) comes from GitHub API and webhook events already flowing into the system.
- All git operations that require a working tree (diff, push, conflict check, rev-parse) execute inside the task's sandbox via `executeInSandbox()`.
- Do not add local git clone paths, `git fetch`, `git for-each-ref`, or any direct git CLI calls to the backend. If you need git data, either read it from stored GitHub webhook/API data or run it in a sandbox.
- The `BackendDriver` has no `GitDriver` or `StackDriver`. Only `GithubDriver` and `TmuxDriver` remain.
- git-spice is not used anywhere in the system.
```

Remove from CLAUDE.md:

> - Docker dev: `compose.dev.yaml` mounts a named volume at `/root/.local/share/foundry/repos` to persist backend-managed git clones across restarts. Code must still work if this volume is not present (create directories as needed).

## Concerns

1. **Concurrent agent work**: Another agent is currently modifying `workspace/actions.ts`, `project/actions.ts`, `task/workbench.ts`, `task/workflow/init.ts`, `task/workflow/queue.ts`, `driver.ts`, and `project-branch-sync/index.ts`. Those changes are adding `listLocalRemoteRefs` to the driver and removing polling loops/timeouts. The git clone removal work will **delete** the code the other agent is modifying. Coordinate: let the other agent's changes land first, then this spec deletes the git integration entirely.

2. **Rename ordering**: The rename spec (workspace→organization, project→repository, etc.) should ideally land **before** this spec is executed, so the file paths and identifiers match. If not, the implementing agent should map old names → new names using the table above.

3. **`project-pr-sync/` directory**: This is already an empty directory. Delete it as part of cleanup.

4. **`ensureRepoActionJobsTable()`**: The current spec mentions this should stay but the `repoActionJobs` table is being deleted. Updating: both the table and the ensure function should be deleted.

## Validation

After implementation, run:

```bash
pnpm -w typecheck
pnpm -w build
pnpm -w test
```

Then restart the dev stack and run the main user flow end-to-end:

```bash
just foundry-dev-down && just foundry-dev
```

Verify:
1. Add a repo to an organization
2. Create a task (should return immediately with taskId)
3. Task appears in sidebar with pending status
4. Task provisions and transitions to ready
5. Session is created and initial message is sent
6. Agent responds in the session transcript

This must work against a real GitHub repo (`rivet-dev/sandbox-agent-testing`) with the dev environment credentials.

### Codebase grep validation

After implementation, verify no local git operations or git-spice references remain in the backend:

```bash
# No local git CLI calls (excludes integrations/github which is GitHub API, not local git)
rg -l 'execFileAsync\("git"' foundry/packages/backend/src/ && echo "FAIL: local git CLI calls found" || echo "PASS"

# No git-spice references
rg -l 'git.spice|gitSpice|git_spice' foundry/packages/backend/src/ && echo "FAIL: git-spice references found" || echo "PASS"

# No GitDriver or StackDriver references
rg -l 'GitDriver|StackDriver' foundry/packages/backend/src/ && echo "FAIL: deleted driver interfaces still referenced" || echo "PASS"

# No local clone path references
rg -l 'localPath|ensureCloned|ensureLocalClone|foundryRepoClonePath' foundry/packages/backend/src/ && echo "FAIL: local clone references found" || echo "PASS"

# No branch sync actor references
rg -l 'BranchSync|branchSync|branch.sync' foundry/packages/backend/src/ && echo "FAIL: branch sync references found" || echo "PASS"

# No deleted ensure patterns
rg -l 'ensureProjectReady|ensureTaskIndexHydrated|taskIndexHydrated' foundry/packages/backend/src/ && echo "FAIL: deleted ensure patterns found" || echo "PASS"

# integrations/git/ and integrations/git-spice/ directories should not exist
ls foundry/packages/backend/src/integrations/git/index.ts 2>/dev/null && echo "FAIL: git integration not deleted" || echo "PASS"
ls foundry/packages/backend/src/integrations/git-spice/index.ts 2>/dev/null && echo "FAIL: git-spice integration not deleted" || echo "PASS"
```

All checks must pass before the change is considered complete.

### Rename verification

After the rename spec has landed, verify no old names remain anywhere in `foundry/`:

```bash
# --- workspace → organization ---
# No "WorkspaceActor", "WorkspaceEvent", "WorkspaceId", "WorkspaceSummary", etc. (exclude pnpm-workspace.yaml, node_modules, .turbo)
rg -l 'WorkspaceActor|WorkspaceEvent|WorkspaceId|WorkspaceSummary|WorkspaceHandle|WorkspaceUseInput|WorkspaceTopicParams' foundry/packages/ && echo "FAIL: workspace type references remain" || echo "PASS"

# No workspaceId in domain code (exclude pnpm-workspace, node_modules, .turbo, this spec file)
rg -l 'workspaceId' foundry/packages/ --glob '!node_modules' --glob '!*.md' && echo "FAIL: workspaceId references remain" || echo "PASS"

# No workspace actor directory
ls foundry/packages/backend/src/actors/workspace/ 2>/dev/null && echo "FAIL: workspace actor directory not renamed" || echo "PASS"

# No workspaceKey function
rg 'workspaceKey|selfWorkspace|getOrCreateWorkspace|resolveWorkspaceId|defaultWorkspace' foundry/packages/ --glob '!node_modules' && echo "FAIL: workspace function references remain" || echo "PASS"

# No "ws" actor key string (the old key prefix)
rg '"\\"ws\\""|\["ws"' foundry/packages/ --glob '!node_modules' && echo "FAIL: old 'ws' actor key strings remain" || echo "PASS"

# No workspace queue names
rg 'workspace\.command\.' foundry/packages/ --glob '!node_modules' --glob '!*.md' && echo "FAIL: workspace queue names remain" || echo "PASS"

# No /workspaces/ URL paths
rg '/workspaces/' foundry/packages/ --glob '!node_modules' --glob '!*.md' && echo "FAIL: /workspaces/ URL paths remain" || echo "PASS"

# No config.workspace
rg 'config\.workspace' foundry/packages/ --glob '!node_modules' --glob '!*.md' && echo "FAIL: config.workspace references remain" || echo "PASS"

# --- project → repository ---
# No ProjectActor, ProjectInput, ProjectSection, etc.
rg -l 'ProjectActor|ProjectInput|ProjectSection|PROJECT_QUEUE|PROJECT_COLORS' foundry/packages/ --glob '!node_modules' && echo "FAIL: project type references remain" || echo "PASS"

# No project actor directory
ls foundry/packages/backend/src/actors/project/ 2>/dev/null && echo "FAIL: project actor directory not renamed" || echo "PASS"

# No projectKey, selfProject, getOrCreateProject, etc.
rg 'projectKey|selfProject|getOrCreateProject|getProject\b|projectBranchSync|projectPrSync|projectWorkflow' foundry/packages/ --glob '!node_modules' && echo "FAIL: project function references remain" || echo "PASS"

# No "project" actor key string
rg '"\\"project\\""|\[".*"project"' foundry/packages/ --glob '!node_modules' --glob '!*.md' && echo "FAIL: old project actor key strings remain" || echo "PASS"

# No project.command.* queue names
rg 'project\.command\.' foundry/packages/ --glob '!node_modules' --glob '!*.md' && echo "FAIL: project queue names remain" || echo "PASS"

# --- tab → session ---
# No WorkbenchAgentTab, TaskWorkbenchTabInput, TabStrip, tabId (in workbench context)
rg -l 'WorkbenchAgentTab|TaskWorkbenchTabInput|TaskWorkbenchAddTabResponse|TabStrip' foundry/packages/ --glob '!node_modules' && echo "FAIL: tab type references remain" || echo "PASS"

# No tabId (should be sessionId now)
rg '\btabId\b' foundry/packages/ --glob '!node_modules' && echo "FAIL: tabId references remain" || echo "PASS"

# No tab-strip.tsx file
ls foundry/packages/frontend/src/components/mock-layout/tab-strip.tsx 2>/dev/null && echo "FAIL: tab-strip.tsx not renamed" || echo "PASS"

# No closeTab/addTab (should be closeSession/addSession)
rg '\bcloseTab\b|\baddTab\b' foundry/packages/ --glob '!node_modules' && echo "FAIL: closeTab/addTab references remain" || echo "PASS"

# --- interest → subscription ---
# No InterestManager, useInterest, etc.
rg -l 'InterestManager|useInterest|DebugInterestTopic' foundry/packages/ --glob '!node_modules' && echo "FAIL: interest type references remain" || echo "PASS"

# No interest/ directory
ls foundry/packages/client/src/interest/ 2>/dev/null && echo "FAIL: interest directory not renamed" || echo "PASS"

# --- ProviderId → SandboxProviderId ---
# No bare ProviderId/ProviderIdSchema (but allow sandboxProviderId, model.provider, auth provider_id)
rg '\bProviderIdSchema\b|\bProviderId\b' foundry/packages/shared/src/contracts.ts && echo "FAIL: bare ProviderId in contracts.ts" || echo "PASS"

# No bare providerId for sandbox context (check task schema)
rg '\bproviderId\b' foundry/packages/backend/src/actors/task/db/schema.ts && echo "FAIL: bare providerId in task schema" || echo "PASS"

# No providerProfiles table (dead code, should be deleted)
rg 'providerProfiles|provider_profiles|refreshProviderProfiles' foundry/packages/ --glob '!node_modules' --glob '!*.md' && echo "FAIL: providerProfiles references remain" || echo "PASS"

# --- Verify new names exist ---
rg -l 'OrganizationActor|OrganizationEvent|OrganizationId' foundry/packages/ --glob '!node_modules' | head -3 || echo "WARN: new organization names not found"
rg -l 'RepositoryActor|RepositoryInput|RepositorySection' foundry/packages/ --glob '!node_modules' | head -3 || echo "WARN: new repository names not found"
rg -l 'SubscriptionManager|useSubscription' foundry/packages/ --glob '!node_modules' | head -3 || echo "WARN: new subscription names not found"
rg -l 'SandboxProviderIdSchema|SandboxProviderId' foundry/packages/ --glob '!node_modules' | head -3 || echo "WARN: new sandbox provider names not found"
```

All checks must pass. False positives from markdown files, comments referencing old names in migration context, or `node_modules` should be excluded via the globs above.
