# ACP Migration Friction Log

Track every ACP migration issue that creates implementation friction, unclear behavior, or product risk.

Update this file continuously during the migration.

## Entry template

- Date:
- Area:
- Issue:
- Impact:
- Proposed direction:
- Decision:
- Owner:
- Status: `open` | `in_progress` | `resolved` | `deferred`
- Links:

## Entries

- Date: 2026-02-10
- Area: Agent process availability
- Issue: Amp does not have a confirmed official ACP agent process in current ACP docs/research.
- Impact: Blocks full parity if Amp is required in v1 launch scope.
- Proposed direction: Treat Amp as conditional for v1.0 and support via pinned fallback only if agent process source is validated.
- Decision: Open.
- Owner: Unassigned.
- Status: open
- Links: `research/acp/acp-notes.md`

- Date: 2026-02-10
- Area: Transport
- Issue: ACP streamable HTTP is still draft upstream; v1 requires ACP over HTTP now.
- Impact: Potential divergence from upstream HTTP semantics.
- Proposed direction: Use strict JSON-RPC mapping and keep transport shim minimal/documented for later alignment.
- Decision: Open.
- Owner: Unassigned.
- Status: open
- Links: `research/acp/spec.md`

- Date: 2026-02-10
- Area: OpenCode compatibility sequencing
- Issue: OpenCode compatibility must be preserved but not block ACP core rewrite.
- Impact: Risk of core rewrites being constrained by legacy compat behavior.
- Proposed direction: Disable/comment out `/opencode/*` during ACP core bring-up, then re-enable via dedicated bridge step after core is stable.
- Decision: Accepted.
- Owner: Unassigned.
- Status: in_progress
- Links: `research/acp/migration-steps.md`

- Date: 2026-02-10
- Area: TypeScript SDK layering
- Issue: Risk of duplicating ACP protocol logic in our TS SDK instead of embedding upstream ACP SDK.
- Impact: Drift from ACP semantics and higher maintenance cost.
- Proposed direction: Embed `@agentclientprotocol/sdk` and keep our SDK as wrapper/convenience layer.
- Decision: Accepted.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/spec.md`

- Date: 2026-02-10
- Area: Installer behavior
- Issue: Lazy agent process install can race under concurrent first-use requests.
- Impact: Duplicate downloads, partial installs, or bootstrap failures.
- Proposed direction: Add per-agent install lock + idempotent install path used by both explicit install and lazy install.
- Decision: Accepted and implemented.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/spec.md`

- Date: 2026-02-10
- Area: ACP over HTTP standardization
- Issue: Community is actively piloting both Streamable HTTP and WebSocket; no final single transport profile has emerged yet.
- Impact: Risk of rework if we overfit to one draft behavior that later shifts.
- Proposed direction: Lock v1 public contract to Streamable HTTP with ACP JSON-RPC payloads, keep implementation modular so WebSocket can be added later without breaking v1 API.
- Decision: Accepted.
- Owner: Unassigned.
- Status: in_progress
- Links: `research/acp/acp-over-http-findings.md`, `research/acp/spec.md`

- Date: 2026-02-10
- Area: Session lifecycle surface
- Issue: ACP stable does not include v1-equivalent methods for session listing, explicit session termination/delete, or event-log polling.
- Impact: Direct lift-and-shift of the legacy session REST list, terminate, and event-polling behavior is not possible with ACP core only.
- Proposed direction: Define `_sandboxagent/session/*` extension methods for these control operations, while keeping core prompt flow on standard ACP methods.
- Decision: Open.
- Owner: Unassigned.
- Status: open
- Links: `research/acp/v1-schema-to-acp-mapping.md`, `research/acp/spec.md`

- Date: 2026-02-10
- Area: HITL question flow
- Issue: ACP stable defines `session/request_permission` but not a generic question request/response method matching v1 `question.*` and question reply endpoints.
- Impact: Existing question UX cannot be represented with standard ACP methods alone.
- Proposed direction: Introduce `_sandboxagent/session/request_question` extension request/response and carry legacy shape via `_meta`.
- Decision: Open.
- Owner: Unassigned.
- Status: open
- Links: `research/acp/v1-schema-to-acp-mapping.md`

- Date: 2026-02-10
- Area: Filesystem parity
- Issue: ACP stable filesystem methods are text-only (`fs/read_text_file`, `fs/write_text_file`), while v1 exposes raw bytes plus directory operations.
- Impact: Binary file reads/writes, archive upload, and directory management cannot map directly to ACP core.
- Proposed direction: Use ACP standard methods for UTF-8 text paths; add `_sandboxagent/fs/*` extensions for binary and directory operations.
- Decision: Open.
- Owner: Unassigned.
- Status: open
- Links: `research/acp/v1-schema-to-acp-mapping.md`

- Date: 2026-02-10
- Area: v1 decommissioning
- Issue: Ambiguity between "comment out v1" and "remove v1" causes rollout confusion.
- Impact: Risk of partial compatibility behavior and extra maintenance burden.
- Proposed direction: Hard-remove v1 behavior and return a stable HTTP 410 error for all `/v1/*` routes.
- Decision: Accepted.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/spec.md`, `research/acp/migration-steps.md`

- Date: 2026-02-10
- Area: TypeScript ACP-over-HTTP client support
- Issue: Official ACP client SDK does not currently provide the exact Streamable HTTP transport behavior required by this project.
- Impact: SDK cannot target `/v1/rpc` without additional transport implementation.
- Proposed direction: Embed upstream ACP SDK types/lifecycle and implement a project transport agent process for ACP-over-HTTP.
- Decision: Accepted.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/spec.md`, `research/acp/migration-steps.md`

- Date: 2026-02-10
- Area: Inspector migration
- Issue: Inspector currently depends on v1 session/event surfaces.
- Impact: Inspector breaks after v1 removal unless migrated to ACP transport.
- Proposed direction: Keep `/ui/` route and migrate inspector runtime calls to ACP-over-HTTP; add dedicated inspector ACP tests.
- Decision: Accepted.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/spec.md`, `research/acp/migration-steps.md`

- Date: 2026-02-10
- Area: Inspector asset embedding
- Issue: If `cargo build` runs before `frontend/packages/inspector/dist` exists, the build script can cache inspector-disabled embedding state.
- Impact: Local runs can serve `/ui/` as disabled even after inspector is built, unless Cargo reruns the build script.
- Proposed direction: Improve build-script invalidation to detect dist directory appearance/disappearance without manual rebuild nudges.
- Decision: Implemented by watching the inspector package directory in `build.rs` so Cargo reruns when dist appears/disappears.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/sandbox-agent/build.rs`, `research/acp/todo.md`

- Date: 2026-02-10
- Area: Deterministic ACP install tests
- Issue: Installer and lazy-install tests were coupled to the live ACP registry, causing non-deterministic test behavior.
- Impact: Flaky CI and inability to reliably validate install provenance and lazy install flows.
- Proposed direction: Add `SANDBOX_AGENT_ACP_REGISTRY_URL` override and drive tests with a local one-shot registry fixture.
- Decision: Accepted and implemented.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/agent-management/src/agents.rs`, `server/packages/sandbox-agent/tests/v1_api.rs`

- Date: 2026-02-10
- Area: Inspector E2E tooling
- Issue: `agent-browser` invocation under pnpm emits npm env warnings (`store-dir`, `recursive`) during scripted runs.
- Impact: No functional break, but noisy CI logs and possible future npm strictness risk.
- Proposed direction: Keep `npx -y agent-browser` script for now; revisit pinning/install strategy if warnings become hard failures.
- Decision: Accepted.
- Owner: Unassigned.
- Status: open
- Links: `frontend/packages/inspector/tests/agent-browser.e2e.sh`

- Date: 2026-02-10
- Area: Real agent process matrix rollout
- Issue: Full agent process smoke coverage requires provider credentials and installed real agent processes in CI/runtime environments.
- Impact: Phase-6 "full matrix green" and "install+prompt+stream per agent process" cannot be marked complete in local-only runs.
- Proposed direction: Keep deterministic agent process matrix in default CI (stub ACP agent processes for claude/codex/opencode) and run real credentialed agent processes in environment-specific jobs.
- Decision: Accepted.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/todo.md`

- Date: 2026-02-10
- Area: Inspector v1-to-v1 compatibility
- Issue: Restored inspector UI expects legacy `/v1` session/event contracts that no longer exist in ACP-native v1.
- Impact: Full parity would block migration; inspector would otherwise fail to run against v1.
- Proposed direction: Keep the restored UI and bridge to ACP with a thin compatibility client (`src/lib/legacyClient.ts`), stubbing non-parity features with explicit `TDOO` markers.
- Decision: Accepted.
- Owner: Unassigned.
- Status: open
- Links: `frontend/packages/inspector/src/lib/legacyClient.ts`, `research/acp/inspector-unimplemented.md`

- Date: 2026-02-10
- Area: Multi-client session visibility + process sharing
- Issue: Existing ACP runtime mapped one HTTP ACP connection to one dedicated agent process, which prevented global session visibility and increased process count.
- Impact: Clients could not discover sessions created by other clients; process utilization scaled with connection count instead of agent type.
- Proposed direction: Use one shared backend process per `AgentId`, maintain server-owned in-memory meta session registry across all connections, intercept `session/list` as a global aggregated view, and add an experimental detach extension (`_sandboxagent/session/detach`) for connection-level session detachment.
- Decision: Accepted and implemented.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/sandbox-agent/src/acp_runtime/mod.rs`, `server/packages/sandbox-agent/src/acp_runtime/mock.rs`, `server/packages/sandbox-agent/tests/v1_api.rs`, `server/packages/sandbox-agent/tests/v1_agent_process_matrix.rs`

- Date: 2026-02-10
- Area: TypeScript SDK package split and ACP lifecycle
- Issue: `sandbox-agent` SDK exposed ACP transport primitives directly (`createAcpClient`, raw envelope APIs, ACP type re-exports), making the public API ACP-heavy.
- Impact: Harder to keep a simple Sandbox-facing API while still supporting protocol-faithful ACP HTTP behavior and Sandbox metadata/extensions.
- Proposed direction: Split into `acp-http-client` (pure ACP HTTP transport/client) and `sandbox-agent` (`SandboxAgentClient`) as a thin wrapper with metadata/event conversion and extension helpers.
- Decision: Accepted and implemented.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/ts-client.md`, `sdks/acp-http-client/src/index.ts`, `sdks/typescript/src/client.ts`

- Date: 2026-02-10
- Area: Streamable HTTP transport contract
- Issue: Ambiguity over whether `/v1/rpc` should track MCP transport negotiation (`POST` accepting SSE responses, multi-stream fanout) versus Sandbox Agent's simpler JSON-only POST contract.
- Impact: Without an explicit contract, clients can assume incompatible Accept/media semantics and open duplicate GET streams that receive duplicate events.
- Proposed direction: Define Sandbox Agent transport profile explicitly: `POST /v1/rpc` is JSON-only (`Content-Type` and `Accept` for `application/json`), `GET /v1/rpc` is SSE-only (`Accept: text/event-stream`), and allow only one active SSE stream per ACP connection id.
- Decision: Accepted and implemented.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/sandbox-agent/src/router.rs`, `server/packages/sandbox-agent/src/acp_runtime/mod.rs`, `server/packages/sandbox-agent/tests/v1_api/acp_transport.rs`, `docs/advanced/acp-http-client.mdx`

- Date: 2026-03-13
- Area: Actor runtime shutdown and draining
- Issue: Actors can continue receiving or finishing action work after shutdown has started, while actor cleanup clears runtime resources such as the database handle. In RivetKit this can surface as `Database not enabled` from `c.db` even when the actor definition correctly includes `db`.
- Impact: User requests can fail with misleading internal errors during runner eviction or shutdown, and long-lived request paths can bubble up as HTTP 502/timeout failures instead of a clear retryable stopping/draining signal.
- Proposed direction: Add a real runner draining state so actors stop receiving traffic before shutdown, and ensure actor cleanup does not clear `#db` until in-flight actions are fully quiesced or aborted. App-side request paths should also avoid waiting inline on long actor workflows when possible.
- Decision: Open.
- Owner: Unassigned.
- Status: open
- Links: `foundry/packages/backend/src/actors/workspace/app-shell.ts`, `/Users/nathan/rivet/rivetkit-typescript/packages/rivetkit/src/actor/instance/mod.ts`, `/Users/nathan/rivet/rivetkit-typescript/packages/rivetkit/src/drivers/engine/actor-driver.ts`

- Date: 2026-03-12
- Area: Foundry RivetKit serverless routing on Railway
- Issue: Moving Foundry from `/api/rivet` to `/v1/rivet` exposed three RivetKit deployment couplings: `serverless.basePath` had to be updated explicitly for metadata/start routes, `configureRunnerPool` could not be used in production because the current Rivet token lacked permission to list datacenters, and wrapping `registry.handler(c.req.raw)` inside Hono route handlers produced unstable serverless runner startup under Railway until `/v1/rivet` was dispatched directly from `Bun.serve`.
- Impact: `GET /v1/rivet/metadata` initially returned 404, app-shell actor creation failed during OAuth/session bootstrap, and Foundry sign-in blocked on `500` from `/v1/app/snapshot` and `/v1/auth/github/start`.
- Proposed direction: Treat RivetKit serverless base path as an explicit deployment config when versioning routes, avoid relying on runner-pool auto-configuration unless the production token has the required Rivet control-plane permissions, and prefer direct top-level dispatch for RivetKit serverless routes instead of routing them through higher-level Hono middleware.
- Decision: Accepted and implemented for Foundry. The backend now sets `serverless.basePath` to `/v1/rivet`, leaves runner-pool config to infrastructure, and serves RivetKit directly from the Bun server for `/v1/rivet`.
- Owner: Unassigned.
- Status: resolved
- Links: `foundry/packages/backend/src/actors/index.ts`, `foundry/packages/backend/src/index.ts`

- Date: 2026-02-10
- Area: Agent selection contract for ACP bootstrap/session creation
- Issue: `x-acp-agent` bound agent selection to transport bootstrap, which conflicted with Sandbox Agent meta-session goals where one client can manage sessions across multiple agents.
- Impact: Connections appeared agent-affine; agent selection was hidden in HTTP headers rather than explicit in ACP payload metadata.
- Proposed direction: Hard-remove `x-acp-agent`; require `params._meta["sandboxagent.dev"].agent` on `initialize` and `session/new`, and require `params.agent` for agent-routed calls that have no resolvable `sessionId`.
- Decision: Accepted and implemented.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/sandbox-agent/src/router.rs`, `server/packages/sandbox-agent/src/acp_runtime/helpers.rs`, `server/packages/sandbox-agent/src/acp_runtime/mod.rs`, `server/packages/sandbox-agent/src/acp_runtime/ext_meta.rs`, `server/packages/sandbox-agent/tests/v1_api/acp_transport.rs`

- Date: 2026-02-11
- Area: ACP server simplification
- Issue: Current `/v1/rpc` runtime includes server-managed metadata/session registry and `_sandboxagent/*` ACP extensions, while the new direction is a dumb stdio proxy keyed by client-provided ACP server id.
- Impact: Requires removing extension/metadata semantics and reshaping transport to `/v1/acp/{server_id}` with per-id subprocess lifecycle.
- Proposed direction: Replace `/v1/rpc` with `/v1/acp/{server_id}` (`POST`/`GET` SSE/`DELETE`), drop connection-id headers, keep replay by `server_id`, move non-ACP concerns to HTTP endpoints, and disable OpenCode routes.
- Decision: Accepted (spec drafted).
- Owner: Unassigned.
- Status: in_progress
- Links: `research/acp/simplify-server.md`

- Date: 2026-02-11
- Area: Directory-scoped config ownership
- Issue: MCP/skills config previously traveled with session initialization payloads; simplified server needs standalone HTTP config scoped by directory.
- Impact: Requires new HTTP APIs and clear naming for per-directory/per-entry operations without ACP extension transport.
- Proposed direction: Add directory-scoped query APIs: `/v1/config/mcp?directory=...&mcpName=...` and `/v1/config/skills?directory=...&skillName=...` (name required), using v1 payload shapes for MCP/skills config values.
- Decision: Accepted (spec updated).
- Owner: Unassigned.
- Status: in_progress
- Links: `research/acp/simplify-server.md`, `docs/mcp-config.mdx`, `docs/skills-config.mdx`

- Date: 2026-03-10
- Area: ACP HTTP client transport reentrancy for human-in-the-loop requests
- Issue: The TypeScript `acp-http-client` serialized the full lifetime of each POST on a single write queue. A long-running `session/prompt` request therefore blocked the client from POSTing a response to an agent-initiated `session/request_permission`, deadlocking permission approval flows.
- Impact: Permission requests arrived over SSE, but replying to them never resumed the original prompt turn. This blocked Claude and any other ACP agent using `session/request_permission`.
- Proposed direction: Make the HTTP transport fire POSTs asynchronously after preserving outbound ordering at enqueue time, rather than waiting for the entire HTTP response before the next write can begin. Keep response bodies routed back into the readable stream so request promises still resolve normally.
- Decision: Accepted and implemented in `acp-http-client`.
- Owner: Unassigned.
- Status: resolved
- Links: `sdks/acp-http-client/src/index.ts`, `sdks/acp-http-client/tests/smoke.test.ts`, `sdks/typescript/tests/integration.test.ts`

- Date: 2026-03-07
- Area: Desktop host/runtime API boundary
- Issue: Desktop automation needed screenshot/input/file-transfer-like host capabilities, but routing it through ACP would have mixed agent protocol semantics with host-owned runtime control and binary payloads.
- Impact: A desktop feature built as ACP methods would blur the division between agent/session behavior and Sandbox Agent host/runtime APIs, and would complicate binary screenshot transport.
- Proposed direction: Ship desktop as first-party HTTP endpoints under `/v1/desktop/*`, keep health/install/remediation in the server runtime, and expose the feature through the SDK and inspector without ACP extension methods.
- Decision: Accepted and implemented for phase one.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/sandbox-agent/src/router.rs`, `server/packages/sandbox-agent/src/desktop_runtime.rs`, `sdks/typescript/src/client.ts`, `frontend/packages/inspector/src/components/debug/DesktopTab.tsx`
