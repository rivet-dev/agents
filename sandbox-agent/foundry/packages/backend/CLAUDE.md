# Backend Notes

## Actor Hierarchy

Keep the backend actor tree aligned with this shape unless we explicitly decide to change it:

```text
OrganizationActor (direct coordinator for tasks)
├─ AuditLogActor (organization-scoped global feed)
├─ GithubDataActor
├─ TaskActor(task)
│  ├─ taskSessions      → session metadata/transcripts
│  └─ taskSandboxes     → sandbox instance index
└─ SandboxInstanceActor(sandboxProviderId, sandboxId) × N
```

## Coordinator Pattern

Actors follow a coordinator pattern where each coordinator is responsible for:
1. **Index tables** — keeping a local SQLite index/summary of its child actors' data
2. **Create/destroy** — handling lifecycle of child actors
3. **Routing** — resolving lookups to the correct child actor

Children push updates **up** to their direct coordinator only. Coordinators broadcast changes to connected clients. This keeps the read path local (no fan-out to children).

### Coordinator hierarchy and index tables

```text
OrganizationActor (coordinator for tasks + auth users)
│
│  Index tables:
│  ├─ taskIndex          → TaskActor index (taskId → repoId + branchName)
│  ├─ taskSummaries      → TaskActor materialized sidebar projection
│  ├─ authSessionIndex   → UserActor index (session token → userId)
│  ├─ authEmailIndex     → UserActor index (email → userId)
│  └─ authAccountIndex   → UserActor index (OAuth account → userId)
│
├─ TaskActor (coordinator for sessions + sandboxes)
│  │
│  │  Index tables:
│  │  ├─ taskWorkspaceSessions → Session index (session metadata + transcript)
│  │  └─ taskSandboxes         → SandboxInstanceActor index (sandbox history)
│  │
│  └─ SandboxInstanceActor (leaf)
│
├─ AuditLogActor (organization-scoped audit log, not a coordinator)
└─ GithubDataActor (GitHub API cache, not a coordinator)
```

When adding a new index table, annotate it in the schema file with a doc comment identifying it as a coordinator index and which child actor it indexes (see existing examples).

## GitHub Sync Data Model

The GithubDataActor syncs **repositories** and **pull requests** from GitHub, not branches. We only need repos (to know which repos exist and their metadata) and PRs (to lazily populate virtual tasks in the sidebar). Branch data is not synced because we only create tasks from PRs or fresh user-initiated creation, never from bare branches. Generated branch names for new tasks are treated as unique enough to skip conflict detection against remote branches.

Tasks are either:
1. **Created fresh** by the user (no PR yet, branch name generated from task description)
2. **Lazily populated from pull requests** during PR sync (virtual task entries in org tables, no actor spawned)

## Lazy Task Actor Creation — CRITICAL

**Task actors must NEVER be created during GitHub sync or bulk operations.** Creating hundreds of task actors simultaneously causes OOM crashes. An org can have 200+ PRs; spawning an actor per PR kills the process.

### The two creation points

There are exactly **two** places that may create a task actor:

1. **`createTaskMutation`** in `task-mutations.ts` — the only backend code that calls `getOrCreateTask`. Triggered by explicit user action ("New Task" button). One actor at a time.

2. **`backend-client.ts` client helper** — calls `client.task.getOrCreate(...)`. This is the lazy materialization point: when a user clicks a virtual task in the sidebar, the client creates the actor, and it self-initializes in `getCurrentRecord()` (`workflow/common.ts`) by reading branch/title from the org's `getTaskIndexEntry` action.

### The rule

### The rule

**Never use `getOrCreateTask` inside a sync loop, webhook handler, or any bulk operation.** That's what caused the OOM — 186 actors spawned simultaneously during PR sync.

`getOrCreateTask` IS allowed in:
- `createTaskMutation` — explicit user "New Task" action
- `requireWorkspaceTask` — user-initiated actions (createSession, sendMessage, etc.) that may hit a virtual task
- `getTask` action on the org — called by sandbox actor and client, needs to materialize virtual tasks
- `backend-client.ts` client helper — lazy materialization when user views a task

### Virtual tasks (PR-driven)

During PR sync, `refreshTaskSummaryForBranchMutation` is called for every changed PR (via github-data's `emitPullRequestChangeEvents`). It writes **virtual task entries** to the org actor's local `taskIndex` + `taskSummaries` tables only. No task actor is spawned. No cross-actor calls to task actors.

When the user interacts with a virtual task (clicks it, creates a session):
1. Client or org actor calls `getOrCreate` on the task actor key → actor is created with empty DB
2. Any action on the actor calls `getCurrentRecord()` → sees empty DB → reads branch/title from org's `getTaskIndexEntry` → calls `initBootstrapDbActivity` + `initCompleteActivity` → task is now real

### Call sites to watch

- `refreshTaskSummaryForBranchMutation` — called in bulk during sync. Must ONLY write to org local tables. Never create task actors or call task actor actions.
- `emitPullRequestChangeEvents` in github-data — iterates all changed PRs. Must remain fire-and-forget with no actor fan-out.

## Queue vs Action Decision Framework

The default is a direct action. Use a queue only if the answer to one or more of these questions is **yes**.

Actions are pure RPCs with no DB overhead on send — fast, but if the call fails the operation is lost. Queues persist the message to the database on send, guaranteeing it will be processed even if the target actor is busy, slow, or recovering. The tradeoff: queues add write overhead and serialize processing.

### 1. Does this operation coordinate multi-step work?

Does it involve external I/O (sandbox API, GitHub API, agent process management) or state machine transitions where interleaving would corrupt state? This is different from database-level serialization — a simple read-then-write on SQLite can use a transaction. The queue is for ordering operations that span DB writes + external I/O.

**Queue examples:**
- `workspace.send_message` — sends to sandbox agent, writes session status, does owner-swap. Multi-step with external I/O.
- `push` / `sync` / `merge` — git operations in sandbox that must not interleave.
- `createTask` — read-then-write across task index + actor creation. Returns result, so `wait: true`.

**Action examples:**
- `billing.stripe_customer.apply` — single column upsert, no external I/O.
- `workspace.update_draft` — writes draft text, no coordination with sandbox ops.
- `workspace.rename_task` — updates title column, queue handlers don't touch title.

### 2. Must this message be processed no matter what?

Is this a cross-actor fire-and-forget where the caller won't retry and data loss is unacceptable? A queue persists the message — if the target is down, it waits. An action RPC that fails is gone.

**Queue examples:**
- `audit.append` — caller must never be affected by audit failures, and audit entries must not be lost.
- `applyTaskSummaryUpdate` — task actor pushes summary to org and moves on. Won't retry if org is busy.
- `refreshTaskSummaryForBranch` — webhook-driven, won't be redelivered for the same event.

**Action examples:**
- `billing.invoice.upsert` — Stripe retries handle failures externally. No durability need on our side.
- `workspace.mark_unread` — UI convenience state. Acceptable to lose on transient failure.
- `github.webhook_receipt.record` — timestamp columns with no downstream effects.

### Once on a queue: wait or fire-and-forget?

If the caller needs a return value, use `wait: true`. If the UI updates via push events, use `wait: false`.

Full migration plan: `QUEUE_TO_ACTION_MIGRATION.md`.

## Ownership Rules

- `OrganizationActor` is the organization coordinator, direct coordinator for tasks, and lookup/index owner. It owns the task index, task summaries, and repo catalog.
- `AuditLogActor` is organization-scoped. There is one organization-level audit log feed.
- `TaskActor` is one branch. Treat `1 task = 1 branch` once branch assignment is finalized.
- `TaskActor` can have many sessions.
- `TaskActor` can reference many sandbox instances historically, but should have only one active sandbox/session at a time.
- Session unread state and draft prompts are backend-owned workspace state, not frontend-local state.
- Branch names are immutable after task creation. Do not implement branch-rename flows.
- `SandboxInstanceActor` stays separate from `TaskActor`; tasks/sessions reference it by identity.
- The backend stores no local git state. No clones, no refs, no working trees, and no git-spice. Repository metadata comes from GitHub API data and webhook events. Any working-tree git operation runs inside a sandbox via `executeInSandbox()`.
- When a backend request path must aggregate multiple independent actor calls or reads, prefer bounded parallelism over sequential fan-out when correctness permits. Do not serialize independent work by default.
- Only a coordinator creates/destroys its children. Do not create child actors from outside the coordinator.
- Children push state changes up to their direct coordinator only. Task actors push summary updates directly to the organization actor.
- Read paths must use the coordinator's local index tables. Do not fan out to child actors on the hot read path.
- Never build "enriched" read actions that chain through multiple actors (e.g., coordinator → child actor → sibling actor). If data from multiple actors is needed for a read, it should already be materialized in the coordinator's index tables via push updates. If it's not there, fix the write path to push it — do not add a fan-out read path.

## Drizzle Migration Maintenance

After changing any actor's `db/schema.ts`, you **must** regenerate the corresponding migration so the runtime creates the tables that match the schema. Forgetting this step causes `no such table` errors at runtime.

1. **Generate a new drizzle migration.** Run from `packages/backend`:
   ```bash
   npx drizzle-kit generate --config=./src/actors/<actor>/db/drizzle.config.ts
   ```
   If the interactive prompt is unavailable (e.g. in a non-TTY), manually create a new `.sql` file under `./src/actors/<actor>/db/drizzle/` and add the corresponding entry to `meta/_journal.json`.

2. **Regenerate the compiled `migrations.ts`.** Run from the foundry root:
   ```bash
   npx tsx packages/backend/src/actors/_scripts/generate-actor-migrations.ts
   ```

3. **Verify insert/upsert calls.** Every column with `.notNull()` (and no `.default(...)`) must be provided a value in all `insert()` and `onConflictDoUpdate()` calls. Missing a NOT NULL column causes a runtime constraint violation, not a type error.

4. **Nuke RivetKit state in dev** after migration changes to start fresh:
   ```bash
   docker compose -f compose.dev.yaml down
   docker volume rm foundry_foundry_rivetkit_storage
   docker compose -f compose.dev.yaml up -d
   ```

Actors with drizzle migrations: `organization`, `audit-log`, `task`. Other actors (`user`, `github-data`) use inline migrations without drizzle.

## Workflow Step Nesting — FORBIDDEN

**Never call `c.step()` / `ctx.step()` from inside another step's `run` callback.** RivetKit workflow steps cannot be nested. Doing so causes the runtime error: *"Cannot start a new workflow entry while another is in progress."*

This means:
- Functions called from within a step `run` callback must NOT use `c.step()`, `c.loop()`, `c.sleep()`, or `c.queue.next()`.
- If a mutation function needs to be called both from a step and standalone, it must only do plain DB/API work — no workflow primitives. The workflow step wrapping belongs in the workflow file, not in the mutation.
- Helper wrappers that conditionally call `c.step()` (like a `runSyncStep` pattern) are dangerous — if the caller is already inside a step, the nested `c.step()` will crash at runtime with no compile-time warning.

**Rule of thumb:** Workflow primitives (`step`, `loop`, `sleep`, `queue.next`) may only appear at the top level of a workflow function or inside a `loop` callback — never inside a step's `run`.

## SQLite Constraints

- Single-row tables must use an integer primary key with `CHECK (id = 1)` to enforce the singleton invariant at the database level.
- Follow the task actor pattern for metadata/profile rows and keep the fixed row id in code as `1`, not a string sentinel.

## Multiplayer Correctness

Per-user UI state must live on the user actor, not on shared task/session actors. This is critical for multiplayer — multiple users may view the same task simultaneously with different active sessions, unread states, and in-progress drafts.

**Per-user state (user actor):** active session tab, unread counts, draft text, draft attachments. Keyed by `(userId, taskId, sessionId)`.

**Task-global state (task actor):** session transcript, session model, session runtime status, sandbox identity, task status, branch name, PR state. These are shared across all users viewing the task — that is correct behavior.

Do not store per-user preferences, selections, or ephemeral UI state on shared actors. If a field's value should differ between two users looking at the same task, it belongs on the user actor.

## Audit Log Maintenance

Every new action or command handler that represents a user-visible or workflow-significant event must append to the audit log actor. The audit log must remain a comprehensive record of significant operations.

## Debugging Actors

### RivetKit Inspector UI

The RivetKit inspector UI at `http://localhost:6420/ui/` is the most reliable way to debug actor state in local development. The inspector HTTP API (`/inspector/workflow-history`) has a known bug where it returns empty `{}` even when the workflow has entries — always cross-check with the UI.

**Useful inspector URL pattern:**
```
http://localhost:6420/ui/?u=http%3A%2F%2F127.0.0.1%3A6420&ns=default&r=default&n=[%22<actor-name>%22]&actorId=<actor-id>&tab=<tab>
```

Tabs: `workflow`, `database`, `state`, `queue`, `connections`, `metadata`.

**To find actor IDs:**
```bash
curl -s 'http://127.0.0.1:6420/actors?name=organization'
```

**To query actor DB via bun (inside container):**
```bash
docker compose -f compose.dev.yaml exec -T backend bun -e '
  var Database = require("bun:sqlite");
  var db = new Database("/root/.local/share/foundry/rivetkit/databases/<actor-id>.db", { readonly: true });
  console.log(JSON.stringify(db.query("SELECT name FROM sqlite_master WHERE type=?").all("table")));
'
```

**To call actor actions via inspector:**
```bash
curl -s -X POST 'http://127.0.0.1:6420/gateway/<actor-id>/inspector/action/<actionName>' \
  -H 'Content-Type: application/json' -d '{"args":[{}]}'
```

### Known inspector API bugs

- `GET /inspector/workflow-history` may return `{"history":{}}` even when workflow has run. Use the UI's Workflow tab instead.
- `GET /inspector/queue` is reliable for checking pending messages.
- `GET /inspector/state` is reliable for checking actor state.

## Inbox & Notification System

The user actor owns two per-user systems: a **task feed** (sidebar ordering) and **notifications** (discrete events). These are distinct concepts that share a common "bump" mechanism.

### Core distinction: bumps vs. notifications

A **bump** updates the task's position in the user's sidebar feed. A **notification** is a discrete event entry shown in the notification panel. Every notification also triggers a bump, but not every bump creates a notification.

| Event | Bumps task? | Creates notification? |
|-------|-------------|----------------------|
| User sends a message | Yes | No |
| User opens/clicks a task | Yes | No |
| User creates a session | Yes | No |
| Agent finishes responding | Yes | Yes |
| PR review requested | Yes | Yes |
| PR merged | Yes | Yes |
| PR comment added | Yes | Yes |
| Agent error/needs input | Yes | Yes |

### Recipient resolution

Notifications and bumps go to the **task owner** only. Each task has exactly one owner at a time (the user who last sent a message or explicitly took ownership). This is an acceptable race condition — it rarely makes sense for two users to work on the same task simultaneously, and ownership transfer is explicit.

The system supports multiplayer (multiple users can view the same task), but the notification/bump target is always the single current owner. Each user has their own independent notification and unread state on their own user actor.

### Tables (on user actor)

Two new tables:

- **`userTaskFeed`** — one row per task. Tracks `bumpedAtMs` and `bumpReason` for sidebar sort order. Does NOT denormalize task content (title, repo, etc.) — the frontend queries the org actor for task content and uses the feed only for ordering/filtering.
- **`userNotifications`** — discrete notification entries with `type`, `message`, `read` state, and optional `sessionId`. Retention: notifications are retained for a configurable number of days after being marked read, then cleaned up.

### Queue commands (user actor workflow)

- `user.bump_task` — upserts `userTaskFeed` row, no notification created. Used for user-initiated actions (send message, open task, create session).
- `user.notify` — inserts `userNotifications` row AND upserts `userTaskFeed` (auto-bump). Used for system events (agent finished, PR review requested).
- `user.mark_read` — marks notifications read for a given `(taskId, sessionId?)`. Also updates `userTaskState.unread` for the session.

### Data flow

Task actor (or org actor) resolves the current task owner, then sends to the owner's user actor queue:
1. `user.notify(...)` for notification-worthy events (auto-bumps the feed)
2. `user.bump_task(...)` for non-notification bumps (send message, open task)

The user actor processes the queue message, writes to its local tables, and broadcasts a `userFeedUpdated` event to connected clients.

### Sidebar architecture change

The left sidebar changes from showing the repo/PR tree to showing **recent tasks** ordered by `userTaskFeed.bumpedAtMs`. Two new buttons at the top of the sidebar:
- **All Repositories** — navigates to a page showing the current repo + PR list (preserving existing functionality)
- **Notifications** — navigates to a page showing the full notification list

The sidebar reads from two sources:
- **User actor** (`userTaskFeed`) — provides sort order and "which tasks are relevant to this user"
- **Org actor** (`taskSummaries`) — provides task content (title, status, branch, PR state, session summaries)

The frontend merges these: org snapshot gives task data, user feed gives sort order. Uses the existing subscription system (`useSubscription`) for both initial state fetch and streaming updates.

### `updatedAtMs` column semantics

The org actor's `taskSummaries.updatedAtMs` and the user actor's `userTaskFeed.bumpedAtMs` serve different purposes:
- `taskSummaries.updatedAtMs` — updated by task actor push. Reflects the last time the task's global state changed (any mutation, any user). Used for "All Repositories" / "All Tasks" views.
- `userTaskFeed.bumpedAtMs` — updated by bump/notify commands. Reflects the last time this specific user's attention was drawn to this task. Used for the per-user sidebar sort.

Add doc comments on both columns clarifying the update source.

### Unread semantics

Each user has independent unread state. The existing `userTaskState` table tracks per-`(taskId, sessionId)` unread state. When the user clicks a session:
1. `userTaskState.unread` is set to 0 for that session
2. All `userNotifications` rows matching `(taskId, sessionId)` are marked `read = 1`

These two unread systems must stay in sync via the `user.mark_read` queue command.

## Better Auth: Actions, Not Queues

All Better Auth adapter operations (verification CRUD, session/email/account index mutations, and user-actor auth record mutations) are exposed as **actions**, not queue commands. This is an intentional exception to the normal pattern of using queues for mutations.

**Why:** The org actor's workflow queue is shared with GitHub sync, webhook processing, task mutations, and billing — 20+ queue names processed sequentially. During the OAuth callback, Better Auth needs to read/write verification records and upsert session/account indexes. If any long-running queue handler (e.g., a GitHub sync step) is ahead in the queue, auth operations time out (10s), `expectQueueResponse` throws a regular `Error`, and Better Auth's `parseState` catches it as a non-`StateError` → redirects to `?error=please_restart_the_process`.

**Why it's safe:** Auth operations are simple SQLite reads/writes scoped to a single actor instance with no cross-actor side effects. They don't need workflow replay semantics or sequential ordering guarantees relative to other queue commands.

**Rule:** Never move Better Auth operations back to queue commands. If new auth-related mutations are added, expose them as actions on the relevant actor.

## Maintenance

- Keep this file up to date whenever actor ownership, hierarchy, or lifecycle responsibilities change.
- If the real actor tree diverges from this document, update this document in the same change.
- When adding, removing, or renaming coordinator index tables, update the hierarchy diagram above in the same change.
- When adding a new coordinator index table in a schema file, add a doc comment identifying which child actor it indexes (pattern: `/** Coordinator index of {ChildActor} instances. ... */`).
