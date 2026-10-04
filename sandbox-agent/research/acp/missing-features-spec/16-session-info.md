# Feature 16: Session Info

**Implementation approach:** New session-info HTTP endpoints

## Summary

v1 `SessionInfo` tracked `event_count`, `created_at`, `updated_at`, and full `mcp` config. v1 has session data in the ACP runtime's `MetaSession` struct but no HTTP endpoints to query it. Add HTTP endpoints for session listing and detail.

## Current v1 State

### Internal Session Tracking

From `acp_runtime/mod.rs:130-138`:

```rust
struct MetaSession {
    session_id: String,
    agent: AgentId,
    cwd: String,
    title: Option<String>,
    updated_at: Option<String>,
    sandbox_meta: Map<String, Value>,
}
```

### ACP `session/list` Response

The ACP `session/list` already returns session data (lines 956-967):

```json
{
  "sessionId": "...",
  "cwd": "...",
  "title": "...",
  "updatedAt": "...",
  "_meta": { "sandboxagent.dev": { "agent": "claude" } }
}
```

But this requires an active ACP connection.

## v1 Types (exact, from `router.rs`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub agent: String,
    pub agent_mode: String,
    pub permission_mode: String,
    pub model: Option<String>,
    pub native_session_id: Option<String>,
    pub ended: bool,
    pub event_count: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub directory: Option<String>,
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<BTreeMap<String, McpServerConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<SkillsConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
pub struct SessionListResponse {
    pub sessions: Vec<SessionInfo>,
}
```

## v1 Handler and Builder (exact)

```rust
async fn list_sessions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SessionListResponse>, ApiError> {
    let sessions = state.session_manager.list_sessions().await;
    Ok(Json(SessionListResponse { sessions }))
}

// SessionManager methods:
pub(crate) async fn list_sessions(&self) -> Vec<SessionInfo> {
    let sessions = self.sessions.lock().await;
    sessions.iter().rev()
        .map(|state| Self::build_session_info(state))
        .collect()
}

pub(crate) async fn get_session_info(&self, session_id: &str) -> Option<SessionInfo> {
    let sessions = self.sessions.lock().await;
    Self::session_ref(&sessions, session_id).map(Self::build_session_info)
}

fn build_session_info(state: &SessionState) -> SessionInfo {
    SessionInfo {
        session_id: state.session_id.clone(),
        agent: state.agent.as_str().to_string(),
        agent_mode: state.agent_mode.clone(),
        permission_mode: state.permission_mode.clone(),
        model: state.model.clone(),
        native_session_id: state.native_session_id.clone(),
        ended: state.ended,
        event_count: state.events.len() as u64,
        created_at: state.created_at,
        updated_at: state.updated_at,
        directory: state.directory.clone(),
        title: state.title.clone(),
        mcp: state.mcp.clone(),
        skills: state.skills.clone(),
    }
}
```

## Implementation Plan

### New HTTP Endpoints

```
session list endpoint         -> SessionListResponse
session detail endpoint       -> SessionInfo
```

These are control-plane HTTP endpoints (not ACP), providing session visibility without requiring an active ACP connection.

### Response Types

The v1 `SessionInfo` should be a superset of v1 fields, adapted for ACP:

```rust
#[derive(Debug, Serialize, JsonSchema, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub agent: String,
    pub cwd: String,
    pub title: Option<String>,
    pub ended: bool,
    pub created_at: Option<String>,   // ISO 8601 (v1 used i64 timestamp)
    pub updated_at: Option<String>,   // ISO 8601
    pub model: Option<String>,
    pub metadata: Value,              // full sandbox_meta
}
```

### Data Source

The `AcpRuntime` maintains a `sessions: RwLock<HashMap<String, MetaSession>>` registry. The new HTTP endpoints query this registry.

Need to add:
- `created_at` field to `MetaSession`
- `ended` status tracking
- Public methods on `AcpRuntime` to expose session list/detail for HTTP handlers

### Files to Modify

| File | Change |
|------|--------|
| `server/packages/sandbox-agent/src/router.rs` | Add session list and session detail handlers; add response types |
| `server/packages/sandbox-agent/src/acp_runtime/mod.rs` | Add `created_at` to `MetaSession`; add `ended` tracking; expose `list_sessions()` and `get_session()` public methods |
| `sdks/typescript/src/client.ts` | Add `listSessions()` and `getSession(id)` methods |
| `server/packages/sandbox-agent/tests/v1_api.rs` | Add session listing and detail tests |

### Docs to Update

| Doc | Change |
|-----|--------|
| `docs/openapi.json` | Add session list and session detail endpoint specs |
| `docs/cli.mdx` | Add CLI `sessions list` and `sessions info` commands |
| `docs/sdks/typescript.mdx` | Document session listing SDK methods |
