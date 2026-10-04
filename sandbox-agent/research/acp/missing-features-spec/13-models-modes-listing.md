# Feature 13: Models/Modes Listing (Pre-Session)

**Implementation approach:** Enrich agent response payloads (no separate `/models` or `/modes` endpoints)

## Summary

v1 exposed pre-session model/mode discovery via separate endpoints. For v1, models and modes should be optional fields on the agent response payload (only when the agent is installed), with lazy population for dynamic agents.

## Current v1 State

- `_sandboxagent/session/list_models` works but requires an active ACP connection and session
- `GET /v1/agents` does not include pre-session model/mode metadata
- v1 had static per-agent mode definitions (`agent_modes_for()` in `router.rs`)
- v1 had dynamic model fetching (Claude/Codex/OpenCode), plus static model lists for Amp/Mock

## v1 Reference (source commit)

Use commit `8ecd27bc24e62505d7aa4c50cbdd1c9dbb09f836` as the baseline for mode definitions and model-fetching behavior.

## Response Shape (embedded in agent response)

Agent payloads should include optional model/mode fields:

```rust
pub struct AgentInfo {
    // existing fields...
    pub models: Option<Vec<AgentModelInfo>>,   // only present when installed
    pub default_model: Option<String>,         // only present when installed
    pub modes: Option<Vec<AgentModeInfo>>,     // only present when installed
}

pub struct AgentModelInfo {
    pub id: String,
    pub name: Option<String>,
}

pub struct AgentModeInfo {
    pub id: String,
    pub name: String,
    pub description: String,
}
```

Model variants are explicitly out of scope for this implementation pass.

## Population Rules

1. If agent is not installed: omit `models`, `default_model`, and `modes`.
2. If installed and static agent (Amp/Mock): populate immediately from static data.
3. If installed and dynamic agent (Claude/Codex/OpenCode): lazily start/query backing process and populate response.
4. On dynamic-query failure: return the base agent payload and omit model fields, while preserving existing endpoint success semantics.

## Files to Modify

| File | Change |
|------|--------|
| `server/packages/sandbox-agent/src/router.rs` | Enrich agent response type/handlers to optionally include models + modes |
| `server/packages/sandbox-agent/src/acp_runtime/mod.rs` | Expose model query support for control-plane enrichment without requiring an active session |
| `sdks/typescript/src/client.ts` | Extend `AgentInfo` type with optional `models`, `defaultModel`, `modes` |
| `server/packages/sandbox-agent/tests/v1_api.rs` | Add assertions for installed vs non-installed agent response shapes |

## Docs to Update

| Doc | Change |
|-----|--------|
| `docs/openapi.json` | Update `/v1/agents` (and agent detail endpoint if present) schema with optional `models`/`modes` |
| `docs/sdks/typescript.mdx` | Document optional model/mode fields on agent response |
