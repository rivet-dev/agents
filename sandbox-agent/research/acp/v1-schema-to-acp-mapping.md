# V1 Schema to ACP v1 Mapping (1:1)

## 1) Scope

This document maps every current v1 HTTP endpoint and every universal event type to the v1 surface (ACP JSON-RPC for agent/session traffic, HTTP for control-plane/platform APIs).

Important: this is a conversion reference only. Runtime `/v1/*` endpoints are removed in v1 and return HTTP 410.

Source of truth used:

- Current API: `docs/openapi.json`
- Current event schema: `docs/session-transcript-schema.mdx`
- Event enums/types: `server/packages/universal-agent-schema/src/lib.rs`
- ACP protocol docs: `~/misc/acp-docs/docs/protocol/*.mdx`
- ACP schema/method map: `~/misc/acp-docs/schema/schema.json`, `~/misc/acp-docs/schema/meta.json`
- ACP extensibility rules: `~/misc/acp-docs/docs/protocol/extensibility.mdx`

Transport assumption:

- v1 uses ACP over Streamable HTTP (POST + SSE) as the canonical public transport.
- WebSocket can be added later without changing this mapping.

## 2) Mapping Rules

1. Use ACP standard methods/events first.
2. If ACP stable has no equivalent, use either:
   - ACP extension methods (must start with `_`) for agent/session protocol gaps, or
   - HTTP `/v1/*` control-plane/platform endpoints for non-agent/session APIs.
3. Preserve legacy-only data in `_meta` (namespaced), not as ad-hoc root fields.
4. Use `_meta` for correlation and legacy envelope carry-over.

Extension namespace used in this spec:

- `_sandboxagent/...`

`_meta` namespace used in this spec:

- `_meta["sandboxagent.dev"]`

## 3) Endpoint Mapping (All v1 Endpoints)

| v1 endpoint | v1 mapping | Mapping type | Notes |
|---|---|---|---|
| `GET /v1/health` | `GET /v1/health` | HTTP control-plane | v1-parity payload on v1 route. |
| `GET /v1/agents` | `GET /v1/agents` | HTTP control-plane | Agent inventory, capabilities, server status, and optional models/modes for installed agents. |
| `POST /v1/agents/{agent}/install` | `POST /v1/agents/{agent}/install` | HTTP control-plane | Agent process + native agent install flow. |
| `GET /v1/agents/{agent}/models` | Folded into agent response `models` field (installed agents only) | HTTP control-plane | No standalone `/models` endpoint in v1. |
| `GET /v1/agents/{agent}/modes` | Folded into agent response `modes` field (installed agents only) | HTTP control-plane | No standalone `/modes` endpoint in v1. |
| `GET /v1/fs/entries` | `GET /v1/fs/entries` | HTTP platform API | Port v1 behavior. |
| `DELETE /v1/fs/entry` | `DELETE /v1/fs/entry` | HTTP platform API | Port v1 behavior, including `recursive`. |
| `GET /v1/fs/file` | `GET /v1/fs/file` | HTTP platform API | Raw bytes response (octet-stream), v1 parity. |
| `PUT /v1/fs/file` | `PUT /v1/fs/file` | HTTP platform API | Raw bytes write, v1 parity. |
| `POST /v1/fs/mkdir` | `POST /v1/fs/mkdir` | HTTP platform API | Port v1 behavior. |
| `POST /v1/fs/move` | `POST /v1/fs/move` | HTTP platform API | Port v1 behavior. |
| `GET /v1/fs/stat` | `GET /v1/fs/stat` | HTTP platform API | Port v1 behavior. |
| `POST /v1/fs/upload-batch` | `POST /v1/fs/upload-batch` | HTTP platform API | Tar upload/extract behavior from v1. |
| legacy session list route | session/list | HTTP control-plane | Session inventory without ACP connection requirement. |
| legacy session create route | `session/new` | Standard | Path `session_id` becomes alias in `_meta["sandboxagent.dev"].requestedSessionId`. |
| legacy session prompt route | `session/prompt` | Standard | Asynchronous behavior comes from transport (request + stream). |
| legacy session prompt + stream route | `session/prompt` + consume `session/update` on SSE | Standard | Streaming is transport-level, not a distinct ACP method. |
| legacy session terminate route | `_sandboxagent/session/terminate` | Extension | Idempotent termination semantics distinct from `DELETE /v1/rpc`. |
| legacy event polling route | `_sandboxagent/session/events` (poll view over ACP stream) | Extension | Optional compatibility helper; canonical v1 is stream consumption. |
| legacy event SSE route | `GET /v1/rpc` SSE stream | Standard transport | Filter by sessionId client-side or via connection/session binding. |
| legacy permission reply route | JSON-RPC response to pending `session/request_permission` request id | Standard | Bridge `permission_id` to request `id` in transport state. |
| legacy question reply route | JSON-RPC response to pending `_sandboxagent/session/request_question` | Extension | ACP stable has no generic question/HITL request method. |
| legacy question reject route | JSON-RPC response to pending `_sandboxagent/session/request_question` | Extension | Encode rejection in response outcome. |

### 3.1 `CreateSessionRequest` field mapping

| v1 field | ACP target | Notes |
|---|---|---|
| `agent` | `session/new.params._meta["sandboxagent.dev"].agent` (required) | Agent process selection is explicit session metadata, not an HTTP header. |
| `agentVersion` | `_meta["sandboxagent.dev"].agentVersionRequested` | No ACP standard field. |
| `directory` | `session/new.params.cwd` | Direct mapping. |
| `mcp` | `session/new.params.mcpServers[]` | Convert map format to ACP array format. |
| `agentMode` | `session/set_mode` or `session/set_config_option` | Prefer config option category `mode`; fallback to `_meta` hint. |
| `model` | `session/set_config_option` | Prefer config option category `model`; fallback to `_meta` hint. |
| `variant` | Deferred / out of scope | Do not implement in this pass. |
| `permissionMode` | `session/set_config_option` or `_meta` | No ACP core permission mode field. |
| `skills` | `_meta["sandboxagent.dev"].skills` | Product-specific. |
| `title` | `_meta["sandboxagent.dev"].title` | Product-specific. |
| path `session_id` | `_meta["sandboxagent.dev"].requestedSessionId` | Keep user-facing alias while ACP uses agent-generated `sessionId`. |

### 3.2 `MessageRequest` mapping

| v1 field | ACP target | Notes |
|---|---|---|
| `message` | `session/prompt.params.prompt[]` with `{"type":"text","text":...}` | Direct mapping. |
| `attachments[].path` | `resource_link.uri` or embedded `resource.uri` | Use absolute `file://` URI. |
| `attachments[].mime` | `mimeType` on ACP content block | Direct mapping when available. |
| `attachments[].filename` | `_meta["sandboxagent.dev"].filename` on content block | Not a native ACP field. |

### 3.3 Permission/question reply mapping

| v1 request | ACP target | Notes |
|---|---|---|
| `PermissionReplyRequest.reply=once` | `session/request_permission` response outcome `selected` with option kind `allow_once` | Map by option kind first, then option id. |
| `PermissionReplyRequest.reply=always` | outcome `selected` with option kind `allow_always` | If unavailable, fallback to closest allow option and record in `_meta`. |
| `PermissionReplyRequest.reply=reject` | outcome `selected` with option kind `reject_once` or `reject_always` | Prefer exact semantic match from offered options. |
| `QuestionReplyRequest.answers` | response to `_sandboxagent/session/request_question` | Preserve multi-select shape in `_meta["sandboxagent.dev"].answers`. |
| reject question | response to `_sandboxagent/session/request_question` with `outcome="rejected"` | Extension response schema. |

## 4) Event Mapping (All Universal Event Types)

| Current event type | ACP message/event mapping | Mapping type | `_meta` carry-over |
|---|---|---|---|
| `session.started` | Derived from successful `session/new` (or `session/load`) response; optional notify `_sandboxagent/session/started` | Standard-derived + Extension optional | Carry `event_id`, `sequence`, `source`, `synthetic` in `_meta["sandboxagent.dev"].legacyEvent`. |
| `session.ended` | `_sandboxagent/session/ended` notification | Extension | Include `{reason, terminated_by, message, exit_code}` under extension payload; preserve legacy envelope in `_meta`. |
| `turn.started` | Derived when `session/prompt` request is accepted | Standard-derived | Preserve `turn_id` in `_meta["sandboxagent.dev"].turn`. |
| `turn.ended` | `session/prompt` response (`stopReason`) | Standard | Map stop reason into legacy phase in `_meta`. |
| `item.started` | `session/update` with `tool_call` for tool items; for message/reasoning items, first chunk plus `_meta.phase="started"` | Standard + `_meta` | Include `item_id`, `native_item_id`, `parent_id`, `kind`, `role`. |
| `item.delta` | `session/update` with `agent_message_chunk`, `agent_thought_chunk`, or `tool_call_update.content` | Standard | Include legacy `item_id` in `_meta`. |
| `item.completed` | `session/update` with `tool_call_update.status=completed/failed`; message completion inferred at turn end, optionally emit `_sandboxagent/item/completed` | Standard-derived + Extension optional | Include full finalized item snapshot in `_meta`. |
| `error` | JSON-RPC error response when request-scoped; `_sandboxagent/error` for async/runtime errors | Standard + Extension | Preserve `code` and `details` in `_meta` if converted to JSON-RPC error object. |
| `permission.requested` | `session/request_permission` request from agent | Standard | Store legacy `permission_id` to JSON-RPC request-id mapping in `_meta`. |
| `permission.resolved` | JSON-RPC response to `session/request_permission` | Standard | Include selected option + mapped legacy status in `_meta`. |
| `question.requested` | `_sandboxagent/session/request_question` request from agent | Extension | Keep `{question_id,prompt,options,status}` in params; preserve legacy envelope in `_meta`. |
| `question.resolved` | JSON-RPC response to `_sandboxagent/session/request_question` | Extension | Include `response` and final status mapping in `_meta`. |
| `agent.unparsed` | `_sandboxagent/agent/unparsed` notification | Extension | Carry `{error,location,raw_hash}`; include raw payload hash/correlation in `_meta`. |

## 5) `_meta` Contract for Legacy Parity

ACP extensibility rules require custom data in `_meta`. We reserve:

- Root keys for tracing: `traceparent`, `tracestate`, `baggage` (ACP recommendation)
- Product namespace: `_meta["sandboxagent.dev"]`

Recommended shape:

```json
{
  "_meta": {
    "traceparent": "00-...",
    "sandboxagent.dev": {
      "connectionId": "acp_conn_123",
      "requestedSessionId": "my-session",
      "legacyEvent": {
        "eventId": "evt_123",
        "sequence": 42,
        "source": "agent",
        "synthetic": false,
        "nativeSessionId": "thread_abc"
      }
    }
  }
}
```

## 6) Known Gaps Requiring Extensions

These v1 capabilities are not covered by ACP stable methods and require `_sandboxagent/*` extensions:

- Session termination/history polling (`terminate`, `events` poll view)
- Generic question/HITL request-reply flow
- Session-ended notification payload parity (`_sandboxagent/session/ended`)

Track implementation friction and decisions in `research/acp/friction.md`.
