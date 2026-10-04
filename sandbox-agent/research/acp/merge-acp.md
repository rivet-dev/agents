# Proposal: Move Static v1 HTTP Endpoints into ACP Extensions

## Goal

Keep `GET /v1/health` as the only static control endpoint, except for dedicated binary filesystem transfer endpoints.

Move all other current static v1 HTTP routes to ACP JSON-RPC methods (Sandbox Agent extensions under `_sandboxagent/...`) on `/v1/rpc`.

Retain these HTTP endpoints intentionally:

- `GET /v1/fs/file`
- `PUT /v1/fs/file`
- `POST /v1/fs/upload-batch`

No implementation in this proposal. This is a migration plan.

## Current State (from `server/packages/sandbox-agent/src/router.rs`)

Static v1 endpoints today:

- `GET /v1/agents`
- `POST /v1/agents/:agent/install`
- legacy session list endpoint
- legacy session detail endpoint
- `GET /v1/fs/entries`
- `GET /v1/fs/file`
- `PUT /v1/fs/file`
- `DELETE /v1/fs/entry`
- `POST /v1/fs/mkdir`
- `POST /v1/fs/move`
- `GET /v1/fs/stat`
- `POST /v1/fs/upload-batch`

Non-static ACP transport endpoints (remain):

- `POST /v1/rpc`
- `GET /v1/rpc` (SSE)
- `DELETE /v1/rpc`

Health endpoint (remain):

- `GET /v1/health`

## Proposed Target Surface

Keep:

- `GET /v1/health`
- `POST/GET/DELETE /v1/rpc`
- `GET /v1/fs/file`
- `PUT /v1/fs/file`
- `POST /v1/fs/upload-batch`

Remove all other static v1 control/file routes after migration.

Add ACP extension methods:

- `_sandboxagent/agent/list`
- `_sandboxagent/agent/install`
- `_sandboxagent/session/list`
- `_sandboxagent/session/get`
- `_sandboxagent/fs/list_entries`
- `_sandboxagent/fs/read_file` (parallel with HTTP)
- `_sandboxagent/fs/write_file` (parallel with HTTP)
- `_sandboxagent/fs/delete_entry`
- `_sandboxagent/fs/mkdir`
- `_sandboxagent/fs/move`
- `_sandboxagent/fs/stat`
- `_sandboxagent/fs/upload_batch` (parallel with HTTP)

Interpretation for clients: all agent/session operations and non-binary filesystem operations move to ACP extension calls over `/v1/rpc`. Binary file transfer has a dual surface: ACP equivalents exist in parallel, but HTTP remains the primary transport for large/streaming payloads.

## Endpoint-to-Method Mapping

| Existing HTTP | New ACP method | Notes |
| --- | --- | --- |
| `GET /v1/agents` | `_sandboxagent/agent/list` | Response keeps current `AgentListResponse` shape for low migration risk. |
| `POST /v1/agents/:agent/install` | `_sandboxagent/agent/install` | Params include `agent`, `reinstall`, `agentVersion`, `agentProcessVersion`. |
| legacy session list endpoint | `_sandboxagent/session/list` | Return current `SessionListResponse` shape (not ACP unstable list shape). |
| legacy session detail endpoint | `_sandboxagent/session/get` | Return current `SessionInfo` shape; error on missing session. |
| `GET /v1/fs/entries` | `_sandboxagent/fs/list_entries` | Preserve path + optional `sessionId` resolution semantics. |
| `GET /v1/fs/file` | keep HTTP + `_sandboxagent/fs/read_file` | HTTP is primary because responses may require large streaming reads; ACP variant exists for compatibility/smaller payloads. |
| `PUT /v1/fs/file` | keep HTTP + `_sandboxagent/fs/write_file` | HTTP is primary for large binary writes; ACP variant exists for compatibility/smaller payloads. |
| `DELETE /v1/fs/entry` | `_sandboxagent/fs/delete_entry` | Preserve recursive directory delete behavior. |
| `POST /v1/fs/mkdir` | `_sandboxagent/fs/mkdir` | Preserve create-dir behavior. |
| `POST /v1/fs/move` | `_sandboxagent/fs/move` | Preserve `overwrite` behavior. |
| `GET /v1/fs/stat` | `_sandboxagent/fs/stat` | Preserve `FsStat` shape. |
| `POST /v1/fs/upload-batch` | keep HTTP + `_sandboxagent/fs/upload_batch` | HTTP is primary for large tar uploads; ACP variant exists for compatibility/smaller payloads. |

## ACP Contract Details

### Capability Advertisement

Extend initialize metadata (`_meta[sandboxagent.dev].extensions`) in `acp_runtime/ext_meta.rs` with booleans + method names for all new methods above, same pattern as existing:

- `sessionDetach`, `sessionTerminate`, `sessionListModels`, `sessionSetMetadata`, etc.

Add keys for new extensions (`agentList`, `agentInstall`, `fsListEntries`, `fsStat`, ...).

### Filesystem Exception (Intentional)

`GET/PUT /v1/fs/file` and `POST /v1/fs/upload-batch` stay as first-class Sandbox Agent HTTP APIs.

Reason:

- These operations are host/runtime capabilities implemented by Sandbox Agent, not agent-process behavior.
- Keeping them server-owned gives consistent behavior across agents.
- ACP envelopes are JSON-RPC payloads and are not suitable for streaming very large binary files efficiently.
- `GET /v1/fs/file` specifically needs efficient streamed responses for large reads.

ACP parity note:

- Maintain ACP extension equivalents in parallel (`_sandboxagent/fs/read_file`, `_sandboxagent/fs/write_file`, `_sandboxagent/fs/upload_batch`) for compatibility.
- ACP and HTTP variants should call the same underlying filesystem service code path to keep behavior consistent.
- ACP variants are not intended for very large file transfer workloads.

### Error Mapping

Keep existing `SandboxError -> ProblemDetails` semantics over HTTP transport. For extension methods, surface structured JSON-RPC error payloads that map to existing invalid request / not found behavior.

## TypeScript Client Impact Assessment

Current behavior in `sdks/typescript/src/client.ts`:

- `listAgents` and `installAgent` call static HTTP endpoints.
- `listSessions` and `getSession` call static HTTP endpoints.
- FS helpers (`listFsEntries`, `readFsFile`, `writeFsFile`, `deleteFsEntry`, `mkdirFs`, `moveFs`, `statFs`, `uploadFsBatch`) call static HTTP endpoints.
- ACP/session methods already use ACP (`newSession`, `loadSession`, `prompt`, etc).

Required change for ACP-only behavior:

- Reimplement non-binary helpers above as ACP extension wrappers via `acp.extMethod(...)`.
- Keep method names stable in `SandboxAgentClient` to minimize user breakage.
- Make ACP-backed helpers connection-scoped (same as ACP methods): they must throw `NotConnectedError` when disconnected.
- Keep direct HTTP helper calls only for:
  - `getHealth()`
  - `readFsFile()` (`GET /v1/fs/file`)
  - `writeFsFile()` (`PUT /v1/fs/file`)
  - `uploadFsBatch()` (`POST /v1/fs/upload-batch`)
- Keep ACP variants available through low-level `extMethod(...)` for advanced/smaller-payload use cases, but do not make them the SDK default path.

Package boundary after migration:

- `acp-http-client` remains protocol-pure ACP transport and generic `extMethod`/`extNotification`.
- `sandbox-agent` remains the typed wrapper that maps convenience methods to `_sandboxagent/...` extension methods.
- No direct legacy agents/session REST fetches or non-binary `/v1/fs/*` fetches in SDK runtime code.
- Binary file transfer keeps direct HTTP fetches on the three endpoints listed above.
- SDK policy: prefer HTTP for `readFsFile`/`writeFsFile`/`uploadFsBatch` even if ACP extension variants exist.

Type changes expected in `sdks/typescript/src/types.ts`:

- Add typed request/response interfaces for new ACP extension methods.
- Keep compatibility aliases where needed (`bytes_written` and `bytesWritten`, etc.) for one migration window.

Integration test impact (`sdks/typescript/tests/integration.test.ts`):

- Replace assumptions that agent/session/fs helpers are usable without ACP connection.
- Add coverage that helpers work after `connect()` and use ACP extension paths end-to-end.
- Keep real-server runtime tests (no fetch mocks for server behavior).

## Bootstrap Model (Important)

Today, first call to a new ACP server id should be `initialize`, and requires `params._meta["sandboxagent.dev"].agent`.

Implication after migration:

- Agent and ACP-backed filesystem control methods must run on an ACP connection.
- Bootstrap flow should use `initialize` with `_meta["sandboxagent.dev"].agent = "mock"` for control-plane-only clients before calling extension methods.

Alternative (optional): introduce a runtime-only control connection mode that does not require backend agent init. This is a larger behavior change and can be deferred.

## Phased Migration Plan

### Phase 1: Add ACP Extension Equivalents

- Add methods to runtime extension handlers (`acp_runtime/ext_methods.rs`).
- Reuse existing router/support mapping logic where possible to keep response parity.
- Keep binary file-transfer ACP methods in parallel with HTTP (`_sandboxagent/fs/read_file`, `_sandboxagent/fs/write_file`, `_sandboxagent/fs/upload_batch`) and route both surfaces through shared implementation code.
- Advertise new capabilities in `acp_runtime/ext_meta.rs`.
- Add ACP extension tests for each new method in `server/packages/sandbox-agent/tests/v1_api/acp_extensions.rs`.

### Phase 2: Migrate Clients (No HTTP Route Removal Yet)

- TypeScript SDK (`sdks/typescript/src/client.ts`):
  - Repoint `listAgents`, `installAgent`, `listSessions`, `getSession`, `listFsEntries`, `deleteFsEntry`, `mkdirFs`, `moveFs`, and `statFs` to ACP extension calls.
  - Keep `readFsFile`, `writeFsFile`, and `uploadFsBatch` on HTTP endpoints.
  - Remove direct runtime fetch usage for legacy agents/session REST endpoints and non-binary `/v1/fs/*`.
  - Keep method names stable for callers.
  - Move these methods to connected-only semantics (`NotConnectedError` when disconnected).
- CLI (`server/packages/sandbox-agent/src/cli.rs`):
  - Make `api agents list/install` call ACP extension methods (via ACP post flow), not direct legacy agent HTTP calls.
- Inspector flow/docs:
  - Stop depending on `GET /v1/agents` in startup path; use ACP extension instead.

### Phase 3: Remove Static Endpoints (Except Health + Binary FS Transfer)

- Remove route registrations for legacy agent/session REST endpoints and `/v1/fs/entries`, `/v1/fs/entry`, `/v1/fs/mkdir`, `/v1/fs/move`, `/v1/fs/stat` from `router.rs`.
- Keep `/v1/health`, `/v1/rpc`, `GET /v1/fs/file`, `PUT /v1/fs/file`, and `POST /v1/fs/upload-batch`.
- Optional short deprecation period: convert removed routes to `410 Gone` with explicit extension method in `detail`.

### Phase 4: Docs/OpenAPI/Test Cleanup

- Regenerate `docs/openapi.json` (should now primarily describe `/v1/health`, `/v1/rpc`, and retained binary fs transfer endpoints).
- Update:
  - `docs/cli.mdx`
  - `docs/inspector.mdx`
  - `docs/sdks/typescript.mdx`
- Replace current `control_plane.rs` HTTP-route assertions with ACP-extension assertions.

## Validation Plan

Server:

- ACP extension integration tests for all new methods.
- Auth parity checks (token required behavior unchanged).
- Existing ACP transport tests unchanged and green.

SDK:

- Real-server integration tests verify moved helpers now use ACP extensions.
- No fetch transport mocks for server behavior.

CLI:

- `api agents list/install` e2e tests validate ACP-backed behavior.

Inspector:

- Browser e2e (`agent-browser`) still passes with ACP-only startup path.

## Rollout Strategy

1. Ship Phase 1 + 2 behind no route removals.
2. Verify SDK/CLI/Inspector consume ACP extensions in CI.
3. Remove static endpoints in one cut (Phase 3).
4. Land docs/openapi updates immediately with removal.

## Open Decisions

1. Should removed legacy agent/session REST endpoints and non-binary `/v1/fs/*` return `410` for one release or be dropped immediately?
2. Do we keep a strict response-shape parity layer for session/file methods, or normalize to ACP-native shapes?
3. Should `/` service-root remain as informational HTTP, or be treated as out-of-scope for this “only health static + binary fs transfer” policy?
