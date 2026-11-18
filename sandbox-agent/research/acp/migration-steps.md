# Concrete Migration Steps

## Phase Progression Rule

- Do not start the next phase until the current phase validation gate is green in local runs and CI.
- If a gate fails, log the issue in `research/acp/friction.md` before proceeding.
- “Green” means required tests pass end to end, not just unit tests.

## Consolidated Test Suites (Authoritative)

The migration test plan is intentionally collapsed to avoid duplicate coverage.

1. ACP protocol conformance
2. Transport contract (`/v1/rpc`)
3. End-to-end agent process matrix (core flow + cancel + HITL + streaming)
4. Installer suite (explicit + lazy + registry/fallback provenance)
5. Security/auth isolation
6. TypeScript SDK end-to-end (embedded + server, embedding `@agentclientprotocol/sdk`)
7. v1 removal contract suite (`/v1/*` returns HTTP 410 + stable payload)
8. Inspector ACP suite (mandatory `agent-browser` end-to-end automation)
9. OpenCode <-> ACP bridge suite (dedicated phase)

Inspector ACP suite requirements:

1. Must run through real browser automation with `agent-browser` against `/ui/`.
   Current script: `frontend/packages/inspector/tests/agent-browser.e2e.sh`.
2. Must not rely only on mocked component tests for pass criteria.
3. Must cover one simple flow: spawn agent/session, send message, verify response renders.
4. Must run in CI and block phase progression on failures.

## Phase 1: Teardown

1. Delete in-house protocol crates and docs listed in `research/acp/00-delete-first.md`.
2. Remove workspace dependencies on deleted crates from `Cargo.toml`.
3. Remove all `/v1` route registration and mount a unified `/v1/*` removed-handler (HTTP 410 + `application/problem+json`).
4. Remove/disable CLI `api` commands that target `/v1`.
5. Comment out/disable `/opencode/*` compat routes during ACP core bring-up.

Exit criteria:

- Project builds with v1 protocol code removed.
- No references to `sandbox-agent-universal-agent-schema` remain.
- Any `/v1/*` request returns explicit "v1 removed" error.
- `/opencode/*` is disabled (known broken) until Phase 7.

Validation gate:

- Build/test sanity after teardown compiles cleanly.
- Static checks confirm removed modules/types are no longer referenced.
- `/v1/*` returns HTTP 410 + stable error payload.
- `/opencode/*` returns disabled/unavailable response.

## Phase 2: ACP Core Runtime

1. Add ACP transport module in server package (`acp_runtime.rs` + router integration).
2. Implement agent process process manager (spawn, supervise, reconnect policy).
3. Implement JSON-RPC bridge: HTTP POST/SSE <-> agent process stdio.
4. Add connection registry keyed by `X-ACP-Connection-Id`.
5. Include unstable ACP methods in the v1 profile (`session/list`, `session/fork`, `session/resume`, `session/set_model`, `$/cancel_request`).

Exit criteria:

- End-to-end `initialize`, `session/new`, `session/prompt` works through one agent process.

Validation gate:

- End-to-end ACP flow test over `/v1/rpc` (request/response + streamed notifications).
- Cancellation test (`session/cancel`) with proper terminal response behavior.
- HITL request/response round-trip test (`session/request_permission` path).
- SSE ordering and reconnection behavior test (`Last-Event-ID` replay path).
- Explicit close test (`DELETE /v1/rpc`) including idempotent double-close behavior.
- Unstable ACP methods validation (`session/list`, `session/fork`, `session/resume`, `session/set_model`, `$/cancel_request`) for agent processes that advertise support.

## Phase 3: Installer Refactor

1. Replace agent-specific spawn contracts in `server/packages/agent-management/src/agents.rs` with agent process-centric spawn.
2. Add agent process install manifests and downloader logic.
3. Keep native agent install where agent process depends on local CLI.
4. Add install verification command per agent process.
5. Add ACP registry integration for install metadata + fallback sources.
6. Generate install instructions from manifest and expose provenance (`registry` or `fallback`) in API/CLI.
7. Implement lazy install path on first `/v1/rpc` initialize (with per-agent install lock and idempotent results).
8. Add config to disable lazy install for preprovisioned environments.

Exit criteria:

- `install` provisions both required binaries (agent + agent process) for supported agents.

Validation gate:

- Explicit install command tests for each supported agent.
- Lazy install on first ACP `initialize` test.
- Reinstall/version/provenance assertions.

## Phase 4: v1 HTTP API

1. Mount `/v1/rpc` POST and SSE endpoints.
2. Add `/v1/health`, `/v1/agents`, `/v1/agents/{agent}/install`.
3. Add auth integration on connection lifecycle.
4. Keep `/ui/` inspector route and migrate inspector backend calls to ACP v1 transport.
5. Remove v1 OpenAPI generation from default docs build.

Exit criteria:

- v1 endpoints documented and passing integration tests.

Validation gate:

- Contract tests for all `/v1` endpoints (`/v1/rpc`, `/v1/health`, `/v1/agents`, install).
- Auth tests (valid, missing, invalid token).
- Error mapping tests (bad envelope, unknown connection, timeout paths).
- `/v1/*` removal contract test (HTTP 410 + stable payload).
- Inspector ACP `agent-browser` flow tests pass.
- `DELETE /v1/rpc` close contract tests pass.

## Phase 5: SDK and CLI v1

1. Add ACP transport client in `sdks/typescript` by embedding `@agentclientprotocol/sdk` (no in-house ACP reimplementation).
2. Implement custom ACP-over-HTTP transport agent process in our SDK (official ACP client SDK does not provide required Streamable HTTP behavior out of the box).
3. Add inspector frontend client wiring to use ACP-over-HTTP transport primitives.
4. Add CLI commands for sending raw ACP envelopes and streaming ACP messages.
5. Remove v1-only SDK/CLI methods (or hard-fail with "v1 removed").
6. Regenerate docs to v1 ACP contract.

Exit criteria:

- SDK can complete a full ACP prompt turn over `/v1/rpc`.

Validation gate:

- TypeScript SDK end-to-end tests in both embedded and server modes.
- Parity tests ensuring SDK uses upstream ACP SDK primitives (no duplicate protocol stack).
- Inspector end-to-end `agent-browser` tests using ACP-over-HTTP transport.

## Phase 6: Test and Rollout

1. Replace v1 HTTP/session tests with ACP transport contract tests.
2. Add smoke tests per supported agent process.
   Current deterministic matrix: `server/packages/sandbox-agent/tests/v1_agent_process_matrix.rs`.
3. Add canary rollout notes directly in `docs/quickstart.mdx`, `docs/cli.mdx`, and `docs/sdks/typescript.mdx`.
4. Update docs for v1 ACP, `/v1/*` removal, inspector ACP behavior, and SDK usage.
5. Keep v1 endpoints hard-removed (`410`) until/unless a separate compatibility project is approved.

Exit criteria:

- CI is green on ACP-native tests only.

Validation gate:

- Full matrix run across all supported agent processes.
- Smoke tests for install + prompt + stream for each supported agent process.
- Inspector `agent-browser` suite passes in CI for ACP mode (`.github/workflows/ci.yaml`).
- Docs updates are published with the rollout.

## Phase 7: OpenCode <-> ACP Bridge (Dedicated Step)

1. Keep `/opencode/*` commented out/disabled through Phases 1-6.
2. Implement OpenCode <-> ACP bridge on top of v1 ACP runtime.
3. Re-enable `server/packages/sandbox-agent/src/opencode_compat.rs` routes/tests at full capability.
4. Add dedicated integration tests that validate OpenCode SDK/TUI flows through ACP v1 internals.

Exit criteria:

- OpenCode compatibility works through ACP internals (no fallback to legacy in-house protocol).

Validation gate:

- OpenCode compatibility suite passes against ACP-backed implementation.
- Regression tests ensure no dependency on removed in-house protocol runtime.

## Compatibility Layer (optional future project)

1. No compatibility layer is in the current v1 scope.
2. If later approved, it should be a separate project with a dedicated spec and test matrix.
