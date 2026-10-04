# Plan: OpenCode Adapter Package + ACP Journal Persistence

## Decisions Locked
- Move OpenCode support into its own Rust package: **yes**.
- Re-enable `/opencode/*` only after tests pass: **yes**.
- Persist ACP-side representation like the TypeScript SDK; convert to OpenCode response/event shapes at runtime: **yes**.
- Use `sqlx` + SQLite with WAL + migrations: **yes**.
- Session restoration strategy should be lazy (TS SDK-style): **yes**.
- Validation target is parity with current OpenCode compat suite, plus ACP-protocol gaps not currently covered: **yes**.
- Docs/behavior must clearly state: auto-restore handles runtime/session loss, but cannot recover if persistence storage is wiped: **yes**.

## Context
Current OpenCode compatibility logic lives in a large monolith (`server/packages/sandbox-agent/src/opencode_compat.rs`) and session bridge (`server/packages/sandbox-agent/src/opencode_session_manager.rs`). In the active ACP-v1 baseline, `/opencode/*` is disabled/unmounted and `sandbox-agent opencode` is disabled.

The TypeScript SDK already defines a stable persistence+restore model:
- Persist `SessionRecord` + envelope `SessionEvent` journal.
- Recreate stale sessions lazily.
- Inject replay context on the next prompt.

This plan ports that model into the Rust OpenCode adapter runtime.

## Goals
- Extract OpenCode compatibility into a dedicated package with clean boundaries.
- Rebuild session tracking/restore using a persisted ACP journal via SQLite (`sqlx`).
- Keep OpenCode-specific JSON shapes as runtime projections derived from persisted ACP records.
- Re-enable `/opencode/*` when parity tests + new ACP coverage pass.

## Non-Goals
- Full redesign of all OpenCode compat endpoint semantics in one pass.
- Replacing ACP core runtime behavior.
- Introducing Postgres in this phase (SQLite is canonical backend for adapter persistence).

## Package Architecture

### New package
- Add `server/packages/opencode-adapter` (crate name suggestion: `sandbox-agent-opencode-adapter`).
- Public entry points:
  - `build_opencode_router(state: Arc<AdapterAppState>) -> Router`
  - `OpenCodeAdapter::new(...)`
  - `OpenCodeAdapterConfig` (db path, replay limits, feature toggles)

### Responsibilities split
- `sandbox-agent` package:
  - Own server bootstrapping, auth, and top-level routing.
  - Mount `/opencode/*` by nesting adapter router.
- `opencode-adapter` package:
  - OpenCode HTTP handlers.
  - ACP bridge client/session orchestration.
  - ACP journal persistence (SQLite/sqlx).
  - Runtime projection from ACP journal -> OpenCode model/session/message/event views.

## Persistence Model (ACP Journal First)

Mirror TS SDK semantics in Rust.

### Tables (initial)
1. `sessions`
- `id TEXT PRIMARY KEY` (local/session ID exposed to OpenCode)
- `agent TEXT NOT NULL`
- `agent_session_id TEXT NOT NULL` (current live ACP session id)
- `last_connection_id TEXT NOT NULL`
- `created_at INTEGER NOT NULL`
- `destroyed_at INTEGER NULL`
- `session_init_json TEXT NULL` (JSON-encoded ACP `session/new` init payload)

2. `events`
- `id TEXT PRIMARY KEY`
- `session_id TEXT NOT NULL`
- `created_at INTEGER NOT NULL`
- `connection_id TEXT NOT NULL`
- `sender TEXT NOT NULL` (`client` or `agent`)
- `payload_json TEXT NOT NULL` (full ACP envelope JSON)
- index: `(session_id, created_at, id)`

3. `opencode_session_metadata` (small adjunct metadata table)
- `session_id TEXT PRIMARY KEY`
- `metadata_json TEXT NOT NULL`
- Stores OpenCode-specific metadata not guaranteed to be derivable from ACP envelope stream alone (title, parent, directory, project id, version, share url, permission mode).

Note: the canonical event history remains ACP envelopes; this metadata table is a projection cache/anchor for OpenCode-specific fields.

### SQLite settings
- Set `PRAGMA journal_mode=WAL` on initialization.
- Set `PRAGMA synchronous=NORMAL` (or `FULL` if we prioritize durability over throughput; default recommendation: `NORMAL` for compatibility throughput).
- Use `sqlx::migrate!()` with versioned migrations under package-local `migrations/`.

## Restore Algorithm (TS-style, Rust implementation)

For each session request (lazy restore trigger path):
1. Read persisted `sessions` row.
2. Ensure active ACP connection for the target `agent`.
3. If connection/session binding is still valid, continue.
4. If stale:
- Collect replay source from persisted `events` (last `replay_max_events`).
- Build replay text (bounded by `replay_max_chars`) from ACP envelopes:
  - include `createdAt`, `sender`, `payload` JSON line format.
  - append truncation marker if over limit.
- Recreate ACP session (`session/new` or `session/load`/`session/resume` depending on capabilities; fallback to `session/new` with stored init).
- Update persisted `agent_session_id` + `last_connection_id`.
- Queue replay injection for next prompt.
5. On first post-restore prompt, prepend replay text as text part (same pattern as TS SDK).

## Runtime Projection Strategy

Do not persist OpenCode wire payloads as source of truth.

- Build OpenCode session/message/state views from:
  - ACP journal (`events`)
  - session row (`sessions`)
  - metadata adjunct (`opencode_session_metadata`)
- Use projection reducers for:
  - session status (`idle/busy/error`)
  - message records and parts
  - tool call/result linkage
  - pending permission/question state
- Keep hot in-memory projection cache for active sessions; rebuild on process start from persisted rows/events.

## API + Routing Re-enable Plan

### Phase A: extraction scaffolding
- Create new adapter crate with minimal router + state wiring.
- Move code from `opencode_compat.rs` / `opencode_session_manager.rs` into adapter modules.
- Keep `/opencode/*` disabled while extraction is in progress.

### Phase B: persistence integration
- Add sqlx SQLite store + migrations.
- Replace in-memory canonical session/event tracking with persisted journal.
- Keep in-memory structures only as transient caches.

### Phase C: restore + replay
- Implement lazy restore path for stale bindings.
- Implement replay text generation + prompt injection.
- Ensure OpenCode message/prompt endpoints use restored session path automatically.

### Phase D: re-enable
- Mount adapter router under `/opencode` in `sandbox-agent` router.
- Re-enable CLI `opencode` command path after tests are green.

## ACP Coverage Additions (Beyond Current OpenCode Compat Parity)

Add adapter support/tests for ACP capabilities that are relevant but not fully exercised by current compat suite:
- `session/load` / `session/resume` path handling when available.
- `session/fork` bridging through ACP when supported.
- `session/cancel` correctness from OpenCode abort flows.
- Proper handling of ACP notifications and request/response ordering through reconnect/restore windows.
- Preservation of `_sandboxagent/...` extension method naming (no `/v1/` in method prefix).

## Test Plan

## 1) Existing parity suite (must pass)
- `server/packages/sandbox-agent/tests/opencode-compat/*`
- Keep compatibility behavior for session, messaging, events, models, permissions, questions, tools.

## 2) New persistence/restore tests (required)
- Restart test: create session + message, restart server, verify `/opencode/session` + messages restore.
- Lazy restore test: stale connection forces restore on first prompt and succeeds.
- Replay injection test: confirm replay preamble is injected once after restore.
- Storage loss test: wiping DB causes non-recoverable sessions (expected behavior, explicit assertion).

## 3) ACP gap tests (required)
- `session/cancel` round-trip from OpenCode abort endpoint.
- `session/load`/`session/resume` (if runtime advertises capability).
- `session/fork` mapping with parent linkage preserved in metadata projection.

## 4) Migration and WAL tests
- Migration bootstrap from empty DB succeeds.
- WAL mode enabled at runtime.
- Projection rebuild from persisted events produces deterministic session/message views.

## Rollout / Gate

Only re-enable `/opencode/*` and CLI `opencode` command after:
1. OpenCode compat parity suite passes.
2. New persistence/restore tests pass.
3. ACP gap tests above pass.
4. No regressions in `/v1/*` ACP core tests.

## Implementation Checklist
- [ ] Create `server/packages/opencode-adapter` crate.
- [ ] Add workspace dependency wiring (`Cargo.toml` root + package Cargo files).
- [ ] Port OpenCode handlers/session bridge into adapter modules.
- [ ] Add sqlx dependency/features and migration framework.
- [ ] Implement SQLite journal store (`sessions`, `events`, metadata table).
- [ ] Implement lazy restore + replay injection.
- [ ] Implement runtime projection reducer from ACP events.
- [ ] Mount `/opencode` router in `sandbox-agent` only after tests are green.
- [ ] Re-enable CLI `opencode` command.
- [ ] Update docs (OpenCode compatibility + session restoration semantics).

## Risks / Mitigations
- Risk: Projection bugs produce subtle OpenCode shape mismatches.
  - Mitigation: golden/event-sequence tests + parity SDK tests.
- Risk: replay payload growth impacts prompt quality.
  - Mitigation: strict `replay_max_events` + `replay_max_chars` bounds.
- Risk: process restart while turn in-flight causes partial state.
  - Mitigation: projection derives terminal/active status from event phases; explicit stale-turn reconciliation rule.

## Explicit Behavior Contract
- Sessions are automatically restorable when live runtime/session state is lost, as long as persisted storage remains.
- If persistence storage is lost/wiped, prior sessions cannot be restored.
