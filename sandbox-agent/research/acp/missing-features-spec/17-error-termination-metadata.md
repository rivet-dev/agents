# Feature 17: Error Termination Metadata

**Implementation approach:** Enrich ACP notifications and session info

## Summary

v1 captured `exit_code`, structured `StderrOutput` (head/tail/truncated) when a session ended due to error. v1 loses this metadata. Need to capture and expose process termination details.

## Current v1 State

- Agent process lifecycle is managed in `acp_runtime/mod.rs`
- Process exit is detected but error metadata (exit code, stderr) is not captured or forwarded
- The `_sandboxagent/agent/unparsed` notification exists for parse errors, but not for process crashes
- No structured error termination data is emitted to clients

## v1 Reference (source commit)

Port behavior and payload shape from commit `8ecd27bc24e62505d7aa4c50cbdd1c9dbb09f836`.

## v1 Types (exact, from `universal-agent-schema/src/lib.rs`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct SessionEndedData {
    pub reason: SessionEndReason,
    pub terminated_by: TerminatedBy,
    /// Error message when reason is Error
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Process exit code when reason is Error
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Agent stderr output when reason is Error
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<StderrOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct StderrOutput {
    /// First N lines of stderr (if truncated) or full stderr (if not truncated)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    /// Last N lines of stderr (only present if truncated)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tail: Option<String>,
    /// Whether the output was truncated
    pub truncated: bool,
    /// Total number of lines in stderr
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_lines: Option<usize>,
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

## v1 Implementation (exact)

### `mark_session_ended` (SessionManager)

```rust
async fn mark_session_ended(
    &self,
    session_id: &str,
    exit_code: Option<i32>,
    message: &str,
    reason: SessionEndReason,
    terminated_by: TerminatedBy,
    stderr: Option<StderrOutput>,
) {
    let mut sessions = self.sessions.lock().await;
    if let Some(session) = Self::session_mut(&mut sessions, session_id) {
        if session.ended { return; }
        session.mark_ended(exit_code, message.to_string(), reason.clone(), terminated_by.clone());
        let (error_message, error_exit_code, error_stderr) =
            if reason == SessionEndReason::Error {
                (Some(message.to_string()), exit_code, stderr)
            } else {
                (None, None, None)
            };
        let ended = EventConversion::new(
            UniversalEventType::SessionEnded,
            UniversalEventData::SessionEnded(SessionEndedData {
                reason, terminated_by,
                message: error_message,
                exit_code: error_exit_code,
                stderr: error_stderr,
            }),
        ).synthetic().with_native_session(session.native_session_id.clone());
        session.record_conversions(vec![ended]);
    }
}
```

### Stderr capture on error exit

```rust
// Called from consume_spawn when agent process exits with error:
Ok(Ok(status)) => {
    let message = format!("agent exited with status {:?}", status);
    if !terminate_early {
        self.record_error(&session_id, message.clone(),
            Some("process_exit".to_string()), None).await;
    }
    let logs = self.read_agent_stderr(agent);
    self.mark_session_ended(
        &session_id, status.code(), &message,
        SessionEndReason::Error, TerminatedBy::Agent, logs,
    ).await;
}
```

### Stderr reading

```rust
fn read_agent_stderr(&self, agent: AgentId) -> Option<StderrOutput> {
    let logs = AgentServerLogs::new(self.server_manager.log_base_dir.clone(), agent.as_str());
    logs.read_stderr()
}
```

## Implementation Plan

### Stderr Capture in ACP Runtime

When an agent process exits (especially abnormally):

1. **Capture stderr**: Buffer the agent process's stderr stream with head/tail logic (~50 lines each)
2. **Capture exit code**: Get the process exit status
3. **Store in session**: Record termination info in the session registry
4. **Emit notification**: Send error notification to all connected clients

### ACP Notification Shape

When an agent process terminates with an error:

```json
{
  "jsonrpc": "2.0",
  "method": "_sandboxagent/session/ended",
  "params": {
    "session_id": "session-uuid",
    "data": {
      "reason": "error",
      "terminated_by": "agent",
      "message": "agent exited with status ExitStatus(unix_wait_status(256))",
      "exit_code": 1,
      "stderr": {
        "head": "Error: module not found\n  at ...",
        "tail": "  at process.exit\nnode exited",
        "truncated": true,
        "total_lines": 250
      }
    }
  }
}
```

### Session Info Integration

Termination metadata should be accessible via:
- the session info endpoint (Feature #16) — include `terminationInfo` in response when session has ended
- `session/list` ACP response — include termination status in session entries

### Files to Modify

| File | Change |
|------|--------|
| `server/packages/sandbox-agent/src/acp_runtime/mod.rs` | Add stderr capture (head/tail buffer) on agent process; capture exit code; emit `_sandboxagent/session/ended`; store v1-shaped termination info in `MetaSession` |
| `server/packages/sandbox-agent/src/acp_runtime/mock.rs` | Add mock error termination scenario (e.g., when prompt contains "crash") |
| `sdks/typescript/src/client.ts` | Add `TerminationInfo` type; expose on session events and session info |
| `server/packages/sandbox-agent/tests/v1_api.rs` | Add error termination metadata test |

### Docs to Update

| Doc | Change |
|-----|--------|
| `docs/sdks/typescript.mdx` | Document `TerminationInfo` type and how to handle error termination |
| `research/acp/spec.md` | Document `_sandboxagent/session/ended` extension and payload |
