# RivetKit + Sandbox Provider + OpenTUI Migration Spec

Status: implemented baseline (Phase 1-4 complete, Phase 5 partial)
Date: 2026-02-08

## Locked Decisions

1. Entire rewrite is TypeScript. All Rust code will be deleted at cutover.
2. Repo stays a single monorepo, managed with `pnpm` organizations + Turborepo.
3. `core` package is renamed to `shared`.
4. `integrations` and `providers` live inside the backend package (not top-level packages).
5. Rivet-backed state uses SQLite + Drizzle only.
6. RivetKit dependencies come from local `../rivet` builds only; no published npm packages.
7. Everything is organization-scoped. Organization is configurable from CLI.
8. `ControlPlaneActor` is renamed to `OrganizationActor` (organization coordinator).
9. Every actor key is prefixed by organization.
10. `--organization` is optional; commands resolve organization via flag -> config default -> `default`.
11. RivetKit local dependency wiring is `link:`-based.
12. Keep the existing config file path (`~/.config/foundry/config.toml`) and evolve keys in place.
13. `.agents` and skill files are in scope for migration updates.
14. Parent orchestration actors (`organization`, `repository`, `task`) use command-only loops with no timeout.
15. Periodic syncing/polling runs in dedicated child actors, each with a single timeout cadence.
16. For each actor, define the main loop and exactly what data it mutates; keep single-writer ownership strict.

## Executive Summary

We will replace the existing Rust backend/CLI/TUI with TypeScript services and UIs:

- Backend: RivetKit actor runtime
- Agent orchestration: Sandbox Agent through provider adapters
- CLI: TypeScript
- TUI: TypeScript + OpenTUI
- State: SQLite + Drizzle (actor-owned writes)

The core architecture changes from "worktree-per-task" to "provider-selected sandbox-per-task." Local worktrees remain supported through a `worktree` provider.

## Breaking Changes (Intentional)

1. Rust binaries/backend removed.
2. Existing IPC replaced by new TypeScript transport.
3. Configuration schema changes for organization selection and sandbox provider defaults.
4. Runtime model changes from global control plane to organization coordinator actor.
5. Database schema migrates to organization + provider + sandbox identity model.
6. Command options evolve to include organization and provider selection.

## Monorepo and Build Tooling

Root tooling is standardized:

- `pnpm-workspace.yaml`
- `turbo.json`
- organization scripts through `pnpm` + `turbo run ...`

Target package layout:

```text
packages/
  shared/                         # shared types, contracts, validation
  backend/
    src/
      actors/
        organization.ts
        repository.ts
        task.ts
        sandbox-instance.ts
        history.ts
        repository-pr-sync.ts
        repository-branch-sync.ts
        task-status-sync.ts
        keys.ts
        events.ts
        registry.ts
        index.ts
      providers/                  # provider-api + implementations
        provider-api/
        worktree/
        daytona/
      integrations/               # sandbox-agent + git/github/graphite adapters
        sandbox-agent/
        git/
        github/
        graphite/
      db/                         # drizzle schema, queries, migrations
        schema.ts
        client.ts
        migrations/
      transport/
        server.ts
        types.ts
      config/
        organization.ts
        backend.ts
  cli/                            # hf command surface
    src/
      commands/
      client/                     # backend transport client
      organization/                  # organization selection resolver
  tui/                            # OpenTUI app
    src/
      app/
      views/
      state/
      client/                     # backend stream client
research/specs/
  rivetkit-opentui-migration-plan.md (this file)
```

CLI and TUI are separate packages in the same monorepo, not separate repositories.

## Actor File Map (Concrete)

Backend actor files and responsibilities:

1. `packages/backend/src/actors/organization.ts`
- `OrganizationActor` implementation.
- Provider profile resolution and organization-level coordination.
- Spawns/routes to `RepositoryActor` handles.

2. `packages/backend/src/actors/repository.ts`
- `RepositoryActor` implementation.
- Branch snapshot refresh, PR cache orchestration, stream publication.
- Routes task actions to `TaskActor`.

3. `packages/backend/src/actors/task.ts`
- `TaskActor` implementation.
- Task lifecycle, session/sandbox orchestration, post-idle automation.

4. `packages/backend/src/actors/sandbox-instance.ts`
- `SandboxInstanceActor` implementation.
- Provider sandbox lifecycle, heartbeat, reconnect/recovery.

5. `packages/backend/src/actors/history.ts`
- `HistoryActor` implementation.
- Writes workflow events to SQLite via Drizzle.

6. `packages/backend/src/actors/keys.ts`
- Organization-prefixed actor key builders/parsers.

7. `packages/backend/src/actors/events.ts`
- Internal actor event envelopes and stream payload types.

8. `packages/backend/src/actors/registry.ts`
- RivetKit registry setup and actor registration.

9. `packages/backend/src/actors/index.ts`
- Actor exports and composition wiring.

10. `packages/backend/src/actors/repository-pr-sync.ts`
- Read-only PR polling loop (single timeout cadence).
- Sends sync results back to `RepositoryActor`.

11. `packages/backend/src/actors/repository-branch-sync.ts`
- Read-only branch snapshot polling loop (single timeout cadence).
- Sends sync results back to `RepositoryActor`.

12. `packages/backend/src/actors/task-status-sync.ts`
- Read-only session/sandbox status polling loop (single timeout cadence).
- Sends status updates back to `TaskActor`.

## RivetKit Source Policy (Local Only)

Do not use published RivetKit packages.

1. Build RivetKit from local source:
```bash
cd ../rivet
pnpm build -F rivetkit
```
2. Consume via local `link:` dependencies to built artifacts.
3. Keep dependency wiring deterministic and documented in repo scripts.

## Organization Model

Every command executes against a resolved organization context.

Organization selection:

1. CLI flag: `--organization <name>`
2. Config default organization
3. Fallback to `default`

Organization controls:

1. provider profile defaults
2. sandbox policy
3. repo membership / resolution
4. actor namespaces and database partitioning

## New Actor Implementation Overview

RivetKit registry actor keys are organization-prefixed:

1. `OrganizationActor` (organization coordinator)
- Key: `["ws", organizationId]`
- Owns organization config/runtime coordination, provider registry, organization health.
- Resolves provider defaults and organization-level policies.

2. `RepositoryActor`
- Key: `["ws", organizationId, "repository", repoId]`
- Owns repo snapshot cache and PR cache refresh orchestration.
- Routes branch/task commands to task actors.
- Streams repository updates to CLI/TUI subscribers.

3. `TaskActor`
- Key: `["ws", organizationId, "repository", repoId, "task", taskId]`
- Owns task metadata/runtime state.
- Creates/resumes sandbox + session through provider adapter.
- Handles attach/push/sync/merge/archive/kill and post-idle automation.

4. `SandboxInstanceActor` (optional but recommended)
- Key: `["ws", organizationId, "provider", providerId, "sandbox", sandboxId]`
- Owns sandbox lifecycle, heartbeat, endpoint readiness, recovery.

5. `HistoryActor`
- Key: `["ws", organizationId, "repository", repoId, "history"]`
- Owns `events` writes and workflow timeline completeness.

6. `ProjectPrSyncActor` (child poller)
- Key: `["ws", organizationId, "repository", repoId, "pr-sync"]`
- Polls PR state on interval and emits results to `RepositoryActor`.
- Does not write DB directly.

7. `ProjectBranchSyncActor` (child poller)
- Key: `["ws", organizationId, "repository", repoId, "branch-sync"]`
- Polls branch/worktree state on interval and emits results to `RepositoryActor`.
- Does not write DB directly.

8. `TaskStatusSyncActor` (child poller)
- Key: `["ws", organizationId, "repository", repoId, "task", taskId, "status-sync"]`
- Polls agent/session/sandbox health on interval and emits results to `TaskActor`.
- Does not write DB directly.

Ownership rule: each table/row has one actor writer.

## Single-Writer Mutation Map

Always define actor run-loop + mutated state together:

1. `OrganizationActor`
- Mutates: `organizations`, `workspace_provider_profiles`.

2. `RepositoryActor`
- Mutates: `repos`, `branches`, `pr_cache` (applies child poller results).

3. `TaskActor`
- Mutates: `tasks`, `task_runtime` (applies child poller results).

4. `SandboxInstanceActor`
- Mutates: `sandbox_instances`.

5. `HistoryActor`
- Mutates: `events`.

6. Child sync actors (`repository-pr-sync`, `repository-branch-sync`, `task-status-sync`)
- Mutates: none (read-only pollers; publish result messages only).

## Run Loop Patterns (Required)

Parent orchestration actors: no timeout, command-only queue loops.

### `OrganizationActor` (no timeout)

```ts
run: async (c) => {
  while (true) {
    const msg = await c.queue.next("organization.command");
    await handleOrganizationCommand(c, msg); // writes organization-owned tables only
  }
};
```

### `RepositoryActor` (no timeout)

```ts
run: async (c) => {
  while (true) {
    const msg = await c.queue.next("repository.command");
    await handleProjectCommand(c, msg); // includes applying sync results to branches/pr_cache
  }
};
```

### `TaskActor` (no timeout)

```ts
run: async (c) => {
  while (true) {
    const msg = await c.queue.next("task.command");
    await handleTaskCommand(c, msg); // includes applying status results to task_runtime
  }
};
```

### `SandboxInstanceActor` (no timeout)

```ts
run: async (c) => {
  while (true) {
    const msg = await c.queue.next("sandbox_instance.command");
    await handleSandboxInstanceCommand(c, msg); // sandbox_instances table only
  }
};
```

### `HistoryActor` (no timeout)

```ts
run: async (c) => {
  while (true) {
    const msg = await c.queue.next("history.command");
    await persistEvent(c, msg); // events table only
  }
};
```

Child sync actors: one timeout each, one cadence each.

### `ProjectPrSyncActor` (single timeout cadence)

```ts
run: async (c) => {
  const intervalMs = 30_000;
  while (true) {
    const msg = await c.queue.next("repository.pr_sync.command", { timeout: intervalMs });
    if (!msg) {
      const result = await pollPrState();
      await sendToProject({ name: "repository.pr_sync.result", result });
      continue;
    }
    await handlePrSyncControl(c, msg); // force/stop/update-interval
  }
};
```

### `ProjectBranchSyncActor` (single timeout cadence)

```ts
run: async (c) => {
  const intervalMs = 5_000;
  while (true) {
    const msg = await c.queue.next("repository.branch_sync.command", { timeout: intervalMs });
    if (!msg) {
      const result = await pollBranchState();
      await sendToProject({ name: "repository.branch_sync.result", result });
      continue;
    }
    await handleBranchSyncControl(c, msg);
  }
};
```

### `TaskStatusSyncActor` (single timeout cadence)

```ts
run: async (c) => {
  const intervalMs = 2_000;
  while (true) {
    const msg = await c.queue.next("task.status_sync.command", { timeout: intervalMs });
    if (!msg) {
      const result = await pollSessionAndSandboxStatus();
      await sendToTask({ name: "task.status_sync.result", result });
      continue;
    }
    await handleStatusSyncControl(c, msg);
  }
};
```

## Sandbox Provider Interface

Provider contract lives under `packages/backend/src/providers/provider-api` and is consumed by organization/repository/task actors.

```ts
interface SandboxProvider {
  id(): string;
  capabilities(): ProviderCapabilities;
  validateConfig(input: unknown): Promise<ValidatedConfig>;

  createSandbox(req: CreateSandboxRequest): Promise<SandboxHandle>;
  resumeSandbox(req: ResumeSandboxRequest): Promise<SandboxHandle>;
  destroySandbox(req: DestroySandboxRequest): Promise<void>;

  ensureSandboxAgent(req: EnsureAgentRequest): Promise<AgentEndpoint>;
  health(req: SandboxHealthRequest): Promise<SandboxHealth>;
  attachTarget(req: AttachTargetRequest): Promise<AttachTarget>;
}
```

Initial providers:

1. `worktree`
- Local git worktree-backed sandbox.
- Sandbox Agent local/shared endpoint.
- Preserves tmux + `cd` ergonomics.

2. `daytona`
- Remote sandbox lifecycle via Daytona.
- Boots/ensures Sandbox Agent inside sandbox.
- Returns endpoint/token for session operations.

## Command Surface (Organization + Provider Aware)

1. `hf create ... --organization <ws> --provider <worktree|daytona>`
2. `hf switch --organization <ws> [target]`
3. `hf attach --organization <ws> [task]`
4. `hf list --organization <ws>`
5. `hf kill|archive|merge|push|sync --organization <ws> ...`
6. `hf organization use <ws>` to set default organization

List/TUI include provider and sandbox health metadata.

`--organization` remains optional; omitted values use the standard resolution order.

## Data Model v2 (SQLite + Drizzle)

All persistent state is SQLite via Drizzle schema + migrations.

Tables (organization-scoped):

1. `organizations`
2. `workspace_provider_profiles`
3. `repos` (`workspace_id`, `repo_id`, ...)
4. `branches` (`workspace_id`, `repo_id`, ...)
5. `tasks` (`workspace_id`, `task_id`, `provider_id`, ...)
6. `task_runtime` (`workspace_id`, `task_id`, `sandbox_id`, `session_id`, ...)
7. `sandbox_instances` (`workspace_id`, `provider_id`, `sandbox_id`, ...)
8. `pr_cache` (`workspace_id`, `repo_id`, ...)
9. `events` (`workspace_id`, `repo_id`, ...)

Migration approach: one-way migration from existing schema during TS backend bootstrap.

## Transport and Runtime

1. TypeScript backend exposes local control API (socket or localhost HTTP).
2. CLI/TUI are thin clients; all mutations go through backend actors.
3. OpenTUI subscribes to repository streams from organization-scoped repository actors.
4. Organization is required context on all backend mutation requests.

CLI/TUI are responsible for resolving organization context before calling backend mutations.

## CLI + TUI Packaging

CLI and TUI ship from one package:

1. `packages/cli`
- command-oriented UX (`hf create`, `hf push`, scripting, JSON output)
- interactive OpenTUI mode via `hf tui`
- shared client/runtime wiring in one distributable

The package still calls the same backend API and shares contracts from `packages/shared`.

## Implementation Phases

## Phase 0: Contracts and Organization Spec

1. Freeze organization model, provider contract, and actor ownership map.
2. Freeze command flags for organization + provider selection.
3. Define Drizzle schema draft and migration plan.

Exit criteria:
- Approved architecture RFC.

## Phase 1: TypeScript Monorepo Bootstrap

1. Add `pnpm` organization + Turborepo pipeline.
2. Create `shared`, `backend`, and `cli` packages (with TUI integrated into CLI).
3. Add strict TypeScript config and CI checks.

Exit criteria:
- `pnpm -w typecheck` and `turbo run build` pass.

## Phase 2: RivetKit + Drizzle Foundations

1. Wire local RivetKit dependency from `../rivet`.
2. Add SQLite + Drizzle migrations and query layer.
3. Implement actor registry with organization-prefixed keys.

Exit criteria:
- Backend boot + organization actor health checks pass.

## Phase 3: Provider Layer in Backend

1. Implement provider API inside backend package.
2. Implement `worktree` provider end-to-end.
3. Integrate sandbox-agent session lifecycle through provider.

Exit criteria:
- `create/list/switch/attach/push/sync/kill` pass on worktree provider.

## Phase 4: Organization/Task Lifecycle

1. Implement organization coordinator flows.
2. Implement TaskActor full lifecycle + post-idle automation.
3. Implement history events and PR/CI/review change tracking.

Exit criteria:
- history/event completeness with parity checks.

## Phase 5: Daytona Provider

1. Implement Daytona sandbox lifecycle adapter.
2. Ensure sandbox-agent boot and reconnection behavior.
3. Validate attach/switch/kill flows for remote sandboxes.

Exit criteria:
- e2e pass on daytona provider.

## Phase 6: OpenTUI Rewrite

1. Build interactive list/switch UI in OpenTUI.
2. Implement key actions (attach/open PR/archive/merge/sync).
3. Add organization switcher UX and provider/sandbox indicators.

Exit criteria:
- TUI parity and responsive streaming updates.

## Phase 7: Cutover + Rust Deletion

1. Migrate existing DB to v2.
2. Replace runtime entrypoints with TS CLI/backend/TUI.
3. Delete Rust code, Cargo files, Rust scripts.
4. Update docs and `skills/SKILL.md`.

Exit criteria:
- no Rust code remains, fresh install + upgrade validated.

## Testing Strategy

1. Unit tests
- actor actions and ownership rules
- provider adapters
- event emission correctness
- drizzle query/migration tests

2. Integration tests
- backend + sqlite + provider fakes
- organization isolation boundaries
- session recovery and restart handling

3. E2E tests
- worktree provider in local test repo
- daytona provider in controlled env
- OpenTUI interactive flows

4. Reliability tests
- sandbox-agent restarts
- transient provider failures
- backend restart with in-flight tasks

## Open Questions To Resolve Before Implementation

1. Daytona production adapter parity:
- Current `daytona` provider in this repo is intentionally a fallback adapter so local development remains testable without a Daytona backend.
- Final deployment integration should replace placeholder lifecycle calls with Daytona API operations (create/destroy/health/auth/session boot inside sandbox).
