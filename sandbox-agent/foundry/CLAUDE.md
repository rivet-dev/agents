# Project Instructions

## Language Policy

Use TypeScript for all source code.

- Never add raw JavaScript source files (`.js`, `.mjs`, `.cjs`).
- Prefer `.ts`/`.tsx` for runtime code, scripts, tests, and tooling.
- If touching old JavaScript, migrate it to TypeScript instead of extending it.

## Monorepo + Tooling

Use `pnpm` workspaces and Turborepo.

- Repository root uses `pnpm-workspace.yaml` and `turbo.json`.
- Packages live in `packages/*`.
- `core` is renamed to `shared`.
- `packages/cli` is disabled and excluded from active monorepo validation.
- Integrations and providers live under `packages/backend/src/{integrations,providers}`.

## CLI Status

- `packages/cli` is fully disabled for active development.
- Do not implement new behavior in `packages/cli` unless explicitly requested.
- Frontend is the primary product surface; prioritize `packages/frontend` + supporting `packages/client`/`packages/backend`.
- Monorepo `build`, `typecheck`, and `test` intentionally exclude `@sandbox-agent/foundry-cli`.
- `pnpm-workspace.yaml` excludes `packages/cli` from monorepo package resolution.

## Common Commands

- Foundry is the canonical name for this product tree. Do not introduce or preserve legacy pre-Foundry naming in code, docs, commands, or runtime paths.
- Install deps: `pnpm install`
- Full active-monorepo validation: `pnpm -w typecheck`, `pnpm -w build`, `pnpm -w test`
- Start the full dev stack (real backend + frontend): `just foundry-dev` — frontend on **port 4173**, backend on **port 7741** (Docker via `compose.dev.yaml`)
- Start the mock frontend stack (no backend): `just foundry-mock` — mock frontend on **port 4174** (Docker via `compose.mock.yaml`)
- Start the local production-build preview stack: `just foundry-preview`
- Start only the backend locally: `just foundry-backend-start`
- Start only the frontend locally: `pnpm --filter @sandbox-agent/foundry-frontend dev`
- Start the mock frontend locally (no Docker): `just foundry-dev-mock` — mock frontend on **port 4174**
- Dev and mock stacks can run simultaneously on different ports (4173 and 4174).
- Stop the compose dev stack: `just foundry-dev-down`
- Tail compose dev logs: `just foundry-dev-logs`
- Stop the mock stack: `just foundry-mock-down`
- Tail mock logs: `just foundry-mock-logs`
- Stop the preview stack: `just foundry-preview-down`
- Tail preview logs: `just foundry-preview-logs`

## Dev Environment Setup

- `compose.dev.yaml` loads `foundry/.env` (optional) for credentials needed by the backend (GitHub OAuth, Stripe, Daytona, API keys, etc.).
- The canonical source for these credentials is `~/misc/the-foundry.env`. If `foundry/.env` does not exist, copy it: `cp ~/misc/the-foundry.env foundry/.env`
- `foundry/.env` is gitignored and must never be committed.
- If your changes affect the dev server, mock server, frontend runtime, backend runtime, Vite wiring, compose files, or other server-startup/runtime behavior, you must start or restart the relevant stack before finishing the task.
- Use the matching stack for verification:
  - real backend + frontend changes: `just foundry-dev` or restart with `just foundry-dev-down && just foundry-dev`
  - mock frontend changes: `just foundry-mock` or restart with `just foundry-mock-down && just foundry-mock`
  - local frontend-only work outside Docker: restart `pnpm --filter @sandbox-agent/foundry-frontend dev` or `just foundry-dev-mock` as appropriate
- The backend does **not** hot reload. Bun's `--hot` flag causes the server to re-bind on a different port (e.g. 6421 instead of 6420), breaking all client connections while the container still exposes the original port. After backend code changes, restart the backend container: `just foundry-dev-down && just foundry-dev`.
- The dev server has debug logging enabled by default (`RIVET_LOG_LEVEL=debug`, `FOUNDRY_LOG_LEVEL=debug`) via `compose.dev.yaml`. Error stacks and timestamps are also enabled.
- The frontend client uses JSON encoding for RivetKit in development (`import.meta.env.DEV`) for easier debugging. Production uses the default encoding.

## Foundry Base Sandbox Image

Local Docker sandboxes use the `rivetdev/sandbox-agent:foundry-base-latest` image by default. This image extends the sandbox-agent runtime with sudo, git, neovim, gh, node, bun, chromium, and agent-browser.

- **Dockerfile:** `docker/foundry-base.Dockerfile` (builds sandbox-agent from source, x86_64 only)
- **Publish script:** `scripts/publish-foundry-base.sh` (builds and pushes to Docker Hub `rivetdev/sandbox-agent`)
- **Tags:** `foundry-base-<YYYYMMDD>T<HHMMSS>Z` (timestamped) + `foundry-base-latest` (rolling)
- **Build from repo root:** `./foundry/scripts/publish-foundry-base.sh` (or `--dry-run` to skip push)
- **Override image in dev:** set `HF_LOCAL_SANDBOX_IMAGE` in `foundry/.env` or environment. The env var is passed through `compose.dev.yaml` to the backend.
- **Resolution order:** `config.sandboxProviders.local.image` (config.toml) > `HF_LOCAL_SANDBOX_IMAGE` (env var) > `DEFAULT_LOCAL_SANDBOX_IMAGE` constant in `packages/backend/src/actors/sandbox/index.ts`.
- The image must be built with `--platform linux/amd64`. The Rust build is memory-intensive; Docker Desktop needs at least 8GB RAM allocated.
- When updating the base image contents (new system packages, agent versions), rebuild and push with the publish script, then update the `foundry-base-latest` tag.

## Production GitHub App + OAuth App

Foundry uses two separate GitHub entities in production:

- **OAuth App** (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`) — handles "Sign in with GitHub" via Better Auth. This is a standard OAuth App.
- **GitHub App** (`GITHUB_APP_ID` / `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` / `GITHUB_APP_PRIVATE_KEY`) — handles webhooks, installation tokens for repo access, and GitHub API sync (repos, PRs). Must be manually installed on each org.

Key env vars and where they connect:

- `GITHUB_REDIRECT_URI` — OAuth callback, must point to `https://api.sandboxagent.dev/v1/auth/callback/github`
- `GITHUB_WEBHOOK_SECRET` — must match the secret configured on the GitHub App's Webhook settings page exactly. Mismatches cause silent 500s on webhook delivery (signature verification fails inside the actor, surfaced as a generic RivetKit `internal_error`).
- `BETTER_AUTH_URL` — must be the **API** URL (`https://api.sandboxagent.dev`), not the frontend URL. Better Auth uses this internally for sign-out and session management calls.
- `APP_URL` — the **frontend** URL (`https://foundry.sandboxagent.dev`).

Troubleshooting:

- **"GitHub App not installed"** — The GitHub App must be manually installed on each org. Sign-in does not auto-install it. Go to the GitHub App settings → Install App tab. The sign-in flow can only detect existing installations, not create them.
- **Webhooks not arriving** — Check the GitHub App → Advanced tab for delivery history. If deliveries show 500, the webhook secret likely doesn't match `GITHUB_WEBHOOK_SECRET`. Test with: `echo -n '{"test":true}' | openssl dgst -sha256 -hmac "$SECRET"` and curl the endpoint with the computed signature.
- **Deleting all actors wipes GitHub App installation state.** After a full actor reset, you must trigger a webhook (e.g. redeliver from GitHub App Advanced tab, or re-install the app) to repopulate installation records.

## Railway Logs

- Production Foundry Railway logs can be read from a linked checkout with `railway logs --deployment --lines 200` or `railway logs <deployment-id> --deployment --lines 200`.
- Production deploys should go through `git push` to the deployment branch/workflow. Do not use `railway up` for Foundry deploys.
- If Railway logs fail because the checkout is not linked to the correct Railway project/service/environment, run:
  `railway link --project 33e3e2df-32c5-41c5-a4af-dca8654acb1d --environment cf387142-61fd-4668-8cf7-b3559e0983cb --service 91c7e450-d6d2-481a-b2a4-0a916f4160fc`
- That links this directory to the `sandbox-agent` project, `production` environment, and `foundry-api` service.
- Production proxy chain: `api.sandboxagent.dev` routes through Cloudflare → Fastly/Varnish → Railway. When debugging request duplication, timeouts, or retry behavior, check headers like `cf-ray`, `x-varnish`, `x-railway-edge`, and `cdn-loop` to identify which layer is involved.

## Frontend + Client Boundary

- Keep a browser-friendly GUI implementation aligned with the TUI interaction model wherever possible.
- Do not import `rivetkit` directly in CLI or GUI packages. RivetKit client access must stay isolated inside `packages/client`.
- All backend interaction (actor calls, metadata/health checks, backend HTTP endpoint access) must go through the dedicated client library in `packages/client`.
- Outside `packages/client`, do not call backend endpoints directly (for example `fetch(.../v1/rivet...)`), except in black-box E2E tests that intentionally exercise raw transport behavior.
- GUI state should update in realtime (no manual refresh buttons). Prefer RivetKit push reactivity and actor-driven events; do not add polling/refetch for normal product flows.
- Keep the mock workspace types and mock client in `packages/shared` + `packages/client` up to date with the frontend contract. The mock is the UI testing reference implementation while backend functionality catches up.
- Keep frontend route/state coverage current in code and tests; there is no separate page-inventory doc to maintain.
- If Foundry uses a shared component from `@sandbox-agent/react`, make changes in `sdks/react` instead of copying or forking that component into Foundry.
- When changing shared React components in `sdks/react` for Foundry, verify they still work in the Sandbox Agent Inspector before finishing.
- When making UI changes, verify the live flow with the Chrome DevTools MCP or `agent-browser`, take screenshots of the updated UI, and offer to open those screenshots in Preview when you finish.
- When asked for screenshots, capture all relevant affected screens and modal states, not just a single viewport. Include empty, populated, success, and blocked/error states when they are part of the changed flow.
- If a screenshot catches a transition frame, blank modal, or otherwise misleading state, retake it before reporting it.
- When verifying UI in the browser, attempt to sign in by navigating to `/signin` and clicking "Continue with GitHub". If the browser lands on the GitHub login page (github.com/login) and you don't have credentials, stop and ask the user to complete the sign-in. Do not assume the session is invalid just because you see the Foundry sign-in page — always attempt the OAuth flow first.

## Realtime Data Architecture

### Core pattern: fetch initial state + subscribe to deltas

All client data flows follow the same pattern:

1. **Connect** to the actor via WebSocket.
2. **Fetch initial state** via an action call to get the current materialized snapshot.
3. **Subscribe to events** on the connection. Events carry **full replacement payloads** for the changed entity (not empty notifications, not patches — the complete new state of the thing that changed).
4. **Unsubscribe** after a 30-second grace period when interest ends (screen navigation, component unmount). The grace period prevents thrashing during screen transitions and React double-renders.

Do not use polling (`refetchInterval`), empty "go re-fetch" broadcast events, or full-snapshot re-fetches on every mutation. Every mutation broadcasts the new absolute state of the changed entity to connected clients.

### Materialized state in coordinator actors

- **Organization actor** materializes sidebar-level data in its own SQLite: repo catalog, task summaries (title, status, branch, PR, updatedAt), repo summaries (overview/branch state), and session summaries (id, name, status, unread, model — no transcript). Task actors push summary changes to the organization actor when they mutate. The organization actor broadcasts the updated entity to connected clients. `getOrganizationSummary` reads from local tables only — no fan-out to child actors.
- **Task actor** materializes its own detail state (session summaries, sandbox info, diffs, file tree). `getTaskDetail` reads from the task actor's own SQLite. The task actor broadcasts updates directly to clients connected to it.
- **Session data** lives on the task actor but is a separate subscription topic. The task topic includes `sessions_summary` (list without content). The `session` topic provides full transcript and draft state. Clients subscribe to the `session` topic for whichever session is active, and filter `sessionUpdated` events by session ID (ignoring events for other sessions on the same actor).
- There is no fan-out on the read path. The organization actor owns all task summaries locally.

### Subscription manager

The subscription manager (`packages/client`) is a global singleton that manages WebSocket connections, cached state, and subscriptions for all topics. It:

- **Deduplicates** — multiple subscribers to the same topic share one connection and one cached state.
- **Grace period (30s)** — when the last subscriber leaves, the connection and state stay alive for 30 seconds before teardown. This keeps data warm for back-navigation and prevents thrashing.
- **Exposes a single hook** — `useSubscription(topicKey, params)` returns `{ data, status, error }`. Null params = no subscription (conditional subscription).
- **Shared harness, separate implementations** — the `SubscriptionManager` interface is shared between mock and remote implementations. The mock implementation uses in-memory state. The remote implementation uses WebSocket connections. The API/client exposure is identical for both.

### Topics

Each topic maps to one actor connection and one event stream:

| Topic | Actor | Event | Data |
|---|---|---|---|
| `app` | Organization `"app"` | `appUpdated` | Auth, orgs, onboarding |
| `organization` | Organization `{organizationId}` | `organizationUpdated` | Repo catalog, task summaries, repo summaries |
| `task` | Task `{organizationId, repoId, taskId}` | `taskUpdated` | Session summaries, sandbox info, diffs, file tree |
| `session` | Task `{organizationId, repoId, taskId}` (filtered by sessionId) | `sessionUpdated` | Transcript, draft state |
| `sandboxProcesses` | SandboxInstance | `processesUpdated` | Process list |

The client subscribes to `app` always, `organization` when entering an organization, `task` when viewing a task, and `session` when viewing a specific session. At most 4 actor connections at a time (app + organization + task + sandbox if terminal is open). The `session` topic reuses the task actor connection and filters by session ID.

### Rules

- Do not add `useQuery` with `refetchInterval` for data that should be push-based.
- Do not broadcast empty notification events. Events must carry the full new state of the changed entity.
- Do not re-fetch full snapshots after mutations. The mutation triggers a server-side broadcast with the new entity state; the client replaces it in local state.
- All event subscriptions go through the subscription manager. Do not create ad-hoc `handle.connect()` + `conn.on()` patterns.
- Backend mutations that affect sidebar data (task title, status, branch, PR state) must push the updated summary to the parent organization actor, which broadcasts to organization subscribers.
- Comment architecture-related code: add doc comments explaining the materialized state pattern, why deltas flow the way they do, and the relationship between parent/child actor broadcasts. New contributors should understand the data flow from comments alone.

## Sandbox Architecture

- Structurally, the system supports multiple sandboxes per task, but in practice there is exactly one active sandbox per task. Design features assuming one sandbox per task. If multi-sandbox is needed in the future, extend at that time.
- Each task has a **primary user** (owner) whose GitHub OAuth credentials are injected into the sandbox for git operations. The owner swaps when a different user sends a message. See `.context/proposal-task-owner-git-auth.md` for the full design.
- **Security: OAuth token scope.** The user's GitHub OAuth token has `repo` scope, granting full control of all private repositories the user has access to. When the user is the active task owner, their token is injected into the sandbox. This means the agent can read/write ANY repo the user has access to, not just the task's target repo. This is the standard trade-off for OAuth-based git integrations (same as GitHub Codespaces, Gitpod). The user consents to `repo` scope at sign-in time. Credential files in the sandbox are `chmod 600` and overwritten on owner swap.
- All git operations in the sandbox must be auto-authenticated. Never configure git to prompt for credentials (no interactive `GIT_ASKPASS` prompts). Use a credential store file that is pre-populated with the active owner's token.
- All git operation errors (push 401, clone failure, branch protection rejection) must surface in the UI with actionable context. Never silently swallow git errors.

## Git State Policy

- The backend stores zero git state. No local clones, no refs, no working trees, and no git-spice.
- Repository metadata (branches, default branch, pull requests) comes from GitHub API data and webhook events already flowing into the system.
- All git operations that require a working tree run inside the task's sandbox via `executeInSandbox()`.
- Do not add backend git clone paths, `git fetch`, `git for-each-ref`, or direct backend git CLI calls. If you need git data, either read stored GitHub metadata or run the command inside a sandbox.
- The `BackendDriver` has no `GitDriver` or `StackDriver`. Only `GithubDriver` and `TmuxDriver` remain.

## React Hook Dependency Safety

- **Never use unstable references as `useEffect`/`useMemo`/`useCallback` dependencies.** React compares dependencies by reference, not value. Expressions like `?? []`, `?? {}`, `.map(...)`, `.filter(...)`, or object/array literals create new references every render, causing infinite re-render loops when used as dependencies.
- If the upstream value may be `undefined`/`null` and you need a fallback, either:
  - Use the raw upstream value as the dependency and apply the fallback inside the effect body: `useEffect(() => { doThing(value ?? []); }, [value]);`
  - Derive a stable primitive key: `const key = JSON.stringify(value ?? []);` then depend on `key`
  - Memoize: `const stable = useMemo(() => value ?? [], [value]);`
- When reviewing code, treat any `?? []`, `?? {}`, or inline `.map()/.filter()` in a dependency array as a bug.

## UI System

- Foundry's base UI system is `BaseUI` with `Styletron`, plus Foundry-specific theme/tokens on top. Treat that as the default UI foundation.
- The full `BaseUI` reference for available components and guidance on animations, customization, composition, and forms is at `https://base-ui.com/llms.txt`.
- Prefer existing `BaseUI` components and composition patterns whenever possible instead of building custom controls from scratch.
- Reuse the established Foundry theme/token layer for colors, typography, spacing, and surfaces instead of introducing ad hoc visual values.
- If the same UI pattern is shared with the Inspector or other consumers, prefer extracting or reusing it through `@sandbox-agent/react` rather than duplicating it in Foundry.
- If a requested UI cannot be implemented cleanly with an existing `BaseUI` component, stop and ask the user whether they are sure they want to diverge from the system.
- In that case, recommend the closest existing `BaseUI` components or compositions that could satisfy the need before proposing custom UI work.
- Only introduce custom UI primitives when `BaseUI` and existing Foundry patterns are not sufficient, or when the user explicitly confirms they want the divergence.
- **Styletron atomic CSS rule:** Never mix CSS shorthand properties with their longhand equivalents in the same style object (including nested pseudo-selectors like `:hover`), or in a base styled component whose consumers override with longhand via `$style`. This includes `padding`/`paddingLeft`, `margin`/`marginTop`, `background`/`backgroundColor`, `border`/`borderLeft`, etc. Styletron generates independent atomic classes for shorthand and longhand, so they conflict unpredictably. Use `backgroundColor: "transparent"` instead of `background: "none"` for button resets. Always use longhand properties when any side may be overridden individually.

## Runtime Policy

- Runtime is Bun-native.
- Use Bun for CLI/backend execution paths and process spawning.
- Do not add Node compatibility fallbacks for OpenTUI/runtime execution.

## Defensive Error Handling

- Write code defensively: validate assumptions at boundaries and state transitions.
- If the system reaches an unexpected state, raise an explicit error with actionable context.
- Do not fail silently, swallow errors, or auto-ignore inconsistent data.
- Prefer fail-fast behavior over hidden degradation when correctness is uncertain.
- **Never use bare `catch {}` or `catch { }` blocks.** Every catch must at minimum log the error with `logActorWarning` or `console.warn`. Silent catches hide bugs and make debugging impossible. If a catch is intentionally degrading (e.g. returning empty data when a sandbox is expired), it must still log so operators can see what happened. Use `catch (error) { logActorWarning(..., { error: resolveErrorMessage(error) }); }` or equivalent.

## RivetKit Dependency Policy

For all Rivet/RivetKit implementation:

1. Use SQLite + Drizzle for persistent state.
2. SQLite is **per actor instance** (per actor key), not a shared backend-global database:
   - Each actor instance gets its own SQLite DB.
   - Schema design should assume a single actor instance owns the entire DB.
   - Do not add `organizationId`/`repoId`/`taskId` columns just to "namespace" rows for a given actor instance; use actor state and/or the actor key instead.
   - Example: the `task` actor instance already represents `(organizationId, repoId, taskId)`, so its SQLite tables should not need those columns for primary keys.
3. Do not use backend-global SQLite singletons; database access must go through actor `db` providers (`c.db`).
4. The default dependency source for RivetKit is the published `rivetkit` package so monorepo installs and CI remain self-contained.

## Rivet Routing

- Mount RivetKit directly on `/v1/rivet` via `registry.handler(c.req.raw)`.
- Do not add an extra proxy or manager-specific route layer in the backend.
- Let RivetKit own metadata/public endpoint behavior for `/v1/rivet`.

## Organization + Actor Rules

- Everything is scoped to an organization.
- Organization resolution order: `--organization` flag -> config default -> `"default"`.
- `ControlPlaneActor` is replaced by `OrganizationActor` (organization coordinator).
- Every actor key must be prefixed with organization namespace (`["org", organizationId, ...]`).
- CLI/TUI/GUI must use `@sandbox-agent/foundry-client` (`packages/client`) for backend access; `rivetkit/client` imports are only allowed inside `packages/client`.
- Do not add custom backend REST endpoints (no `/v1/*` shim layer).
- We own the sandbox-agent project; treat sandbox-agent defects as first-party bugs and fix them instead of working around them.
- Keep strict single-writer ownership: each table/row has exactly one actor writer.
- Parent actors (`organization`, `task`, `sandbox-instance`) use command-only loops with no timeout.
- Periodic syncing lives in dedicated child actors with one timeout cadence each.
- **Task actors must be created lazily** — never during sync or bulk operations. PR sync writes virtual entries to the org's local `taskIndex`/`taskSummaries` tables. The task actor is created on first user interaction via `getOrCreate`. See `packages/backend/CLAUDE.md` "Lazy Task Actor Creation" for details.
- Do not build blocking flows that wait on external systems to become ready or complete. Prefer push-based progression driven by actor messages, events, webhooks, or queue/workflow state changes.
- Use workflows/background commands for any repo sync, sandbox provisioning, agent install, branch restack/rebase, or other multi-step external work. Do not keep user-facing actions/requests open while that work runs.
- `send` policy: always `await` the `send(...)` call itself so enqueue failures surface immediately, but default to `wait: false`.
- Never self-send with `wait: true` from inside a workflow handler — the workflow processes one message at a time, so the handler would deadlock waiting for the new message to be dequeued.
- Read paths must not force refresh/sync work inline. Serve the latest cached projection, mark staleness explicitly, and trigger background refresh separately when needed.
- If a workflow needs to resume after some external work completes, model that as workflow state plus follow-up messages/events instead of holding the original request open.
- No retries: never add retry loops (`withRetries`, `setTimeout` retry, exponential backoff) anywhere in the codebase. If an operation fails, surface the error immediately. If a dependency is not ready yet, model that explicitly with workflow state and resume from a push/event instead of polling or retry loops.
- Never throw errors that expect the caller to retry (e.g. `throw new Error("... retry shortly")`). If a dependency is not ready, write the current state to the DB with an appropriate pending status, enqueue the async work, and return successfully. Let the client observe the pending → ready transition via push events.
- Action return contract: every action that creates a resource must write the resource record to the DB before returning, so the client can immediately query/render it. The record may have a pending status, but it must exist. Never return an ID that doesn't yet have a corresponding DB row.

### Action handler responsiveness

Action handlers must return fast. The pattern:

1. **Creating an entity** — `wait: true` is fine. Do the DB write, return the ID/record. The caller needs the ID to proceed. The record may have a pending status; that's expected.
2. **Enqueuing work** (sending a message, triggering a sandbox operation, starting a sync) — `wait: false`. Write any precondition state to the DB synchronously, enqueue the work, and return. The client observes progress via push events on the relevant topic (session status, task status, etc.).
3. **Validating preconditions** — check state synchronously in the action handler *before* enqueuing. If a precondition isn't met (e.g. session not ready, task not initialized), throw an error immediately. Do not implicitly provision missing dependencies or poll for readiness inside the action handler. It is the client's responsibility to ensure preconditions are met before calling the action.

Examples:
- `createTask` → `wait: true` (returns `{ taskId }`), then enqueue provisioning with `wait: false`. Client sees task appear immediately with pending status, observes `ready` via organization events.
- `sendWorkspaceMessage` → validate session is `ready` (throw if not), enqueue with `wait: false`. Client observes session transition to `running` → `idle` via session events.
- `createWorkspaceSession` → `wait: true` (returns `{ sessionId }`), enqueue sandbox provisioning with `wait: false`. Client observes `pending_provision` → `ready` via task events.

Never use `wait: true` for operations that depend on external readiness, sandbox I/O, agent responses, git network operations, polling loops, or long-running queue drains. Never hold an action open while waiting for an external system to become ready — that is a polling/retry loop in disguise.

### Timeout policy

All `wait: true` sends must have an explicit `timeout`. Maximum timeout for any `wait: true` send is **10 seconds** (`10_000`). If an operation cannot reliably complete within 10 seconds, it must be restructured: write the initial record to the DB, return it to the caller, and continue the work asynchronously with `wait: false`. The client observes completion via push events.

`wait: false` sends do not need a timeout (the enqueue is instant; the work runs in the workflow loop with its own step-level timeouts).

### Task creation: resolve metadata before creating the actor

When creating a task, all deterministic metadata (title, branch name) must be resolved synchronously in the organization actor *before* the task actor is created. The task actor must never be created with null `branchName` or `title`.

- Title is derived from the task description via `deriveFallbackTitle()` — pure string manipulation, no external I/O.
- Branch name is derived from the title via `sanitizeBranchName()` + conflict checking against the repository's task index.
- The organization actor owns the task index and reads GitHub-backed default branch metadata from the github-data actor. Resolve the branch name there without local git fetches.
- Do not defer naming to a background provision workflow. Do not poll for names to become available.
- The `onBranch` path (attaching to an existing branch) and the new-task path should both produce a fully-named task record on return.
- Actor handle policy:
- Prefer explicit `get` or explicit `create` based on workflow intent; do not default to `getOrCreate`.
- Use `get`/`getForId` when the actor is expected to already exist; if missing, surface an explicit `Actor not found` error with recovery context.
- Use create semantics only on explicit provisioning/create paths where creating a new actor instance is intended.
- `getOrCreate` is a last resort for create paths when an explicit create API is unavailable; never use it in read/command paths.
- For long-lived cross-actor links (for example sandbox/session runtime access), persist actor identity (`actorId`) and keep a fallback lookup path by actor id.
- RivetKit actor `c.state` is durable, but in Docker it is stored under `/root/.local/share/rivetkit`. If that path is not persisted, actor state-derived indexes can be lost after container recreation even when other data still exists.
- Workflow history divergence policy:
- Production: never auto-delete actor state to resolve `HistoryDivergedError`; ship explicit workflow migrations (`ctx.removed(...)`, step compatibility).
- Development: manual local state reset is allowed as an operator recovery path when migrations are not yet available.
- Storage rule of thumb:
- Put simple metadata in `c.state` (KV state): small scalars and identifiers like `{ taskId }`, `{ repoId }`, booleans, counters, timestamps, status strings.
- If it grows beyond trivial (arrays, maps, histories, query/filter needs, relational consistency), use SQLite + Drizzle in `c.db`.

## Testing Policy

- Never use vitest mocks (`vi.mock`, `vi.spyOn`, `vi.fn`). Instead, define driver interfaces for external I/O and pass test implementations via the actor runtime context.
- All external service calls (git CLI, GitHub CLI, sandbox-agent HTTP, tmux) must go through the `BackendDriver` interface on the runtime context.
- Integration tests use `setupTest()` from `rivetkit/test` and are gated behind `HF_ENABLE_ACTOR_INTEGRATION_TESTS=1`.
- End-to-end testing must run against the dev backend started via `docker compose -f compose.dev.yaml up` (host -> container). Do not run E2E against an in-process test runtime.
  - E2E tests should talk to the backend over HTTP (default `http://127.0.0.1:7741/v1/rivet`) and use real GitHub repos/PRs.
  - For Foundry live verification, use `rivet-dev/sandbox-agent-testing` as the default testing repo unless the task explicitly says otherwise.
  - Secrets (e.g. `OPENAI_API_KEY`, `GITHUB_TOKEN`/`GH_TOKEN`) must be provided via environment variables, never hardcoded in the repo.
  - `~/misc/env.txt` and `~/misc/the-foundry.env` contain the expected local OpenAI + GitHub OAuth/App config for dev.
  - For local GitHub webhook development, use the configured Smee proxy (`SMEE_URL`) to forward deliveries into `POST /v1/webhooks/github`. Check `.env` / `foundry/.env` if you need the current channel URL.
  - If GitHub repos, PRs, or install state are not showing up, verify that the GitHub App is installed for the organization and that webhook delivery is enabled and healthy. Foundry depends on webhook events for GitHub-backed state; missing webhooks means the product will appear broken.
  - Do not assume `gh auth token` is sufficient for Foundry task provisioning against private repos. Sandbox/bootstrap git clone, push, and PR flows require a repo-capable `GITHUB_TOKEN`/`GH_TOKEN` in the backend container.
  - Preferred product behavior for organizations is to mint a GitHub App installation token from the organization installation and inject it into backend/sandbox git operations. Do not rely on an operator's ambient CLI auth as the long-term solution.
- Treat client E2E tests in `packages/client/test` as the primary end-to-end source of truth for product behavior.
- Keep backend tests small and targeted. Only retain backend-only tests for invariants or persistence rules that are not well-covered through client E2E.
- Do not keep large browser E2E suites around in a broken state. If a frontend browser E2E is not maintained and producing signal, remove it until it can be replaced with a reliable test.

## Config

- Keep config path at `~/.config/foundry/config.toml`.
- Evolve properties in place; do not move config location.

## Project Guidance

Project-specific guidance lives in `README.md`, `CONTRIBUTING.md`, and the relevant files under `research/`.

Keep those updated when:

- Commands change
- Configuration options change
- Architecture changes
- Plugins/providers change
- Actor ownership changes

## Friction Logs

Track friction at:

- `research/friction/rivet.mdx`
- `research/friction/sandbox-agent.mdx`
- `research/friction/sandboxes.mdx`
- `research/friction/general.mdx`

Category mapping:

- `rivet`: Rivet/RivetKit runtime, actor model, queues, keys
- `sandbox-agent`: sandbox-agent SDK/API behavior
- `sandboxes`: provider implementations (worktree/daytona/etc)
- `general`: everything else

Each entry must include:

- Date (`YYYY-MM-DD`)
- Commit SHA (or `uncommitted`)
- What you were implementing
- Friction/issue
- Attempted fix/workaround and outcome

## Audit Log Events

Log notable workflow changes to `events` so the audit log remains complete:

- create
- attach
- push/sync/merge
- archive/kill
- status transitions
- PR state transitions

When adding new task/workspace commands, always add a corresponding audit log event.

## Validation After Changes

Always run and fix failures:

```bash
pnpm -w typecheck
pnpm -w build
pnpm -w test
```

After making code changes, always update the dev server before declaring the work complete. If the dev stack is running through Docker Compose, restart or recreate the relevant dev services so the running app reflects the latest code.
