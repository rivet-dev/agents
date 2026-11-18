# Feature 5: Health Endpoint

**Implementation approach:** Enhance existing `GET /v1/health`

## Summary

v1 had a typed `HealthResponse` with detailed status. v1 `GET /v1/health` exists but returns only `{ status: "ok", api_version: "v1" }`. Needs enrichment.

## Current v1 State

From `router.rs:332-346`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct HealthResponse {
    pub status: String,
    pub api_version: String,
}

async fn get_v1_health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        api_version: "v1".to_string(),
    })
}
```

## v1 Reference (source commit)

Port behavior from commit `8ecd27bc24e62505d7aa4c50cbdd1c9dbb09f836`.

## v1 Health Response

v1 returned a richer health response:

```rust
#[derive(Debug, Serialize, JsonSchema, ToSchema)]
pub struct HealthResponse {
    pub status: HealthStatus,
    pub version: String,
    pub uptime_ms: u64,
    pub agents: Vec<AgentHealthInfo>,
}

#[derive(Debug, Serialize, JsonSchema, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    Healthy,
    Degraded,
    Unhealthy,
}

#[derive(Debug, Serialize, JsonSchema, ToSchema)]
pub struct AgentHealthInfo {
    pub agent: String,
    pub installed: bool,
    pub running: bool,
}
```

## Implementation Plan

### v1-Parity HealthResponse

```rust
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ToSchema)]
pub struct HealthResponse {
    pub status: HealthStatus,
    pub version: String,
    pub uptime_ms: u64,
    pub agents: Vec<AgentHealthInfo>,
}
```

`GET /v1/health` should mirror v1 semantics and response shape (ported from commit `8ecd27bc24e62505d7aa4c50cbdd1c9dbb09f836`), while keeping the v1 route path.

### Files to Modify

| File | Change |
|------|--------|
| `server/packages/sandbox-agent/src/router.rs` | Port v1 health response types/logic onto `GET /v1/health` |
| `server/packages/sandbox-agent/tests/v1_api.rs` | Update health endpoint test for full v1-parity payload |
| `sdks/typescript/src/client.ts` | Update `HealthResponse` type |

### Docs to Update

| Doc | Change |
|-----|--------|
| `docs/openapi.json` | Update `/v1/health` response schema |
| `docs/sdks/typescript.mdx` | Document enriched health response |
