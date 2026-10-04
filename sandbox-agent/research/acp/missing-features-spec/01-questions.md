# Feature 1: Questions Subsystem

**Implementation approach:** ACP extension (`_sandboxagent/session/request_question`)

## Summary

v1 had a full question subsystem: agent requests a question from the user, client replies with an answer or rejection, and the system tracks question status. v1 has partial stub implementation in mock only.

## Current v1 State

- `_sandboxagent/session/request_question` is declared as a constant in `acp_runtime/mod.rs:33`
- Advertised in capability injection (`extensions.sessionRequestQuestion: true`)
- **Mock agent** (`acp_runtime/mock.rs:174-203`) emits questions when prompt contains "question"
- **No real agent handler** in the runtime for routing question requests/responses between real agent processes and clients
- Mock response handling exists (`mock.rs:377-415`) but the runtime lacks the general forwarding path

## v1 Types (exact, from `universal-agent-schema/src/lib.rs`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct QuestionEventData {
    pub question_id: String,
    pub prompt: String,
    pub options: Vec<String>,
    pub response: Option<String>,
    pub status: QuestionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum QuestionStatus {
    Requested,
    Answered,
    Rejected,
}
```

## v1 HTTP Types (exact, from `router.rs`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionReplyRequest {
    pub answers: Vec<Vec<String>>,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingQuestionInfo {
    pub session_id: String,
    pub question_id: String,
    pub prompt: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone)]
struct PendingQuestion {
    prompt: String,
    options: Vec<String>,
}
```

## Legacy Session REST Endpoints (from `router.rs`)

```
session question reply endpoint   -> 204 No Content
session question reject endpoint  -> 204 No Content
```

### `reply_question` handler

```rust
async fn reply_question(
    State(state): State<Arc<AppState>>,
    Path((session_id, question_id)): Path<(String, String)>,
    Json(request): Json<QuestionReplyRequest>,
) -> Result<StatusCode, ApiError> {
    state.session_manager
        .reply_question(&session_id, &question_id, request.answers)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
```

### `reject_question` handler

```rust
async fn reject_question(
    State(state): State<Arc<AppState>>,
    Path((session_id, question_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    state.session_manager
        .reject_question(&session_id, &question_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
```

## v1 SessionManager Methods (exact)

### `reply_question`

Key flow:
1. Look up session, take pending question by `question_id`
2. Extract first answer: `answers.first().and_then(|inner| inner.first()).cloned()`
3. Per-agent forwarding:
   - **OpenCode**: `opencode_question_reply(&agent_session_id, question_id, answers)`
   - **Claude**: If linked to a permission (AskUserQuestion/ExitPlanMode), send `claude_control_response_line` with `"allow"` and `updatedInput`; otherwise send `claude_tool_result_line`
   - Others: TODO
4. Emit `QuestionResolved` event with `status: Answered`

### `reject_question`

Key flow:
1. Look up session, take pending question
2. Per-agent forwarding:
   - **OpenCode**: `opencode_question_reject(&agent_session_id, question_id)`
   - **Claude**: If linked to permission, send `claude_control_response_line` with `"deny"`; otherwise send `claude_tool_result_line` with `is_error: true`
   - Others: TODO
3. Emit `QuestionResolved` event with `status: Rejected`

## v1 Event Flow

1. Agent emits `question.requested` event with `QuestionEventData { status: Requested, question_id, prompt, options }`
2. Client renders question UI
3. Client calls the legacy session question reply or reject endpoint with `{ answers: [["selected"]] }`
4. System emits `question.resolved` event with `QuestionEventData { status: Answered, response: Some("...") }` or `{ status: Rejected }`

## v1 Agent Capability

```rust
AgentId::Claude => AgentCapabilities { questions: true, ... },
AgentId::Codex => AgentCapabilities { questions: false, ... },
AgentId::Opencode => AgentCapabilities { questions: false, ... },
AgentId::Amp => AgentCapabilities { questions: false, ... },
AgentId::Mock => AgentCapabilities { questions: true, ... },
```

## Implementation Plan

### ACP Extension Design

The question flow maps to ACP's bidirectional request/response:

1. **Agent -> Runtime:** Agent process sends `_sandboxagent/session/request_question` as a JSON-RPC request
2. **Runtime -> Client:** Runtime forwards as a client-directed request in the SSE stream
3. **Client -> Runtime:** Client POSTs a JSON-RPC response (answered/rejected)
4. **Runtime -> Agent:** Runtime forwards the response back to the agent process stdin

### Payload Shape

Agent request:
```json
{
  "jsonrpc": "2.0",
  "id": "q-1",
  "method": "_sandboxagent/session/request_question",
  "params": {
    "sessionId": "...",
    "questionId": "uuid",
    "prompt": "Which option?",
    "options": [["option-a", "Option A"], ["option-b", "Option B"]]
  }
}
```

Client response (answered):
```json
{
  "jsonrpc": "2.0",
  "id": "q-1",
  "result": {
    "status": "answered",
    "answers": [["option-a"]]
  }
}
```

Client response (rejected):
```json
{
  "jsonrpc": "2.0",
  "id": "q-1",
  "result": {
    "status": "rejected"
  }
}
```

### Files to Modify

| File | Change |
|------|--------|
| `server/packages/sandbox-agent/src/acp_runtime/mod.rs` | Add real request/response forwarding for `_sandboxagent/session/request_question` (currently only mock) |
| `server/packages/sandbox-agent/src/acp_runtime/mock.rs` | Already has mock implementation; verify alignment with final payload shape |
| `sdks/typescript/src/client.ts` | Add `onQuestion()` callback and `replyQuestion()` / `rejectQuestion()` methods |
| `frontend/packages/inspector/` | Add question rendering in inspector UI |

### Docs to Update

| Doc | Change |
|-----|--------|
| `docs/openapi.json` | N/A (ACP extension, not HTTP endpoint) |
| `docs/sdks/typescript.mdx` | Document `onQuestion` / `replyQuestion` / `rejectQuestion` SDK methods |
| `docs/inspector.mdx` | Document question rendering in inspector |
| `research/acp/spec.md` | Update extension methods list |
