# Spec: GitHub Data Actor & Webhook-Driven State

## Summary

Replace the per-repo polling PR sync actor (`ProjectPrSyncActor`) and per-repo PR cache (`prCache` table) with a single organization-scoped `github-state` actor that owns all GitHub data (repos, PRs, members). All GitHub state updates flow exclusively through webhooks, with a one-shot full sync on initial connection. Manual reload actions are exposed per-entity (org, repo, PR) for recovery from missed webhooks.

Open PRs are surfaced in the left sidebar alongside tasks via a unified organization subscription topic, with lazy task/sandbox creation when a user clicks on a PR.

## Reference Implementation

A prior implementation of the `github-state` actor exists in git checkpoint `0aca2c7` (from PR #247 "Refactor Foundry GitHub state and sandbox runtime"). This was never merged to a branch but contains working code for:

- `foundry/packages/backend/src/actors/github-state/index.ts` — full actor with DB, sync workflow, webhook handler, PR CRUD
- `foundry/packages/backend/src/actors/github-state/db/schema.ts` — `github_meta`, `github_repositories`, `github_members`, `github_pull_requests` tables
- `foundry/packages/backend/src/actors/organization/app-shell.ts` lines 1056-1180 — webhook dispatch to `githubState.handlePullRequestWebhook()` and `githubState.fullSync()`

Use `git show 0aca2c7:<path>` to read the reference files. Adapt (don't copy blindly) — the current branch structure has diverged.

## Constraints

1. **No polling.** Delete `ProjectPrSyncActor` (`actors/repository-pr-sync/`), all references to it in handles/keys/index, and the `prCache` table in `RepositoryActor`'s DB schema. Remove `prSyncStatus`/`prSyncAt` from `getRepoOverview`.
2. **Keep `ProjectBranchSyncActor`.** This polls the local git clone (not GitHub API) and is the sandbox git status mechanism. It stays.
3. **Webhooks are the sole live update path.** The only GitHub API calls happen during:
   - Initial full sync on org connection/installation
   - Manual reload actions (per-entity)
4. **GitHub does not auto-retry failed webhook deliveries** ([docs](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)). Manual reload is the recovery mechanism.
5. **No `user-github-data` actor in this spec.** OAuth/auth is already handled correctly on the current branch. Only the org-scoped `github-state` actor is in scope.

## Architecture

### Actor: `github-state` (one per organization)

**Key:** `["org", organizationId, "github"]`

**DB tables:**
- `github_meta` — sync status, installation info, connected account
- `github_repositories` — repos accessible via the GitHub App installation
- `github_pull_requests` — all open PRs across all repos in the org
- `github_members` — org members (existing from checkpoint, keep for completeness)

**Actions (from checkpoint, to adapt):**
- `fullSync(input)` — one-shot fetch of repos + PRs via installation token. Enqueues as a workflow step. Used on initial connection and `installation.created`/`unsuspend` webhooks.
- `handlePullRequestWebhook(input)` — upserts a single PR from webhook payload, notifies downstream.
- `getSummary()` — returns sync meta + row counts.
- `listRepositories()` — returns all known repos.
- `listPullRequestsForRepository({ repoId })` — returns PRs for a repo.
- `getPullRequestForBranch({ repoId, branchName })` — returns PR info for a branch.
- `createPullRequest({ repoId, repoPath, branchName, title, body })` — creates PR via GitHub API, stores locally.
- `clearState(input)` — wipes all data (on `installation.deleted`, `suspend`).

**New actions (not in checkpoint):**
- `reloadOrganization()` — re-fetches repos + members from GitHub API (not PRs). Updates `github_repositories` and `github_members`. Notifies downstream.
- `reloadRepository({ repoId })` — re-fetches metadata for a single repo from GitHub API. Updates the `github_repositories` row. Does NOT re-fetch PRs.
- `reloadPullRequest({ repoId, prNumber })` — re-fetches a single PR from GitHub API by number. Updates the `github_pull_requests` row. Notifies downstream.

### Webhook Dispatch (in app-shell)

Replace the current TODO at `app-shell.ts:1521` with dispatch logic adapted from checkpoint `0aca2c7:foundry/packages/backend/src/actors/organization/app-shell.ts` lines 1056-1180:

| Webhook event | Action |
|---|---|
| `installation.created` | `githubState.fullSync({ force: true })` |
| `installation.deleted` | `githubState.clearState(...)` |
| `installation.suspend` | `githubState.clearState(...)` |
| `installation.unsuspend` | `githubState.fullSync({ force: true })` |
| `installation_repositories` | `githubState.fullSync({ force: true })` |
| `pull_request` (any action) | `githubState.handlePullRequestWebhook(...)` |
| `push`, `create`, `delete`, `check_run`, `check_suite`, `status`, `pull_request_review`, `pull_request_review_comment` | Log for now, extend later |

### Downstream Notifications

When `github-state` receives a PR update (webhook or manual reload), it should:

1. Update its own `github_pull_requests` table
2. Call `notifyOrganizationUpdated()` → which broadcasts `organizationUpdated` to connected clients
3. If the PR branch matches an existing task's branch, update that task's `pullRequest` summary in the organization actor

### Organization Summary Changes

Extend `OrganizationSummarySnapshot` to include open PRs:

```typescript
export interface OrganizationSummarySnapshot {
  organizationId: string;
  repos: WorkbenchRepoSummary[];
  taskSummaries: WorkbenchTaskSummary[];
  openPullRequests: WorkbenchOpenPrSummary[];  // NEW
}

export interface WorkbenchOpenPrSummary {
  prId: string;              // "repoId#number"
  repoId: string;
  repoFullName: string;
  number: number;
  title: string;
  state: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  authorLogin: string | null;
  isDraft: boolean;
  updatedAtMs: number;
}
```

The organization actor fetches open PRs from the `github-state` actor when building the summary snapshot. PRs that already have an associated task (matched by branch name) should be excluded from `openPullRequests` (they already appear in `taskSummaries` with their `pullRequest` field populated).

### Interest Manager

The `organization` subscription topic already returns `OrganizationSummarySnapshot`. Adding `openPullRequests` to that type means the sidebar automatically gets PR data without a new topic.

`organizationUpdated` events should include a new variant for PR changes:
```typescript
{ type: "pullRequestUpdated", pullRequest: WorkbenchOpenPrSummary }
{ type: "pullRequestRemoved", prId: string }
```

### Sidebar Changes

The left sidebar currently renders `repositories: RepositorySection[]` where each repository has `tasks: Task[]`. Extend this to include open PRs as lightweight entries within each repository section:

- Open PRs appear in the same list as tasks, sorted by `updatedAtMs`
- PRs should be visually distinct: show PR icon instead of task indicator, display `#number` and author
- Clicking a PR creates a task lazily (creates the task + sandbox on demand), then navigates to it
- PRs that already have a task are filtered out (they show as the task instead)

This is similar to what `buildPrTasks()` does in the mock data (`workbench-model.ts:1154-1182`), but driven by real data from the `github-state` actor.

### Frontend: Manual Reload

Add a "three dots" menu button in the top-right of the sidebar header. Dropdown options:

- **Reload organization** — calls `githubState.reloadOrganization()` via backend API
- **Reload all PRs** — calls `githubState.fullSync({ force: true })` (convenience shortcut)

For per-repo and per-PR reload, add context menu options:
- Right-click a repository header → "Reload repository"
- Right-click a PR entry → "Reload pull request"

These call the corresponding `reloadRepository`/`reloadPullRequest` actions on the `github-state` actor.

## Deletions

Files/code to remove:

1. `foundry/packages/backend/src/actors/repository-pr-sync/` — entire directory
2. `foundry/packages/backend/src/actors/repository/db/schema.ts` — `prCache` table
3. `foundry/packages/backend/src/actors/repository/actions.ts` — `applyPrSyncResultMutation`, `getPullRequestForBranch` (moves to github-state), `prSyncStatus`/`prSyncAt` from `getRepoOverview`
4. `foundry/packages/backend/src/actors/handles.ts` — `getOrCreateProjectPrSync`, `selfProjectPrSync`
5. `foundry/packages/backend/src/actors/keys.ts` — any PR sync key helper
6. `foundry/packages/backend/src/actors/index.ts` — `repositoryPrSync` import and registration
7. All call sites in `RepositoryActor` that spawn or call the PR sync actor (`initProject`, `refreshProject`)

## Migration Path

The `prCache` table in `RepositoryActor`'s DB can simply be dropped — no data migration needed since the `github-state` actor will re-fetch everything on its first `fullSync`. Existing task `pullRequest` fields are populated from the github-state actor going forward.

## Implementation Order

1. Create `github-state` actor (adapt from checkpoint `0aca2c7`)
2. Wire up actor in registry, handles, keys
3. Implement webhook dispatch in app-shell (replace TODO)
4. Delete `ProjectPrSyncActor` and `prCache` from repository actor
5. Add manual reload actions to github-state
6. Extend `OrganizationSummarySnapshot` with `openPullRequests`
7. Wire through subscription manager + organization events
8. Update sidebar to render open PRs
9. Add three-dots menu with reload options
10. Update task creation flow for lazy PR→task conversion
