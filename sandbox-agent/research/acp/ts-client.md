# TypeScript Client Rewrite Spec (ACP HTTP Client + Sandbox Agent SDK)

## Status
- Draft.
- Captures confirmed decisions and server-verified contracts before implementation.

## Goals
- Split TypeScript clients into:
1. `acp-http-client`: protocol-pure ACP-over-HTTP transport/client.
2. `sandbox-agent` SDK: Sandbox Agent wrapper that hides ACP terminology and applies Sandbox-specific metadata/extensions.
- Make the Sandbox Agent SDK API as simple as creating a client and connecting once.
- Remove ACP-facing API from `sandbox-agent` public surface.

## Confirmed Product Decisions
- Dedicated protocol package name: `acp-http-client`.
- `acp-http-client` must implement ACP HTTP protocol "to the T" and include no Sandbox-specific metadata/extensions.
- Sandbox SDK public constructor pattern: `new SandboxAgentClient(...)`.
- Sandbox SDK auto-connects by default, but supports disabling auto-connect.
- ACP-related SDK calls must fail if `.connect()` has not been called.
- After `.disconnect()`, ACP-related SDK calls must fail until reconnected.
- A `SandboxAgentClient` instance can hold at most one active ACP connection.
- No API for creating multiple ACP clients per wrapper instance.
- ACP terminology should not appear in Sandbox SDK public API/docs.
- Sandbox SDK should be a thin conversion layer on top of ACP protocol, mainly for metadata/event conversion.
- Existing ACP-facing methods in `sandbox-agent` are removed (full rewrite).
- Non-ACP HTTP helpers remain in `sandbox-agent` (health/agents/install/fs/etc).

## Server-Verified v1 ACP Contract

### HTTP endpoints and headers
- Endpoints:
1. `POST /v1/rpc`
2. `GET /v1/rpc` (SSE)
3. `DELETE /v1/rpc`
- Headers:
1. No connection-id header.
2. `Last-Event-ID` for SSE replay.
3. Agent selection is in payload metadata: `params._meta["sandboxagent.dev"].agent`.
- Sources:
1. `server/packages/sandbox-agent/src/router.rs:862`
2. `server/packages/sandbox-agent/src/router.rs:913`
3. `server/packages/sandbox-agent/src/router.rs:948`
4. `server/packages/sandbox-agent/src/acp_runtime/mod.rs:26`
5. `server/packages/sandbox-agent/src/acp_runtime/mod.rs:27`

### Custom `_sandboxagent/*` methods/events currently implemented
- Request methods handled in runtime:
1. `_sandboxagent/session/detach`
2. `_sandboxagent/session/terminate`
3. `_sandboxagent/session/list_models`
4. `_sandboxagent/session/set_metadata`
- Notification methods handled in runtime:
1. `_sandboxagent/session/detach`
2. `_sandboxagent/session/terminate`
3. `_sandboxagent/session/set_metadata`
- Runtime notifications:
1. `_sandboxagent/session/ended`
2. `_sandboxagent/agent/unparsed`
- Sources:
1. `server/packages/sandbox-agent/src/acp_runtime/ext_methods.rs:3`
2. `server/packages/sandbox-agent/src/acp_runtime/ext_methods.rs:4`
3. `server/packages/sandbox-agent/src/acp_runtime/ext_methods.rs:5`
4. `server/packages/sandbox-agent/src/acp_runtime/ext_methods.rs:6`
5. `server/packages/sandbox-agent/src/acp_runtime/ext_methods.rs:7`
6. `server/packages/sandbox-agent/src/acp_runtime/ext_methods.rs:8`
7. `server/packages/sandbox-agent/src/acp_runtime/ext_methods.rs:11`
8. `server/packages/sandbox-agent/src/acp_runtime/ext_methods.rs:30`
9. `server/packages/sandbox-agent/src/acp_runtime/mod.rs:1496`
10. `server/packages/sandbox-agent/src/acp_runtime/backend.rs:95`

### Custom extension capability advertisement
- Injected into `initialize` response at:
- `result.agentCapabilities._meta["sandboxagent.dev"].extensions`
- Includes booleans and `methods` array for extension availability.
- Source:
1. `server/packages/sandbox-agent/src/acp_runtime/ext_meta.rs:32`
2. `server/packages/sandbox-agent/src/acp_runtime/ext_meta.rs:55`
3. `server/packages/sandbox-agent/tests/v1_api/acp_extensions.rs:3`

## Server-Verified `_meta["sandboxagent.dev"]` Behavior

### Namespace definition
- Canonical metadata namespace key: `sandboxagent.dev`.
- Source:
1. `server/packages/sandbox-agent/src/acp_runtime/ext_meta.rs:4`

### Inbound metadata ingestion
- `session/new` reads `_meta["sandboxagent.dev"]` as map and stores it.
- Source:
1. `server/packages/sandbox-agent/src/acp_runtime/mod.rs:610`
2. `server/packages/sandbox-agent/src/acp_runtime/ext_meta.rs:21`

### Metadata mutation extension
- `_sandboxagent/session/set_metadata` accepts either:
1. `params.metadata` object, or
2. `params._meta["sandboxagent.dev"]` object.
- Source:
1. `server/packages/sandbox-agent/src/acp_runtime/ext_methods.rs:163`
2. `server/packages/sandbox-agent/src/acp_runtime/ext_methods.rs:182`

### Keys with explicit runtime behavior
- `title`:
1. Updates `session.title` and stored sandbox metadata.
- `model`:
1. Updates model hint and stored sandbox metadata.
- `mode`:
1. Updates mode hint and stored sandbox metadata.
- Source:
1. `server/packages/sandbox-agent/src/acp_runtime/mod.rs:1355`
2. `server/packages/sandbox-agent/src/acp_runtime/mod.rs:1369`
3. `server/packages/sandbox-agent/src/acp_runtime/mod.rs:1374`
4. `server/packages/sandbox-agent/src/acp_runtime/mod.rs:1377`

### Keys injected/derived by runtime in `session/list`
- Runtime always injects these keys under `_meta["sandboxagent.dev"]`:
1. `agent`
2. `createdAt`
3. `updatedAt`
4. `ended`
5. `eventCount`
6. `model` (if model hint exists)
- Source:
1. `server/packages/sandbox-agent/src/acp_runtime/mod.rs:817`

### Known pass-through keys (stored and returned, not strongly typed in runtime)
- Observed in tests/docs as pass-through metadata:
1. `variant`
2. `requestedSessionId`
3. `permissionMode`
4. `skills`
5. `agentVersionRequested`
- Sources:
1. `server/packages/sandbox-agent/tests/v1_api/acp_extensions.rs:145`
2. `research/acp/v1-schema-to-acp-mapping.md:73`
3. `research/acp/v1-schema-to-acp-mapping.md:80`

## Package Split

### Package A: `acp-http-client`
- Scope:
1. ACP JSON-RPC over streamable HTTP only (`/v1/rpc`, headers, SSE replay, close).
2. Generic envelope send/receive and connection lifecycle.
3. No `_sandboxagent/*` helpers.
4. No `_meta["sandboxagent.dev"]` helpers.
5. No Sandbox-specific type aliases.
- API intent:
1. Low-level, minimal, protocol-faithful.
2. Usable by any ACP-compatible server.

### Package B: `sandbox-agent` (`SandboxAgentClient`)
- Scope:
1. Control-plane and host APIs: health, agents, install, filesystem, etc.
2. Single ACP-backed session client lifecycle hidden behind sandbox naming.
3. Metadata conversion in/out of `_meta["sandboxagent.dev"]`.
4. Sandbox extension conversion for `_sandboxagent/*` methods/events.
- Lifecycle rules:
1. Constructor: `new SandboxAgentClient(options)`.
2. Auto-connect by default (configurable opt-out).
3. `.connect(...)` creates/activates one ACP connection.
4. `.connect(...)` throws if already connected.
5. `.disconnect(...)` closes current ACP connection.
6. ACP-related methods throw a not-connected error when disconnected.

## ACP-Shaped vs Sandbox API Names

ACP-shaped names are method names that mirror ACP primitives directly (or current SDK wrappers around them), such as `initialize`, `newSession`, `prompt`, `extMethod`.

Naming rule: for stable ACP methods, Sandbox Agent SDK method names stay ACP-aligned; only extension/unstable helpers may use Sandbox-specific naming.

| ACP-shaped name | ACP protocol message | Sandbox-facing name (candidate) | Notes |
|---|---|---|---|
| `initialize()` | `{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{...}}` | `connect()` | First request must include `params._meta[\"sandboxagent.dev\"].agent` when no connection id exists. |
| `newSession()` | `{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/new\",\"params\":{...}}` | `newSession()` | Stable ACP method name preserved. |
| `loadSession()` | `{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"session/load\",\"params\":{\"sessionId\":\"...\",...}}` | `loadSession()` | Stable ACP method name preserved. |
| `prompt()` | `{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"session/prompt\",\"params\":{...}}` | `prompt()` | Stable ACP method name preserved. |
| `cancel()` / `session/cancel` | `{\"jsonrpc\":\"2.0\",\"method\":\"session/cancel\",\"params\":{\"sessionId\":\"...\"}}` | `cancel()` | Stable ACP method name preserved. |
| `setSessionMode()` | `{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"session/set_mode\",\"params\":{\"sessionId\":\"...\",\"modeId\":\"...\"}}` | `setSessionMode()` | Stable ACP method name preserved. |
| `setSessionConfigOption()` | `{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"session/set_config_option\",\"params\":{...}}` | `setSessionConfigOption()` | Stable ACP method name preserved. |
| `unstableListSessions()` or `session/list` | `{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"session/list\",\"params\":{...}}` | `listSessions()` | Wrapper chooses best server method. |
| `unstableForkSession()` | `{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"session/fork\",\"params\":{...}}` | `forkSession()` | Preserve capability if exposed. |
| `unstableResumeSession()` | `{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"session/resume\",\"params\":{...}}` | `resumeSession()` | Preserve capability if exposed. |
| `unstableSetSessionModel()` / `session/set_model` | `{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"session/set_model\",\"params\":{\"sessionId\":\"...\",\"modelId\":\"...\"}}` | `setSessionModel()` | ACP-aligned naming when exposed. |
| `extMethod(\"_sandboxagent/session/list_models\")` | `{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"_sandboxagent/session/list_models\",\"params\":{...}}` | `listModels()` | Native wrapper method. |
| `extMethod(\"_sandboxagent/session/set_metadata\")` | `{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"_sandboxagent/session/set_metadata\",\"params\":{...}}` | `setMetadata()` | Native wrapper method. |
| `extMethod(\"_sandboxagent/session/detach\")` | `{\"jsonrpc\":\"2.0\",\"id\":13,\"method\":\"_sandboxagent/session/detach\",\"params\":{\"sessionId\":\"...\"}}` | `detachSession()` | Native wrapper method. |
| `extMethod(\"_sandboxagent/session/terminate\")` | `{\"jsonrpc\":\"2.0\",\"id\":14,\"method\":\"_sandboxagent/session/terminate\",\"params\":{\"sessionId\":\"...\"}}` | `terminateSession()` | Native wrapper method. |
| close ACP connection | `DELETE /v1/rpc` | `disconnect()` | Transport-level close, not a JSON-RPC envelope. |

## Conversion Layer Requirements
- Request conversion (sandbox -> ACP):
1. Map sandbox method names to ACP methods.
2. Inject/merge `_meta["sandboxagent.dev"]` where needed.
- Response/event conversion (ACP -> sandbox):
1. Convert `_sandboxagent/session/ended` to sandbox lifecycle event.
2. Convert `_sandboxagent/agent/unparsed` to sandbox parse-error event.
3. Surface metadata fields from `_meta["sandboxagent.dev"]` as first-class sandbox fields where appropriate.

## Error Model
- Shared HTTP error type for non-2xx (`application/problem+json`) remains in sandbox SDK.
- Additional wrapper errors:
1. `NotConnectedError` for ACP-related calls before `.connect()`.
2. `AlreadyConnectedError` when calling `.connect()` while connected.

## Rewrite Impact (expected)
- Remove from `sandbox-agent` public API:
1. `createAcpClient`
2. `postAcpEnvelope`
3. `closeAcpClient`
4. ACP type re-exports from `@agentclientprotocol/sdk`
5. ACP-named classes (`SandboxAgentAcpClient`)
- Replace with sandbox-facing API on `SandboxAgentClient`.

## Testing Requirements
- Continue integration tests against real server/runtime over real `/v1` HTTP APIs.
- Add integration coverage for:
1. Auto-connect on constructor.
2. `autoConnect: false` behavior.
3. Not-connected error gates.
4. Single-connection guard (`connect()` twice).
5. Metadata injection/extraction parity.
6. Extension event conversion parity (`_sandboxagent/session/ended`, `_sandboxagent/agent/unparsed`).
