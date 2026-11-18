# V1 Spec: ACP Over HTTP

## 0) Delete/Remove First

Before implementing v1, remove in-house protocol files and remove v1 API behavior as documented in:

- `research/acp/00-delete-first.md`
- `research/acp/v1-schema-to-acp-mapping.md` (endpoint/event-by-event conversion target)

This is mandatory to prevent dual-protocol drift.

## 1) Goals

- v1 is intentionally breaking and ACP-native.
- Internal runtime uses ACP end-to-end (no custom universal event schema).
- Existing agent managers are replaced with ACP agent process runtimes.
- v1 API is completely removed; all `/v1/*` requests return explicit removed errors.
- OpenCode <-> ACP support is preserved as a product requirement, but implemented in a separate step after ACP core is stable.

## 2) Non-goals for first v1 cut

- No guarantee of v1 endpoint compatibility.
- No v1 compatibility layer in the initial v1 release.
- No OpenCode compatibility during ACP core bring-up (`/opencode/*` is disabled until the dedicated bridge step).
- No in-house universal event format.

## 3) Protocol baseline

Use ACP v1 schema from:

- `~/misc/acp-docs/schema/schema.json`
- `~/misc/acp-docs/schema/meta.json`
- `research/acp/v1-schema-to-acp-mapping.md` (required for preserving v1 feature coverage during migration)

Supported agent methods (minimum):

- `initialize`, `authenticate` (if needed), `session/new`, `session/prompt`, `session/cancel`

Supported client methods (minimum):

- `session/request_permission`

Included unstable ACP methods for v1 profile:

- `session/list`
- `session/fork`
- `session/resume`
- `session/set_model`
- `$/cancel_request`

Phase-1 optional methods (still optional per agent process capability):

- `fs/read_text_file`, `fs/write_text_file`
- `terminal/*`
- `session/load`, `session/set_mode`, `session/set_config_option`

Sandbox Agent ACP extension methods currently implemented:

- `_sandboxagent/session/detach`
- `_sandboxagent/session/list_models`
- `_sandboxagent/session/set_metadata`
- `_sandboxagent/session/request_question` (agent -> client request pattern)
- `_sandboxagent/session/terminate`
- `_sandboxagent/session/ended` (runtime -> client notification)

## 4) Transport: ACP over HTTP (repo-specific draft)

ACP streamable HTTP is draft upstream, so this spec defines a concrete transport that stays close to current ACP transport guidance and JSON-RPC semantics.

### 4.1 Endpoints

- `POST /v1/rpc`
- `GET /v1/rpc` (SSE stream, `Accept: text/event-stream`)
- `DELETE /v1/rpc` (explicit connection close)

### 4.2 Connection model

- Each ACP HTTP connection maps to a logical client connection id (`X-ACP-Connection-Id`).
- Agent processes are shared per `AgentId` (one backend process per agent type on a server), not per HTTP connection.
- Session inventory is server-global in memory across connections; `session/list` returns this aggregated inventory.
- Connection identity is `X-ACP-Connection-Id` header.
- First `initialize` request may omit `X-ACP-Connection-Id` and must include `params._meta["sandboxagent.dev"].agent`.
- Server ensures backend exists for that agent, creates connection, returns `X-ACP-Connection-Id` in response headers.
- All subsequent `POST /v1/rpc` and `GET /v1/rpc` requests must include `X-ACP-Connection-Id`.
- `DELETE /v1/rpc` with `X-ACP-Connection-Id` detaches/closes only the transport connection and releases connection-scoped resources.
- `DELETE /v1/rpc` does not terminate the session or agent process. Session termination is explicit via `_sandboxagent/session/terminate`.

### 4.3 Message routing

- Client -> agent requests/notifications: sent as JSON-RPC payloads to `POST /v1/rpc`.
- Agent -> client notifications/requests: delivered on `GET /v1/rpc` SSE stream as JSON-RPC envelopes.
- Client replies to agent-initiated requests by POSTing JSON-RPC responses to `POST /v1/rpc`.

### 4.4 SSE framing

- `event: message`
- `id: <monotonic-sequence>`
- `data: <single JSON-RPC object>`

Keepalive:

- SSE comment heartbeat every 15s.

Resume:

- `Last-Event-ID` accepted for best-effort replay from in-memory ring buffer.

### 4.5 HTTP status and errors

- JSON-RPC request success: HTTP 200 with JSON-RPC response object.
- JSON-RPC notification accepted: HTTP 202, empty body.
- Invalid envelope: HTTP 400 with `application/problem+json`.
- Unknown connection: HTTP 404 with `application/problem+json`.
- Server timeout waiting on agent process response: HTTP 504 with `application/problem+json`.
- Successful `DELETE /v1/rpc`: HTTP 204.
- Repeated `DELETE /v1/rpc` on an already-closed connection: HTTP 204 (idempotent close).
- All `/v1/*` endpoints: HTTP 410 with `application/problem+json` and message `v1 API removed; use /v1`.

Note: ACP method-level failures still return JSON-RPC error objects inside 200 responses.

### 4.6 Ordering and concurrency

- Per-connection outbound SSE order is preserved.
- JSON-RPC `id` is opaque and passed through unchanged.
- Multiple in-flight requests are allowed.

### 4.7 Security

- Reuse existing bearer token auth middleware.
- Validate bearer auth at request time for `/v1/*` routes when configured.
- ACP runtime connection ids are in-memory server ids and are not additionally principal-scoped inside runtime.
- Do not expose agent process stderr on stdout channel.

### 4.8 Field research alignment (2026-02-10)

Based on current ACP community implementations/discussion:

- Streamable HTTP and WebSocket are both being piloted.
- Streamable HTTP implementations are converging on MCP-like request patterns while keeping ACP JSON-RPC payloads.
- WebSocket implementations report simpler handling for bidirectional/server-initiated ACP traffic.

Decision for this repo:

- v1 public transport remains Streamable HTTP (`POST`/`GET` SSE over `/v1/rpc`) as the canonical contract.
- WebSocket transport is not part of initial v1 surface; consider later only if HTTP profile proves insufficient operationally.

Reference:

- `research/acp/acp-over-http-findings.md`

## 5) Agent process runtime and install model

## 5.1 Runtime

Replace custom per-agent protocol parsers with one ACP agent process process contract:

- Spawn ACP agent process binary (stdio JSON-RPC).
- Bridge stdio <-> internal ACP client dispatcher.
- No agent-specific JSON parsing in server core.

## 5.2 Installers

Current auto-installer installs native CLIs. v1 installer must install:

- native agent binary (if needed by agent process)
- ACP agent process binary required for that agent

Add a manifest-driven mapping (new file to create in implementation phase):

- `claude`: agent process `claude-code-acp`
- `codex`: agent process `codex-acp`
- `opencode`: native ACP mode (agent process optional)
- `amp`: pending decision (official agent process required or unsupported in v1 initial release)

## 5.3 ACP Registry install instructions

Yes, this must be handled.

V1 installer/docs must include install instructions sourced from ACP registry metadata where available, with explicit fallback for non-registry agent processes.

Requirements:

- Maintain a local agent process manifest with:
  - registry slug (if present)
  - agent process package/repo source
  - native agent dependency
  - supported platform matrix
  - install verification command
- Prefer ACP registry source of truth when agent process is published there.
- If agent process is not in registry, use pinned fallback source and mark as `non_registry`.
- Support `SANDBOX_AGENT_ACP_REGISTRY_URL` override for controlled/test environments.
- Generate user-facing install instructions from this manifest (do not hand-maintain per-agent docs).
- Expose install provenance in API/CLI (`registry` vs `fallback`).

Output surfaces:

- `GET /v1/agents`: include agent process install source + verification status.
- `POST /v1/agents/{agent}/install`: return concrete installed artifacts and source provenance.

## 5.4 Install commands and lazy agent process install

This must match current ergonomics where installs can be explicit or automatic.

Explicit install interfaces:

- API: `POST /v1/agents/{agent}/install`
- CLI (v1 surface): `sandbox-agent api v1 agents install <agent> [--reinstall] [--agent-version <v>] [--agent process-version <v>]`

Lazy install behavior (default on):

- Trigger point: first ACP bootstrap request (`initialize`) on `/v1/rpc` with `params._meta["sandboxagent.dev"].agent`.
- If required binaries are missing, server installs:
  - ACP agent process
  - native agent binary if agent process requires it
- Then server starts the agent process process and continues normal ACP handshake.

Operational requirements:

- Per-agent install lock to prevent duplicate concurrent downloads.
- Idempotent install response when artifacts already exist.
- Clear provenance in result (`registry` vs `fallback`) plus concrete artifact versions.
- Config switch to disable lazy install (`require_preinstall=true`) for controlled environments.

## 6) Public v1 API shape

Expose ACP directly, not custom session endpoints.

- `POST /v1/rpc`: transport write path
- `GET /v1/rpc`: transport read path (SSE)

Non-ACP endpoints retained in v1:

- `GET /v1/health`
- `GET /v1/agents` (capabilities + install status)
- `POST /v1/agents/{agent}/install`
- `GET /v1/fs/file`
- `PUT /v1/fs/file`
- `POST /v1/fs/upload-batch`
- `GET /ui/` (Inspector UI shell)

Agent discovery note:

- Do not add standalone `/v1/agents/{agent}/models` or `/v1/agents/{agent}/modes` endpoints.
- Expose optional `models`/`modes` properties on agent response payloads when the agent is installed.

Legacy endpoints retained only as removals:

- `ALL /v1/*` return HTTP 410 with a stable "v1 removed" error body.
- `/opencode/*` is commented out/disabled until Phase 7 and is expected to be broken during ACP core bring-up.

Everything related to prompting/sessions/permissions/tools happens through ACP JSON-RPC messages.

## 6.3 Filesystem Boundary (Intentional)

Sandbox Agent keeps a separate host-owned filesystem API from ACP native filesystem methods.

Rationale:

- ACP `fs/*` methods are agent-protocol capabilities and can vary by agent implementation.
- Sandbox Agent filesystem HTTP endpoints are host/runtime capabilities and should behave consistently across all agents.
- Large binary transfers (raw file read/write and tar upload) need streaming-friendly HTTP behavior; ACP JSON-RPC envelopes are not suitable for super-large binary payload transport.
- `GET /v1/fs/file` specifically benefits from HTTP response streaming for large reads.

For this reason, `GET /v1/fs/file`, `PUT /v1/fs/file`, and `POST /v1/fs/upload-batch` remain dedicated HTTP endpoints even as other static control APIs migrate to ACP extensions.

Parallel ACP compatibility is still supported:

- Keep ACP extension variants in parallel for these operations.
- ACP and HTTP variants should call into the same underlying filesystem service logic so behavior remains consistent.
- ACP variants are not intended for very large file transfer; SDK defaults should prefer HTTP for these methods.

## 6.1 TypeScript SDK integration (mandatory)

Use the existing ACP TypeScript SDK (`@agentclientprotocol/sdk`) inside our SDK implementation.

Rules:

- Do not build a second in-house ACP protocol implementation in `sdks/typescript`.
- Wrap and embed ACP SDK primitives (`ClientSideConnection`/transport handling) in our SDK surface.
- Implement our own ACP-over-HTTP transport agent process for the SDK because the official ACP client SDK does not currently provide our required Streamable HTTP client behavior out of the box.
- Keep our SDK focused on:
  - auth/token handling
  - endpoint/bootstrap convenience
  - spawn/embedded server ergonomics
  - product-specific helper APIs
- ACP message framing, JSON-RPC lifecycle, and protocol object modeling should come from upstream ACP SDK.

## 6.2 Inspector (mandatory)

The inspector must be ACP-native in v1.

- Replace v1 session/event calls in inspector with ACP-over-HTTP connection flow (`initialize`, `session/new`, `session/prompt`, streamed `session/update`).
- Add inspector support for rendering raw ACP envelopes and decoded session updates.
- Keep inspector route at `/ui/`; remove dependency on v1 REST session endpoints.
- Inspector end-to-end verification is mandatory via `agent-browser` automation (not only unit/integration tests).

## 7) Data model changes (breaking)

Removed from public contract:

- `UniversalEvent`
- `UniversalItem`
- custom `permission.reply` and `question.reply` REST endpoints
- v1 `sessions/*` REST resources

Added:

- raw ACP JSON-RPC envelopes over HTTP
- explicit connection identity (`X-ACP-Connection-Id`)

## 8) Test contract for v1

Consolidated must-have suites (duplicates collapsed):

- ACP protocol conformance (JSON-RPC + ACP schema/semantics)
- Transport contract (`/v1/rpc` POST/SSE routing, ordering, replay, errors)
- End-to-end agent process matrix (includes core turn flow, cancel, HITL, streaming)
- Installer suite (explicit + lazy install, registry/fallback provenance)
- Security/auth isolation
- TypeScript SDK end-to-end (embedded + server mode, embedding `@agentclientprotocol/sdk`)
- v1 removal contract suite (`/v1/*` => HTTP 410 + stable error payload)
- Inspector ACP suite executed with `agent-browser` (ACP session flow + streaming render correctness)
- OpenCode <-> ACP bridge suite (dedicated later phase)

No synthetic protocol fixtures. Use real agent processes in integration tests.

Minimum required `agent-browser` inspector coverage:

1. Open `/ui/`, spawn an agent/session, send one message, and verify a response is rendered.

Current automation entrypoint:

- `frontend/packages/inspector/tests/agent-browser.e2e.sh`
- `server/packages/sandbox-agent/tests/v1_agent_process_matrix.rs` (deterministic agent process matrix smoke + JSON-RPC conformance checks)

## 9) Open questions to resolve before implementation lock

- Amp agent process availability and support level for v1 launch.
- Whether additional non-binary filesystem endpoints remain HTTP or migrate to ACP extensions after initial cut.

## 10) Deferred Dedicated Step: OpenCode <-> ACP

- During ACP core implementation, `/opencode/*` is commented out/disabled.
- After ACP core is stable, complete the dedicated OpenCode <-> ACP bridge step and re-enable `/opencode/*`.
- Mark the step complete only after dedicated integration tests pass.

## 11) Companion Docs

- `research/acp/v1-schema-to-acp-mapping.md` (normative 1:1 endpoint/event mapping)
- `research/acp/migration-steps.md` (execution order and rollout steps)
- `research/acp/todo.md` (phase checklist and validation tracker)
- `research/acp/acp-over-http-findings.md` (community transport findings and decision context)
- `research/acp/friction.md` (ongoing issue/decision log)
- `docs/quickstart.mdx`, `docs/cli.mdx`, `docs/sdks/typescript.mdx` (external migration and rollout guidance)

## 12) Documentation Updates (mandatory)

When implementing this spec, update docs in the same change set:

- API reference/openapi docs for v1 and `/v1/*` removal semantics
- `docs/cli.mdx` for v1 ACP and removed v1 commands
- `docs/inspector.mdx` for ACP-based inspector behavior
- SDK docs (`docs/sdks/typescript.mdx`) for ACP-over-HTTP transport usage
- Any OpenCode compatibility docs that reference `/opencode/*`
