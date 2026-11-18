# Missing Features Implementation Plan

Features selected from the v1-to-v1 gap analysis, ordered for implementation.

## Confirmed Decisions (Locked)

- Canonical extension naming is `_sandboxagent/...` and `_meta["sandboxagent.dev"]`; remove/ignore `_sandboxagent/*`.
- Control-plane discovery/status/session APIs are HTTP-only under `/v1/*` (no ACP control-plane equivalents).
- For Health, Filesystem, and Attachments, implementation should port behavior from v1 using commit `8ecd27bc24e62505d7aa4c50cbdd1c9dbb09f836`.
- Session termination via `_sandboxagent/session/terminate` is idempotent.
- `DELETE /v1/rpc` is transport detach only; it must not replace explicit termination semantics.
- Model variants (#8) are removed from current scope.
- `include_raw` (#10) is removed from current scope.
- Models/modes should be optional properties on agent response payloads (only when the agent is installed) and lazily populated.
- Error termination metadata should emit a dedicated session-ended extension event.

## Implementation Order

Features are ordered by dependency chain and implementation complexity. Features that other features depend on come first.

### Phase A: Foundation (control-plane enrichment)

These features enrich existing endpoints and have no dependencies on each other.

| Order | Feature                                      | Spec | Approach                                   | Effort |
|:-----:|----------------------------------------------|:----:|--------------------------------------------|:------:|
| A1    | [Health Endpoint](./05-health-endpoint.md)   | #5   | Port v1 health behavior to `GET /v1/health` | Small  |
| A2    | [Server Status](./06-server-status.md)       | #6   | Add process tracking to ACP runtime         | Medium |
| A3    | [Agent Listing](./12-agent-listing.md)       | #12  | Enrich `GET /v1/agents` with v1-parity data | Medium |

**A2 blocks A3** — agent listing includes server status from Feature #6.

### Phase B: Session lifecycle

Session-level features that build on Phase A runtime tracking.

| Order | Feature                                                      | Spec | Approach                                             | Effort |
|:-----:|--------------------------------------------------------------|:----:|------------------------------------------------------|:------:|
| B1    | [Session Info](./16-session-info.md)                         | #16  | New session info HTTP endpoints                     | Medium |
| B2    | [Session Termination](./07-session-termination.md)           | #7   | Idempotent `_sandboxagent/session/terminate`         | Medium |
| B3    | [Error Termination Metadata](./17-error-termination-metadata.md) | #17  | Stderr capture + `_sandboxagent/session/ended` event | Medium |

**B2 depends on B1** — terminate updates session state visible via session info.
**B3 depends on B1** — termination metadata is stored in session info.

### Phase C: Agent interaction enrichment

Features that add richness to the prompt/response cycle.

| Order | Feature                                          | Spec | Approach                                         | Effort |
|:-----:|--------------------------------------------------|:----:|--------------------------------------------------|:------:|
| C1    | [Message Attachments](./14-message-attachments.md) | #14  | Port v1 attachment behavior via `session/prompt` | Medium |

No internal dependencies.

> **Note:** Questions (#1) deferred to agent process side — see [#156](https://github.com/rivet-dev/sandbox-agent/issues/156).

### Phase D: Discovery and configuration

Pre-session discovery and session configuration features.

| Order | Feature                                                 | Spec | Approach                                                | Effort |
|:-----:|---------------------------------------------------------|:----:|---------------------------------------------------------|:------:|
| D1    | [Models/Modes Listing](./13-models-modes-listing.md)   | #13  | Optional `models`/`modes` on agent response, lazy load | Medium |
| D2    | [Session Creation Richness](./15-session-creation-richness.md) | #15  | **Mostly done**; MCP config processing remains          | Small  |

**D2 is mostly complete** — verify existing `_meta` passthrough; only MCP server config processing may need work.

### Phase E: Platform services

Standalone platform-level API.

| Order | Feature                               | Spec | Approach                         | Effort |
|:-----:|---------------------------------------|:----:|----------------------------------|:------:|
| E1    | [Filesystem API](./04-filesystem-api.md) | #4   | Port v1 behavior to `/v1/fs/*`   | Large  |

No dependencies on other features. Can be implemented at any time but is the largest single feature.

## Dependency Graph

```
A1 (Health)
A2 (Server Status) ──> A3 (Agent Listing)
                   ──> B1 (Session Info) ──> B2 (Session Termination)
                                         ──> B3 (Error Termination Metadata)

C1 (Attachments)         [independent]

D1 (Models/Modes on agent response)
D2 (Session Creation)    [mostly complete]

E1 (Filesystem)          [independent]
```

## Summary Table

| #  | Feature                         | Spec File                                             | Status                          | Approach                                        |
|:--:|---------------------------------|-------------------------------------------------------|---------------------------------|-------------------------------------------------|
| 1  | ~~Questions~~                   | [01-questions.md](./01-questions.md)                 | Deferred ([#156](https://github.com/rivet-dev/sandbox-agent/issues/156)) | Agent process side                              |
| 4  | Filesystem API                  | [04-filesystem-api.md](./04-filesystem-api.md)       | Not implemented                 | Port v1 behavior onto `/v1/fs/*`                |
| 5  | Health Endpoint                 | [05-health-endpoint.md](./05-health-endpoint.md)     | Partial (basic only)            | Port v1 health behavior                         |
| 6  | Server Status                   | [06-server-status.md](./06-server-status.md)         | Not implemented                 | Runtime tracking                                |
| 7  | Session Termination             | [07-session-termination.md](./07-session-termination.md) | Not implemented              | Idempotent ACP extension                        |
| 8  | ~~Model Variants~~              | [08-model-variants.md](./08-model-variants.md)       | Deferred (removed from scope)   | Do not implement                                |
| 10 | ~~include_raw~~                 | [10-include-raw.md](./10-include-raw.md)             | Deferred (removed from scope)   | Do not implement                                |
| 12 | Agent Listing                   | [12-agent-listing.md](./12-agent-listing.md)         | Partial (install state only)    | Enhance existing                                |
| 13 | Models/Modes Listing            | [13-models-modes-listing.md](./13-models-modes-listing.md) | Not implemented           | Optional agent fields; lazy process start       |
| 14 | Message Attachments             | [14-message-attachments.md](./14-message-attachments.md) | Not implemented             | Port v1 behavior via ACP `_meta`                |
| 15 | Session Creation Richness       | [15-session-creation-richness.md](./15-session-creation-richness.md) | **Mostly complete** | Verify existing; MCP config TBD                 |
| 16 | Session Info                    | [16-session-info.md](./16-session-info.md)           | Not implemented                 | New HTTP endpoints                              |
| 17 | Error Termination Metadata      | [17-error-termination-metadata.md](./17-error-termination-metadata.md) | Not implemented       | Runtime stderr + `_sandboxagent/session/ended` |

## Cross-Cutting Concerns

### Files modified by multiple features

| File                                              | Features                      |
|---------------------------------------------------|-------------------------------|
| `server/packages/sandbox-agent/src/router.rs`     | #4, #5, #6, #12, #13, #16    |
| `server/packages/sandbox-agent/src/acp_runtime/mod.rs` | #6, #7, #13, #14, #16, #17 |
| `sdks/typescript/src/client.ts`                   | All in-scope features         |
| `docs/openapi.json`                               | #4, #5, #6, #12, #13, #16    |
| `docs/sdks/typescript.mdx`                        | All in-scope features         |
| `server/packages/sandbox-agent/tests/v1_api.rs`   | All in-scope features         |

### Docs update checklist

- [ ] `docs/openapi.json` — regenerate after all HTTP endpoint changes
- [ ] `docs/cli.mdx` — update for new CLI subcommands (#4, #16)
- [ ] `docs/sdks/typescript.mdx` — update for all new SDK methods
- [ ] `research/acp/spec.md` — update extension methods list
- [ ] `research/acp/rfds-vs-extensions.md` — update status of implemented features
