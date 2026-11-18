# ACP Session Extensibility Status

Status date: 2026-02-10

This document tracks v1 session-surface parity against ACP and defines the recommended extension strategy for features not covered by ACP stable methods.

Primary references:

- `research/acp/v1-schema-to-acp-mapping.md`
- `~/misc/acp-docs/schema/meta.json` (stable methods)
- `~/misc/acp-docs/schema/meta.unstable.json` (unstable methods)
- `~/misc/acp-docs/docs/protocol/extensibility.mdx`

## 1) Status Matrix (Session-Centric)

| v1 capability (session-related) | ACP stable | ACP unstable | Status in v1 | Recommendation |
|---|---|---|---|---|
| Create session | `session/new` | N/A | Covered | Use ACP standard only. |
| Load/replay prior session | `session/load` (capability-gated) | N/A | Covered when agent process supports `loadSession` | Keep standard behavior. |
| Send message | `session/prompt` | N/A | Covered | Use ACP standard only. |
| Stream updates | `session/update` | N/A | Covered | Use ACP standard only. |
| Cancel in-flight turn | `session/cancel` | N/A | Covered | Use ACP standard only. |
| Permission request/reply | `session/request_permission` | N/A | Covered | Use ACP standard only; map `once/always/reject` to option kinds. |
| Session list | Not in stable | `session/list` | Agent-process-dependent | Prefer unstable when supported; fallback to `_sandboxagent/session/list`. |
| Fork session | Not in stable | `session/fork` | Agent-process-dependent | Prefer unstable when supported; fallback extension only if needed. |
| Resume session | Not in stable | `session/resume` | Agent-process-dependent | Prefer unstable when supported; fallback extension only if needed. |
| Set session model | Not in stable | `session/set_model` | Agent-process-dependent | Prefer unstable when supported; otherwise use `session/set_config_option` when model config exists. |
| Terminate session object | No direct method | N/A | Not covered | Add `_sandboxagent/session/terminate` only if product requires explicit termination semantics beyond turn cancel. |
| Poll events/log (`/events`) | No direct method | N/A | Not covered | Avoid as primary flow; if required for compat tooling, add `_sandboxagent/session/events` as derived view over stream. |
| Question request/reply/reject (generic HITL) | No generic question method | N/A | Not covered | Add `_sandboxagent/session/request_question` request/response extension. |
| `skills` in create-session payload | No first-class field | N/A | Not covered | Carry in `_meta["sandboxagent.dev"].skills`; optionally add metadata patch extension for updates. |
| `title` in create-session payload | No first-class field | N/A | Not covered | Carry in `_meta["sandboxagent.dev"].title`. |
| `agentVersion` requested in create-session payload | No first-class field | N/A | Not covered | Carry in `_meta["sandboxagent.dev"].agentVersionRequested`. |
| Client-chosen session ID alias | Agent returns canonical `sessionId` | N/A | Not covered | Carry in `_meta["sandboxagent.dev"].requestedSessionId`. |
| `agentMode` | `session/set_mode` and `current_mode_update` | N/A | Covered when exposed by agent process | Prefer standard `session/set_mode`; fallback to config options. |
| `model` field | `session/set_config_option` (category `model`) | `session/set_model` | Partially covered | Prefer config options, then unstable `session/set_model`, then `_meta` hint if agent process lacks both. |
| `variant` field | `session/set_config_option` (category `thought_level` or custom) | N/A | Partially covered | Prefer config option category; fallback `_meta["sandboxagent.dev"].variant`. |
| `permissionMode` field | No dedicated standard field | N/A | Partially covered | Represent as config option (category `mode` or custom category), else `_meta` hint. |
| Attachments (`path`, `mime`, `filename`) | Prompt content blocks support resource/resource_link/mime | N/A | Mostly covered | Use content blocks; preserve `filename` in `_meta` when not represented natively. |

## 2) Recommended ACP Extension Strategy

Use ACP stable/unstable methods first, then extension methods (`_...`) and `_meta` per ACP extensibility rules.

Rules:

1. Prefer ACP standard methods and capability negotiation.
2. Prefer ACP unstable method names where available and supported by agent process.
3. Only add custom methods for product semantics ACP does not define.
4. Keep custom data in `_meta["sandboxagent.dev"]`; do not add custom root fields.
5. Advertise extension support in `initialize` capability `_meta`.

## 3) Recommended Extension Surface

### 3.1 Session metadata extension (for skills/title/version/aliases)

Use metadata first in `session/new.params._meta["sandboxagent.dev"]`:

```json
{
  "requestedSessionId": "my-session-alias",
  "title": "Bugfix run",
  "skills": ["repo:vercel-labs/skills/nextjs"],
  "agentVersionRequested": "latest",
  "permissionMode": "ask",
  "variant": "high"
}
```

If runtime updates are needed after session creation, add:

- `_sandboxagent/session/set_metadata` (request)
- `_sandboxagent/session/metadata_update` (notification)

### 3.2 Generic question HITL extension

Add:

- `_sandboxagent/session/request_question` (agent -> client request)
- JSON-RPC response with `{ "outcome": "answered" | "rejected" | "cancelled", ... }`

Keep legacy bridge data in `_meta["sandboxagent.dev"]`:

- `questionId`
- original option list
- legacy status mapping

### 3.3 Session lifecycle extension (only where needed)

Add only if required by product UX:

- `_sandboxagent/session/terminate`
- `_sandboxagent/session/events` (poll/read model over stream buffer)

Avoid treating these as primary data paths; ACP stream remains canonical.

### 3.4 Capability advertisement for extensions

Advertise extension support in `initialize.result.agentCapabilities._meta["sandboxagent.dev"]`:

```json
{
  "extensions": {
    "sessionMetadata": true,
    "requestQuestion": true,
    "sessionTerminate": true,
    "sessionEventsPoll": false
  }
}
```

Clients must feature-detect and degrade gracefully.

## 4) Recommendation for Current v1

Recommended implementation order:

1. Keep core session flow strictly ACP standard: `session/new`, `session/prompt`, `session/update`, `session/cancel`, `session/request_permission`.
2. Use ACP unstable methods when agent processes advertise support (`session/list|fork|resume|set_model`).
3. For `skills`, `title`, `requestedSessionId`, `agentVersion`, store and forward under `_meta["sandboxagent.dev"]`.
4. Implement only two custom session extensions now:
   - `_sandboxagent/session/request_question`
   - `_sandboxagent/session/set_metadata` (if post-create metadata updates are required)
5. Defer `_sandboxagent/session/terminate` and `_sandboxagent/session/events` unless a concrete consumer requires them.

This keeps the custom surface small while preserving v1-era product behavior.
