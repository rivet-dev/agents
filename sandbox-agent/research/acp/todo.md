# ACP v1 Migration TODO

Source docs:
- `research/acp/spec.md`
- `research/acp/migration-steps.md`
- `research/acp/00-delete-first.md`
- `research/acp/v1-schema-to-acp-mapping.md`
- `research/acp/friction.md`

Progress rule:
- [ ] Do not start the next phase until current phase gate is green in local + CI.
- [x] Log blockers/decisions in `research/acp/friction.md` during implementation.

## Phase 1: Teardown

Implementation:
- [x] Delete in-house protocol files/docs listed in `research/acp/00-delete-first.md`.
- [x] Remove deleted-crate deps from workspace `Cargo.toml` files.
- [x] Remove `/v1` route registration.
- [x] Add unified `/v1/*` removed handler (HTTP 410 + `application/problem+json`).
- [x] Remove/disable CLI `api` commands that target `/v1`.
- [x] Comment out/disable `/opencode/*` during ACP core bring-up.

Validation gate:
- [x] Project builds with v1 protocol code removed.
- [x] No references to `sandbox-agent-universal-agent-schema` remain.
- [x] `/v1/*` returns explicit "v1 removed" error (HTTP 410).
- [x] `/opencode/*` returns disabled/unavailable response.

## Phase 2: ACP Core Runtime

Implementation:
- [x] Add ACP runtime module + router integration.
- [x] Implement agent process process manager (spawn/supervise baseline).
- [x] Implement JSON-RPC bridge (`POST`/SSE <-> agent process stdio).
- [x] Add connection registry keyed by `X-ACP-Connection-Id`.
- [x] Implement unstable methods in v1 profile: `session/list`, `session/fork`, `session/resume`, `session/set_model`, `$/cancel_request`.
- [x] Implement explicit close path: `DELETE /v1/rpc`.

Validation gate:
- [x] End-to-end ACP flow over `/v1/rpc` (request/response + streamed notifications).
- [x] `session/cancel` behavior test passes.
- [x] HITL request/response round-trip test passes.
- [x] SSE ordering and `Last-Event-ID` replay test passes.
- [x] `DELETE /v1/rpc` idempotent double-close test passes.
- [x] Unstable method tests pass for agent processes that advertise support (mock covered).

## Phase 3: Installer Refactor

Implementation:
- [x] Replace agent-specific spawn contracts with agent process-centric spawn.
- [x] Add agent process install manifests + downloader logic.
- [x] Keep native agent installs where agent process depends on local CLI.
- [x] Add install verification command per agent process.
- [x] Integrate ACP registry metadata + fallback sources.
- [x] Expose install provenance (`registry` vs `fallback`) in API/CLI.
- [x] Implement lazy install on first `/v1/rpc` initialize.
- [x] Add per-agent install lock + idempotent install results.
- [x] Add config switch to disable lazy install for preprovisioned envs (`SANDBOX_AGENT_REQUIRE_PREINSTALL`).
- [ ] Fill out installers for all ACP registry agents (expand `AgentId` + per-agent installer mappings).

Validation gate:
- [x] Explicit install command tests pass for each supported agent.
- [x] Lazy install on first ACP initialize test passes (deterministic local-registry coverage added).
- [x] Reinstall/version/provenance assertions pass.
- [ ] Add integration coverage that every ACP registry agent has a corresponding installer mapping in `agent-management`.

## Phase 4: v1 HTTP API

Implementation:
- [x] Mount `POST /v1/rpc` and `GET /v1/rpc` (SSE).
- [x] Mount `DELETE /v1/rpc` close endpoint.
- [x] Add `GET /v1/health`, `GET /v1/agents`, `POST /v1/agents/{agent}/install`.
- [x] Integrate auth on ACP client lifecycle.
- [x] Keep `/ui/` and migrate inspector backend calls to ACP v1 transport.
- [x] Remove v1 OpenAPI surface from generated docs contract.

Validation gate:
- [x] Contract tests for `/v1` endpoints pass.
- [x] Auth tests pass (valid/missing/invalid token).
- [x] `/v1/*` removal contract test passes (HTTP 410 + stable payload).
- [x] Inspector ACP `agent-browser` flow test passes.
- [x] `DELETE /v1/rpc` close contract tests pass.
- [x] Error mapping tests are complete for every documented error path.

## Phase 5: SDK and CLI v1

Implementation:
- [x] Embed `@agentclientprotocol/sdk` in `sdks/typescript`.
- [x] Implement custom ACP-over-HTTP transport agent process in our SDK.
- [x] Wire inspector frontend client to ACP-over-HTTP primitives.
- [x] Add CLI commands for raw ACP envelopes + streaming ACP messages.
- [x] Remove or hard-fail v1-only SDK/CLI methods (`v1 removed`).
- [x] Regenerate docs for v1 ACP contract.

Validation gate:
- [x] TypeScript SDK end-to-end tests pass in embedded mode.
- [x] TypeScript SDK end-to-end tests pass in server mode.
- [x] Inspector end-to-end `agent-browser` tests pass using ACP-over-HTTP.
- [x] Add explicit parity test asserting `ClientSideConnection` usage contract.

## Phase 6: Test and Rollout

Implementation:
- [x] Replace v1 HTTP/session tests with ACP transport contract tests (core server + SDK).
- [x] Add smoke tests per supported agent process (claude/codex/opencode covered with deterministic ACP agent process stubs).
- [x] Add canary docs + migration notes.
- [x] Update docs for v1 ACP, `/v1/*` removal, inspector ACP behavior, and SDK usage.
- [x] Keep `/v1/*` hard-removed (HTTP 410).

Validation gate:
- [x] Full agent process matrix is green.
- [x] Install + prompt + stream smoke tests pass for each supported agent process.
- [x] Inspector `agent-browser` suite runs in CI path.
- [ ] Docs updates are published with rollout.

Notes:
- Remaining unchecked rollout items depend on docs publishing workflow outside this repo change set.
- Real credentialed agent process matrix runs are still environment-dependent; deterministic agent process matrix coverage is now in CI.

## Phase 7: OpenCode <-> ACP Bridge (Dedicated Step)

Implementation:
- [x] Keep `/opencode/*` disabled through Phases 1-6.
- [ ] Implement OpenCode <-> ACP bridge on top of v1 ACP runtime.
- [ ] Re-enable `server/packages/sandbox-agent/src/opencode_compat.rs` routes/tests.
- [ ] Add dedicated integration tests for OpenCode SDK/TUI flows through ACP v1 internals.

Validation gate:
- [ ] OpenCode compatibility suite passes against ACP-backed implementation.
- [ ] Regression tests confirm no dependency on removed in-house protocol runtime.

## Consolidated Test Suites (Must-Have)

- [x] ACP protocol conformance (beyond mock baseline).
- [x] `/v1/rpc` transport contract.
- [x] End-to-end agent process matrix (core + cancel + HITL + streaming).
- [x] Installer suite (explicit + lazy + provenance).
- [x] Security/auth isolation.
- [x] TypeScript SDK end-to-end (embedded + server).
- [x] v1 removal contract (`/v1/*` -> HTTP 410).
- [x] Inspector ACP suite (`agent-browser`).
- [ ] OpenCode <-> ACP bridge suite (Phase 7).

## Architecture: Connection vs Session Model

- [x] Align runtime with multi-session ACP expectations while keeping one backend process per `AgentId`.
  - ACP HTTP connections are logical client channels; server sessions are globally visible via aggregated `session/list`.
  - Backend process ownership is per agent type (shared per server), not per client connection.
  - Added connection-level session detachment extension `_sandboxagent/session/detach`.
  - Documented updated model in `research/acp/spec.md` and `research/acp/friction.md`.

## Newly discovered follow-ups

- [x] Add dedicated regression for `Last-Event-ID` handling in CLI `api acp stream`.
- [x] Add explicit test for `SANDBOX_AGENT_REQUIRE_PREINSTALL=true` behavior.
- [x] Improve server build-script invalidation for inspector embedding (avoid manual touch workaround when `dist/` appears after initial build).
- [ ] Integrate agent server logs into v1 observability surfaces (agent process/process logs available via control-plane and inspector), with redaction and end-to-end tests.

## Inspector Frontend Parity Follow-ups

- [ ] TODO: Implement session `permissionMode` preconfiguration in inspector ACP flow.
- [ ] TODO: Implement session `variant` preconfiguration in inspector ACP flow.
- [ ] TODO: Implement session `skills` source configuration in inspector ACP flow.
- [ ] TODO: Implement question request/reply/reject flow in inspector ACP flow.
- [ ] TODO: Implement agent mode discovery before session creation (replace cached/empty fallback).
- [ ] TODO: Dynamic Claude model loading — fetch models from Anthropic API (`GET https://api.anthropic.com/v1/models?beta=true`) using the user's credentials instead of hardcoded aliases (default/sonnet/opus/haiku). The old implementation cached results with coalesced in-flight requests and fell back to aliases for OAuth users. See commit `8ecd27b` for `fetch_claude_models()` and `agent_models()` cache logic. Current hardcoded fallback is in `router/support.rs::fallback_config_options()`.
- [ ] TODO: Dynamic Codex model loading — codex-acp (`github.com/zed-industries/codex-acp`) is installed and returns models via ACP `configOptions` in `session/new`. The config probe should pick these up automatically; investigate why the probe currently returns empty configOptions for Codex and fix. Once working, the hardcoded Codex fallbacks in `fallback_config_options()` become unused. See commit `8ecd27b` for old `fetch_codex_models()`.
- [ ] TODO: Replace inspector-local session list with server/global ACP-backed session inventory.
- [ ] TODO: Replace synthesized inspector event history with canonical ACP-backed history model.
