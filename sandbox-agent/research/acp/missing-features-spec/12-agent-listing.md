# Feature 12: Agent Listing (Typed Response)

**Implementation approach:** Enhance existing `GET /v1/agents`

## Summary

v1 `GET /v1/agents` returned a typed `AgentListResponse` with `installed`, `credentialsAvailable`, `path`, `capabilities`, `serverStatus`. v1 `GET /v1/agents` returns a basic `AgentInfo` with only install state. Needs enrichment.

This feature also carries pre-session models/modes as optional fields when the agent is installed (Feature #13), rather than using separate model/mode endpoints.

## Current v1 State

From `router.rs:265-275`:

```rust
pub struct AgentInfo {
    pub id: String,
    pub native_required: bool,
    pub native_installed: bool,
    pub native_version: Option<String>,
    pub agent_process_installed: bool,
    pub agent_process_source: Option<String>,
    pub agent_process_version: Option<String>,
    pub capabilities: AgentCapabilities,
}

pub struct AgentCapabilities {
    pub unstable_methods: bool,
}
```

## v1 Types (exact, from `router.rs`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub plan_mode: bool,
    pub permissions: bool,
    pub questions: bool,
    pub tool_calls: bool,
    pub tool_results: bool,
    pub text_messages: bool,
    pub images: bool,
    pub file_attachments: bool,
    pub session_lifecycle: bool,
    pub error_events: bool,
    pub reasoning: bool,
    pub status: bool,
    pub command_execution: bool,
    pub file_changes: bool,
    pub mcp_tools: bool,
    pub streaming_deltas: bool,
    pub item_started: bool,
    /// Whether this agent uses a shared long-running server process (vs per-turn subprocess)
    pub shared_process: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub installed: bool,
    /// Whether the agent's required provider credentials are available
    pub credentials_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub capabilities: AgentCapabilities,
    /// Status of the shared server process (only present for agents with shared_process=true)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_status: Option<ServerStatusInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentListResponse {
    pub agents: Vec<AgentInfo>,
}
```

## v1 `list_agents` Handler (exact)

```rust
async fn list_agents(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AgentListResponse>, ApiError> {
    let manager = state.agent_manager.clone();
    let server_statuses = state.session_manager.server_manager.status_snapshot().await;

    let agents = tokio::task::spawn_blocking(move || {
        let credentials = extract_all_credentials(&CredentialExtractionOptions::new());
        let has_anthropic = credentials.anthropic.is_some();
        let has_openai = credentials.openai.is_some();

        all_agents().into_iter().map(|agent_id| {
            let installed = manager.is_installed(agent_id);
            let version = manager.version(agent_id).ok().flatten();
            let path = manager.resolve_binary(agent_id).ok();
            let capabilities = agent_capabilities_for(agent_id);

            let credentials_available = match agent_id {
                AgentId::Claude | AgentId::Amp => has_anthropic,
                AgentId::Codex => has_openai,
                AgentId::Opencode => has_anthropic || has_openai,
                AgentId::Mock => true,
            };

            let server_status = if capabilities.shared_process {
                Some(server_statuses.get(&agent_id).cloned().unwrap_or(
                    ServerStatusInfo {
                        status: ServerStatus::Stopped,
                        base_url: None, uptime_ms: None,
                        restart_count: 0, last_error: None,
                    },
                ))
            } else { None };

            AgentInfo {
                id: agent_id.as_str().to_string(),
                installed, credentials_available, version,
                path: path.map(|p| p.to_string_lossy().to_string()),
                capabilities, server_status,
            }
        }).collect::<Vec<_>>()
    }).await.map_err(|err| SandboxError::StreamError { message: err.to_string() })?;

    Ok(Json(AgentListResponse { agents }))
}
```

## v1 Per-Agent Capability Mapping (exact)

```rust
fn agent_capabilities_for(agent: AgentId) -> AgentCapabilities {
    match agent {
        AgentId::Claude => AgentCapabilities {
            plan_mode: false, permissions: true, questions: true,
            tool_calls: true, tool_results: true, text_messages: true,
            images: false, file_attachments: false, session_lifecycle: false,
            error_events: false, reasoning: false, status: false,
            command_execution: false, file_changes: false, mcp_tools: true,
            streaming_deltas: true, item_started: false, shared_process: false,
        },
        AgentId::Codex => AgentCapabilities {
            plan_mode: true, permissions: true, questions: false,
            tool_calls: true, tool_results: true, text_messages: true,
            images: true, file_attachments: true, session_lifecycle: true,
            error_events: true, reasoning: true, status: true,
            command_execution: true, file_changes: true, mcp_tools: true,
            streaming_deltas: true, item_started: true, shared_process: true,
        },
        AgentId::Opencode => AgentCapabilities {
            plan_mode: false, permissions: false, questions: false,
            tool_calls: true, tool_results: true, text_messages: true,
            images: true, file_attachments: true, session_lifecycle: true,
            error_events: true, reasoning: false, status: false,
            command_execution: false, file_changes: false, mcp_tools: true,
            streaming_deltas: true, item_started: true, shared_process: true,
        },
        AgentId::Amp => AgentCapabilities {
            plan_mode: false, permissions: false, questions: false,
            tool_calls: true, tool_results: true, text_messages: true,
            images: false, file_attachments: false, session_lifecycle: false,
            error_events: true, reasoning: false, status: false,
            command_execution: false, file_changes: false, mcp_tools: true,
            streaming_deltas: false, item_started: false, shared_process: false,
        },
        AgentId::Mock => AgentCapabilities {
            plan_mode: true, permissions: true, questions: true,
            tool_calls: true, tool_results: true, text_messages: true,
            images: true, file_attachments: true, session_lifecycle: true,
            error_events: true, reasoning: true, status: true,
            command_execution: true, file_changes: true, mcp_tools: true,
            streaming_deltas: true, item_started: true, shared_process: false,
        },
    }
}
```

## Implementation Plan

### Enriched AgentInfo

Merge v1 install fields with v1 richness:

```rust
pub struct AgentInfo {
    pub id: String,
    pub installed: bool,                            // convenience: is fully installed
    pub credentials_available: bool,                // from credential extraction
    pub native_required: bool,                      // keep from v1
    pub native_installed: bool,                     // keep from v1
    pub native_version: Option<String>,             // keep from v1
    pub agent_process_installed: bool,              // keep from v1
    pub agent_process_source: Option<String>,       // keep from v1
    pub agent_process_version: Option<String>,      // keep from v1
    pub path: Option<String>,                       // from resolve_binary()
    pub capabilities: AgentCapabilities,            // full v1 capability set
    pub server_status: Option<AgentServerStatus>,   // from Feature #6
    pub models: Option<Vec<AgentModelInfo>>,        // optional, installed agents only
    pub default_model: Option<String>,              // optional, installed agents only
    pub modes: Option<Vec<AgentModeInfo>>,          // optional, installed agents only
}
```

### Files to Modify

| File | Change |
|------|--------|
| `server/packages/sandbox-agent/src/router.rs` | Enrich `AgentInfo` and `AgentCapabilities` structs; add `agent_capabilities_for()` static mapping; add credential check; add convenience `installed` field; add optional `models`/`modes` for installed agents |
| `server/packages/agent-management/src/agents.rs` | Expose credential availability check and `resolve_binary()` if not already present |
| `sdks/typescript/src/client.ts` | Update `AgentInfo` and `AgentCapabilities` types |
| `server/packages/sandbox-agent/tests/v1_api.rs` | Update agent listing test assertions |

### Docs to Update

| Doc | Change |
|-----|--------|
| `docs/openapi.json` | Update `/v1/agents` response schema with full `AgentCapabilities` |
| `docs/sdks/typescript.mdx` | Document enriched agent listing |
