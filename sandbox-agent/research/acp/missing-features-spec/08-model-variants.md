# Feature 8: Model Variants

> **Status:** Deferred / out of scope for the current implementation pass.

**Implementation approach:** Enhance existing `_sandboxagent/session/list_models` extension

## Summary

v1 had `AgentModelInfo.variants`, `AgentModelInfo.defaultVariant`, and `CreateSessionRequest.variant`. v1 already has `_sandboxagent/session/list_models` but the variant fields need to be verified and the session-creation variant selection needs to work end-to-end.

## Current v1 State

From `acp_runtime/mod.rs`, `_sandboxagent/session/list_models` is implemented and returns:
- `availableModels[]` with `modelId`, `name`, `description`
- `currentModelId`
- Fields for `defaultVariant`, `variants[]` are documented in `rfds-vs-extensions.md`

From v1 `router.rs`, model/variant types existed:

```rust
pub struct AgentModelsResponse {
    pub models: Vec<AgentModelInfo>,
    pub default_model: Option<String>,
}

pub struct AgentModelInfo {
    pub id: String,
    pub name: Option<String>,
    pub variants: Option<Vec<AgentModelVariant>>,
    pub default_variant: Option<String>,
}

pub struct AgentModelVariant {
    pub id: String,
    pub name: Option<String>,
}
```

## v1 Usage

### Pre-session Model Discovery

```
GET /v1/agents/{agent}/models
```

Returned `AgentModelsResponse` with full model list including variants.

### Session Creation with Variant

```
legacy session create endpoint
```

Body included `variant: Option<String>` to select a specific model variant at session creation time.

### Per-Agent Model Logic (from `router.rs`)

```rust
fn amp_models_response() -> AgentModelsResponse {
    AgentModelsResponse {
        models: vec![AgentModelInfo {
            id: "amp-default".to_string(),
            name: Some("Amp Default".to_string()),
            variants: None,
            default_variant: None,
        }],
        default_model: Some("amp-default".to_string()),
    }
}

fn mock_models_response() -> AgentModelsResponse {
    AgentModelsResponse {
        models: vec![AgentModelInfo {
            id: "mock".to_string(),
            name: Some("Mock".to_string()),
            variants: None,
            default_variant: None,
        }],
        default_model: Some("mock".to_string()),
    }
}
```

Claude and Codex models were fetched dynamically from the agent process.

## Implementation Plan

### Verify/Enrich `_sandboxagent/session/list_models`

The existing extension method already returns model data. Verify that:

1. `variants` array is included in each model entry when available
2. `defaultVariant` is included when available
3. The response shape matches the documented RFD shape

### Add Variant to Session Creation

Session creation via `session/new` should accept a variant hint in `_meta`:

```json
{
  "method": "session/new",
  "params": {
    "_meta": {
      "sandboxagent.dev": {
        "variant": "opus"
      }
    }
  }
}
```

The runtime should forward this variant to the agent process (e.g., as a model parameter in the spawn command or via `session/set_model`).

### Files to Modify

| File | Change |
|------|--------|
| `server/packages/sandbox-agent/src/acp_runtime/mod.rs` | Verify `list_models` response includes `variants`/`defaultVariant`; extract and forward `variant` from `session/new` `_meta` |
| `server/packages/sandbox-agent/src/acp_runtime/mock.rs` | Add variant support to mock model listing |
| `sdks/typescript/src/client.ts` | Update `listModels` return type to include variants |
| `server/packages/sandbox-agent/tests/v1_api.rs` | Add model variants test |

### Docs to Update

| Doc | Change |
|-----|--------|
| `docs/sdks/typescript.mdx` | Document variant support in model listing and session creation |
| `research/acp/spec.md` | Update `_sandboxagent/session/list_models` payload shape |
