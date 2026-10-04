# Feature 10: `include_raw`

> **Status:** Deferred / out of scope for the current implementation pass.

**Implementation approach:** ACP extension

## Summary

v1 had an `include_raw` option that preserved the original agent JSON alongside normalized events. The `UniversalEvent.raw` field held the verbatim agent output. v1 has `_sandboxagent/agent/unparsed` for parse errors but no mechanism for clients to request raw agent payloads alongside normalized ACP events.

## Current v1 State

- `_sandboxagent/agent/unparsed` — sends notifications when the runtime fails to parse agent output (error recovery only)
- No option for clients to request raw agent JSON alongside normal ACP events
- ACP events are already the agent's native JSON-RPC output (for agents that speak ACP natively); the "raw" concept is less meaningful when the agent already speaks ACP

## v1 Types

```rust
pub struct UniversalEvent {
    pub event_id: String,
    pub sequence: u64,
    pub time: String,
    pub session_id: String,
    pub native_session_id: Option<String>,
    pub synthetic: bool,
    pub source: EventSource,
    pub event_type: UniversalEventType,
    pub data: UniversalEventData,
    pub raw: Option<Value>,  // <-- Raw agent output when include_raw=true
}
```

### v1 Usage

```
legacy event polling endpoint with `include_raw=true`
```

When `include_raw=true`, each `UniversalEvent` included the verbatim JSON the agent process emitted before normalization into the universal schema.

## Implementation Plan

### Extension Design

Since v1 agents speak ACP natively (JSON-RPC), the "raw" concept changes:
- For ACP-native agents: raw = the ACP JSON-RPC envelope itself (which clients already see)
- For non-native agents or runtime-synthesized events: raw = the original agent output before transformation

The extension provides a way for clients to opt into receiving the pre-transformation payload.

### Opt-in via `_meta`

Client requests raw mode at connection initialization:

```json
{
  "method": "initialize",
  "params": {
    "_meta": {
      "sandboxagent.dev": {
        "includeRaw": true
      }
    }
  }
}
```

When enabled, notifications forwarded from the agent process include an additional `_meta.sandboxagent.dev.raw` field containing the original payload:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    // ... normalized ACP event ...
    "_meta": {
      "sandboxagent.dev": {
        "raw": { /* original agent JSON */ }
      }
    }
  }
}
```

### Files to Modify

| File | Change |
|------|--------|
| `server/packages/sandbox-agent/src/acp_runtime/mod.rs` | Track per-client `includeRaw` preference; attach raw payload to forwarded notifications when enabled |
| `sdks/typescript/src/client.ts` | Add `includeRaw` option to connection config; expose raw data on event objects |

### Docs to Update

| Doc | Change |
|-----|--------|
| `docs/sdks/typescript.mdx` | Document `includeRaw` option |
| `research/acp/spec.md` | Document raw extension behavior |
