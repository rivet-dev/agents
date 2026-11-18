# Feature 6: Server Status

**Implementation approach:** Extension fields on `GET /v1/agents` and `GET /v1/health`

## Summary

v1 had `ServerStatus` (Running/Stopped/Error) and `ServerStatusInfo` (baseUrl, lastError, restartCount, uptimeMs) per agent. v1 has none of this. Add server/agent process status tracking.

## Current v1 State

`GET /v1/agents` returns `AgentInfo` with install state only:

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
```

No runtime status (running/stopped/error), no error tracking, no restart counts.

## v1 Types (exact, from `router.rs`)

```rust
/// Status of a shared server process for an agent
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ServerStatus {
    /// Server is running and accepting requests
    Running,
    /// Server is not currently running
    Stopped,
    /// Server is running but unhealthy
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatusInfo {
    pub status: ServerStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uptime_ms: Option<u64>,
    pub restart_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}
```

## v1 Implementation (exact)

### `ManagedServer::status_info`

```rust
fn status_info(&self) -> ServerStatusInfo {
    let uptime_ms = self.start_time
        .map(|started| started.elapsed().as_millis() as u64);
    ServerStatusInfo {
        status: self.status.clone(),
        base_url: self.base_url(),
        uptime_ms,
        restart_count: self.restart_count,
        last_error: self.last_error.clone(),
    }
}
```

### `AgentServerManager::status_snapshot`

```rust
async fn status_snapshot(&self) -> HashMap<AgentId, ServerStatusInfo> {
    let servers = self.servers.lock().await;
    servers.iter()
        .map(|(agent, server)| (*agent, server.status_info()))
        .collect()
}
```

### `AgentServerManager::update_server_error`

```rust
async fn update_server_error(&self, agent: AgentId, message: String) {
    let mut servers = self.servers.lock().await;
    if let Some(server) = servers.get_mut(&agent) {
        server.status = ServerStatus::Error;
        server.start_time = None;
        server.last_error = Some(message);
    }
}
```

## Implementation Plan

### ACP Runtime Tracking

The `AcpRuntime` needs to track per-agent backend process:

```rust
struct AgentProcessStatus {
    status: String,            // "running" | "stopped" | "error"
    start_time: Option<Instant>,
    restart_count: u64,
    last_error: Option<String>,
}
```

Track:
- Process start → set status to "running", record `start_time`, increment `restart_count`
- Process exit (normal) → set status to "stopped", clear `start_time`
- Process exit (error) → set status to "error", record `last_error`, clear `start_time`

### Add to AgentInfo

```rust
pub struct AgentInfo {
    // ... existing fields ...
    pub server_status: Option<ServerStatusInfo>,
}
```

Only include `server_status` for agents that use shared processes (Codex, OpenCode).

### Files to Modify

| File | Change |
|------|--------|
| `server/packages/sandbox-agent/src/acp_runtime/mod.rs` | Track agent process lifecycle (start/stop/error/restart count) per `AgentId`; expose `status_snapshot()` method |
| `server/packages/sandbox-agent/src/router.rs` | Add `ServerStatus`, `ServerStatusInfo` types; add `server_status` to `AgentInfo`; query runtime for status in `get_v1_agents` |
| `sdks/typescript/src/client.ts` | Update `AgentInfo` type with `serverStatus` |
| `server/packages/sandbox-agent/tests/v1_api.rs` | Test server status in agent listing |

### Docs to Update

| Doc | Change |
|-----|--------|
| `docs/openapi.json` | Update `/v1/agents` response with `server_status` |
| `docs/sdks/typescript.mdx` | Document `serverStatus` field |
