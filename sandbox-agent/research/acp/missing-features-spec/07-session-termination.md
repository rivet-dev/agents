# Feature 7: Session Termination

**Implementation approach:** ACP extension, referencing existing ACP RFD

## Summary

The legacy session REST API had an explicit terminate endpoint. ACP only has `session/cancel` (turn cancellation, not session kill) and `DELETE /v1/rpc` (connection close, not session termination). Need explicit session destroy/terminate semantics.

## Current v1 State

- `session/cancel` — cancels an in-flight prompt turn only
- `DELETE /v1/rpc` — closes the HTTP connection, does **not** terminate the session
- `_sandboxagent/session/detach` — detaches a session from a connection (multi-client visibility)
- No session termination/deletion exists
- `rfds-vs-extensions.md`: "Session Termination: Not covered by ACP. Only implement if product explicitly requires termination semantics beyond session/cancel"
- `extensibility-status.md`: Documents `_sandboxagent/session/terminate` as proposed but not implemented

## v1 Implementation

### HTTP Endpoint

```
legacy session terminate endpoint
```

### Handler (from `router.rs`)

The terminate handler:
1. Looked up the session by ID
2. Killed the agent subprocess (SIGTERM then SIGKILL after grace period)
3. Emitted a `session.ended` event with `reason: Terminated, terminated_by: Daemon`
4. Cleaned up session state

### v1 Types

```rust
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct SessionEndedData {
    pub reason: SessionEndReason,
    pub terminated_by: TerminatedBy,
    pub message: Option<String>,
    pub exit_code: Option<i32>,
    pub stderr: Option<StderrOutput>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionEndReason {
    Completed,
    Error,
    Terminated,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TerminatedBy {
    Agent,
    Daemon,
}
```

## ACP RFD Reference

Per `~/misc/acp-docs/`, session termination is listed as an RFD topic. The existing ACP spec does not define a `session/terminate` or `session/delete` method.

## Implementation Plan

### ACP Extension Method

```
_sandboxagent/session/terminate
```

Client -> Runtime request:
```json
{
  "jsonrpc": "2.0",
  "id": "t-1",
  "method": "_sandboxagent/session/terminate",
  "params": {
    "sessionId": "session-uuid"
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": "t-1",
  "result": {
    "terminated": true,
    "reason": "terminated",
    "terminatedBy": "daemon"
  }
}
```

### Behavior

1. Client sends `_sandboxagent/session/terminate` request
2. Runtime identifies the session and its owning agent process
3. For shared-process agents (Codex, OpenCode): send a cancel/terminate signal to the agent process for that specific session
4. For per-turn subprocess agents (Claude, Amp): kill the subprocess if running, mark session as terminated
5. Emit `_sandboxagent/session/ended` to all connected clients watching that session
6. Method is idempotent: repeated calls on an already-ended session return success without side effects

### Files to Modify

| File | Change |
|------|--------|
| `server/packages/sandbox-agent/src/acp_runtime/mod.rs` | Add `_sandboxagent/session/terminate` handler; add session removal from registry; add process kill logic |
| `server/packages/sandbox-agent/src/acp_runtime/mock.rs` | Add mock terminate support |
| `sdks/typescript/src/client.ts` | Add `terminateSession(sessionId)` method |
| `server/packages/sandbox-agent/tests/v1_api.rs` | Add session termination test |

### Docs to Update

| Doc | Change |
|-----|--------|
| `docs/sdks/typescript.mdx` | Document `terminateSession` method |
| `research/acp/spec.md` | Add `_sandboxagent/session/terminate` to extension methods list |
| `research/acp/rfds-vs-extensions.md` | Update session termination row |
