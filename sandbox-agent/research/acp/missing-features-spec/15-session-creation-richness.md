# Feature 15: Session Creation Richness

**Implementation approach:** Check existing extensions — most already implemented

## Summary

v1 `CreateSessionRequest` had `mcp` (full MCP server config with OAuth, env headers, bearer tokens), `skills` (sources with git refs), `agent_version`, `directory`. v1 needs to support these at session creation time.

## Current v1 State — MOSTLY IMPLEMENTED

Investigation shows that **most of these are already supported** via `_meta.sandboxagent.dev` passthrough in `session/new`:

| Field | v1 | v1 Status | v1 Mechanism |
|-------|-----|-----------|-------------|
| `directory` | `CreateSessionRequest.directory` | **Implemented** | `cwd` parameter extracted from payload |
| `agent_version` | `CreateSessionRequest.agent_version` | **Implemented** | `_meta.sandboxagent.dev.agentVersionRequested` (stored, forwarded) |
| `skills` | `CreateSessionRequest.skills` | **Implemented** | `_meta.sandboxagent.dev.skills` (stored, forwarded) |
| `mcp` | `CreateSessionRequest.mcp` | **Stored but not processed** | `_meta.sandboxagent.dev.mcp` passthrough — stored in `sandbox_meta` but no active MCP server config processing |
| `title` | (session metadata) | **Implemented** | `_meta.sandboxagent.dev.title` extracted to `MetaSession.title` |
| `requestedSessionId` | (session alias) | **Implemented** | `_meta.sandboxagent.dev.requestedSessionId` |
| `model` | `CreateSessionRequest.model` | **Implemented** | `_meta.sandboxagent.dev.model` via `session_model_hint()` |
| `variant` | `CreateSessionRequest.variant` | **Deferred** | Out of scope in current implementation pass |

### Confirmation from `rfds-vs-extensions.md`

- Skills: "Already extension via `_meta[\"sandboxagent.dev\"].skills` and optional `_sandboxagent/session/set_metadata`"
- Agent version: "Already extension via `_meta[\"sandboxagent.dev\"].agentVersionRequested`"
- Requested session ID: "Already extension via `_meta[\"sandboxagent.dev\"].requestedSessionId`"

## v1 Types (for reference)

```rust
#[derive(Debug, Deserialize, JsonSchema, ToSchema)]
pub struct CreateSessionRequest {
    pub agent: String,
    pub message: String,
    pub directory: Option<String>,
    pub variant: Option<String>,
    pub agent_version: Option<String>,
    pub mcp: Option<Vec<McpServerConfig>>,
    pub skills: Option<Vec<SkillSource>>,
    pub attachments: Option<Vec<MessageAttachment>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, ToSchema)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub oauth: Option<McpOAuthConfig>,
    pub headers: Option<HashMap<String, String>>,
    pub bearer_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, ToSchema)]
pub struct McpOAuthConfig {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub auth_url: String,
    pub token_url: String,
    pub scopes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, ToSchema)]
pub struct SkillSource {
    pub name: String,
    pub source: SkillSourceType,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SkillSourceType {
    Git { url: String, ref_spec: Option<String> },
    Local { path: String },
}
```

## What Remains

### MCP Server Config Processing

The `mcp` field is stored in `sandbox_meta` but **not actively processed**. To fully support MCP server configuration at session creation:

1. Extract `_meta.sandboxagent.dev.mcp` array from `session/new` params
2. Forward MCP server configs to the agent process (agent-specific: Claude uses `--mcp-config`, Codex/OpenCode have different mechanisms)
3. This is complex and agent-specific — may be deferred

### Recommendation

Since most fields are already implemented via `_meta` passthrough:
- **No new work needed** for `directory`, `agent_version`, `skills`, `title`, `requestedSessionId`, `model`
- **MCP config processing** is the only gap — evaluate whether the agent processes already handle MCP config from `_meta` or if explicit processing is needed
- Mark this feature as **largely complete** with MCP as a follow-up

## Files to Modify (if MCP processing is needed)

| File | Change |
|------|--------|
| `server/packages/sandbox-agent/src/acp_runtime/mod.rs` | Extract and process `mcp` config from `_meta.sandboxagent.dev.mcp` during session creation |
| `server/packages/agent-management/src/agents.rs` | Accept MCP config in agent spawn parameters |

## Docs to Update

| Doc | Change |
|-----|--------|
| `docs/sdks/typescript.mdx` | Document all supported `_meta.sandboxagent.dev` fields for session creation |
