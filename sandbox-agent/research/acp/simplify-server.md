# ACP Simplified Server Spec

## 1) Scope and Intent

This spec replaces the current ACP runtime model with a simple stdio proxy model:

- Sandbox Agent becomes a **dumb ACP HTTP <-> stdio proxy**.
- ACP transport moves from `/v1/rpc` to `/v1/acp/{server_id}`.
- `server_id` is client-provided and is the only ACP transport identity.
- No server-side ACP extensions and no custom metadata processing.
- Session metadata/state moves to clients.
- Non-ACP functionality is exposed as HTTP endpoints.

Backwards compatibility is explicitly out of scope.

## 2) Hard Breaking Changes

- Remove `/v1/rpc` (`POST`, `GET`, `DELETE`) completely.
- Remove ACP extension support (`_sandboxagent/*`) completely.
- Remove ACP metadata contract (`params._meta["sandboxagent.dev"]`) from runtime behavior.
- Disable OpenCode compatibility completely (`/opencode/*` not mounted).
- Remove server-side session registry semantics tied to ACP transport.

## 3) ACP Transport

### 3.1 Endpoints

For each client-defined `{server_id}`:

- `POST /v1/acp/{server_id}`
- `GET /v1/acp/{server_id}` (SSE)
- `DELETE /v1/acp/{server_id}`

Control-plane ACP transport endpoint:

- `GET /v1/acp` (list active ACP transport instances)

No connection-id header is used.

### 3.2 Bootstrap / Creation

A transport instance is created lazily on first `POST`.

- First `POST` to a new `{server_id}` **must include `agent`** as query parameter:
  - `POST /v1/acp/{server_id}?agent=claude`
- Server behavior on first `POST`:
  1. Validate agent id.
  2. Lazy-install binaries if missing (current install policy retained).
  3. Lazy-start one ACP stdio process for this `{server_id}`.
  4. Forward JSON-RPC payload to that process.

Behavior for existing `{server_id}`:

- `agent` query param is optional.
- If provided and mismatched with existing bound agent, return `409 Conflict`.

If `{server_id}` does not exist and no `agent` is provided, return `400 Bad Request`.

### 3.3 Message Semantics

Sandbox Agent does not inspect ACP method semantics.

- `POST` accepts one JSON-RPC envelope.
- If envelope is request (`method` + `id`): wait for matching stdio response and return `200` + JSON body.
- If envelope is notification or response without `method`: forward and return `202` empty.
- `GET` streams agent->client messages as SSE.
- Replay semantics remain: `Last-Event-ID` supported using in-memory ring buffer per `{server_id}`.
- `DELETE` closes `{server_id}` transport instance and terminates subprocess.

### 3.4 SSE Framing

Same framing as current transport profile:

- `event: message`
- `id: <monotonic sequence per server_id>`
- `data: <single JSON-RPC object>`
- keepalive comment heartbeat every 15s

### 3.5 Process Model

- One ACP process per `{server_id}`.
- Multiple `{server_id}` can target the same agent type.
- Each `{server_id}` has isolated pending requests and replay buffer.

### 3.6 Error Mapping

- Invalid JSON envelope: `400 application/problem+json`
- Missing/invalid content type: `415`
- Unknown agent: `400`
- Unknown `{server_id}` for `GET`/`DELETE`/non-bootstrap `POST`: `404`
- Agent mismatch on existing `{server_id}`: `409`
- Timeout waiting for request response: `504`
- Subprocess spawn/write/read failures: `502`
- Successful `DELETE`: `204` (idempotent)

## 4) ACP Adapter Integration

Sandbox Agent reuses `acp-http-adapter` runtime internals for per-server stdio bridging.

- ACP stdio framing follows ACP docs (UTF-8, newline-delimited JSON-RPC).
- No synthetic `_sandboxagent/*` ACP messages are emitted.
- No transport-level metadata injection or translation.
- Sandbox Agent only performs HTTP routing/lifecycle and subprocess orchestration.

## 5) HTTP Endpoints for Non-ACP Features

These are the proposed HTTP surfaces to review.

### 5.1 Agents

- `GET /v1/agents`
  - List known agents + install/runtime status.
- `POST /v1/agents/{agent}/install`
  - Trigger install/reinstall with existing options.

### 5.2 Filesystem

All filesystem operations are HTTP-only (no ACP extension mirrors):

- `GET /v1/fs/entries`
- `GET /v1/fs/file`
- `PUT /v1/fs/file`
- `DELETE /v1/fs/entry`
- `POST /v1/fs/mkdir`
- `POST /v1/fs/move`
- `GET /v1/fs/stat`
- `POST /v1/fs/upload-batch`

### 5.3 MCP Config (HTTP)

Directory-scoped MCP config endpoints (copy v1 `mcp` config shape, but bind to `directory` instead of session init):

- `GET /v1/config/mcp?directory=<...>&mcpName=<name>`
  - Returns one MCP entry by name.
- `PUT /v1/config/mcp?directory=<...>&mcpName=<name>`
  - Upserts one MCP entry by name.
- `DELETE /v1/config/mcp?directory=<...>&mcpName=<name>`
  - Deletes one MCP entry by name.

Notes:

- Entry payload schema is v1-compatible MCP server config:
  - same as one value from legacy `CreateSessionRequest.mcp[<name>]`.
  - supports both local (stdio) and remote (http/sse) server forms.
- `directory` is required on all MCP config operations.
- `mcpName` is required on all MCP config operations.
- Server stores/retrieves config only and does not inject ACP payload metadata.

### 5.4 Skills Config (HTTP)

Directory-scoped Skills config endpoints (copy v1 skills config shape, but bind to `directory` instead of session init):

- `GET /v1/config/skills?directory=<...>&skillName=<name>`
  - Returns one skill entry by name.
- `PUT /v1/config/skills?directory=<...>&skillName=<name>`
  - Upserts one skill entry by name.
- `DELETE /v1/config/skills?directory=<...>&skillName=<name>`
  - Deletes one skill entry by name.

Notes:

- Entry payload schema is v1-compatible skills config:
  - same source object semantics as legacy `CreateSessionRequest.skills`.
  - includes `sources` behavior and compatible source options.
- `directory` is required on all skill config operations.
- `skillName` is required on all skill config operations.
- No ACP-side mutation/injection by server.

## 6) Session Metadata Ownership

Server no longer owns ACP session metadata.

- No `_sandboxagent/session/set_metadata`.
- No `_sandboxagent/session/list` / `_sandboxagent/session/get`.
- Client owns session indexing, labels, and metadata persistence.

- `GET /v1/acp`
  - Required endpoint.
  - Returns active `{server_id}` instances and process status only.

## 7) Security/Auth

- Existing bearer token auth remains for `/v1/*` when enabled.
- Auth is enforced at HTTP layer only.
- No extra principal scoping inside ACP runtime beyond route auth.

## 8) Testing Requirements

Minimum required coverage:

- ACP proxy e2e for request/response/notification/SSE replay on `/v1/acp/{server_id}`.
- Multi-instance isolation (`server-a`, `server-b`, same agent).
- Lazy install/start on first POST bootstrap.
- Idempotent `DELETE` + cleanup.
- Explicit regression test that `_sandboxagent/*` methods are not handled specially.

## 9) Implementation Checklist

1. Add new router surface `/v1/acp/{server_id}` and remove `/v1/rpc`.
2. Replace current ACP runtime method handling with per-server dumb proxy runtime.
3. Remove extension metadata advertisement/handlers.
4. Remove OpenCode router mount.
5. Keep/add HTTP endpoints listed in section 5.
6. Update OpenAPI/docs to reflect new transport and removed ACP extensions.

## 10) Final HTTP Endpoint Inventory

Expected HTTP endpoints after migration:

- `GET /`
- `GET /v1/health`

- `GET /v1/acp`
- `POST /v1/acp/{server_id}`
- `GET /v1/acp/{server_id}`
- `DELETE /v1/acp/{server_id}`

- `GET /v1/agents`
- `POST /v1/agents/{agent}/install`

- `GET /v1/fs/entries`
- `GET /v1/fs/file`
- `PUT /v1/fs/file`
- `DELETE /v1/fs/entry`
- `POST /v1/fs/mkdir`
- `POST /v1/fs/move`
- `GET /v1/fs/stat`
- `POST /v1/fs/upload-batch`

- `GET /v1/config/mcp?directory=...&mcpName=...`
- `PUT /v1/config/mcp?directory=...&mcpName=...`
- `DELETE /v1/config/mcp?directory=...&mcpName=...`

- `GET /v1/config/skills?directory=...&skillName=...`
- `PUT /v1/config/skills?directory=...&skillName=...`
- `DELETE /v1/config/skills?directory=...&skillName=...`

Removed/disabled surfaces:

- `/v1/rpc` removed.
- `/opencode/*` disabled/unmounted.
- No `_sandboxagent/*` ACP extension behavior.
