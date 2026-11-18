# ACP Notes (From Docs)

## Core protocol model

ACP is JSON-RPC 2.0 with bidirectional methods plus notifications.

Client to agent baseline methods:

- `initialize`
- `authenticate` (optional if agent requires auth)
- `session/new`
- `session/prompt`
- optional: `session/load`, `session/set_mode`, `session/set_config_option`
- notification: `session/cancel`

Agent to client baseline method:

- `session/request_permission`

Agent to client optional methods:

- `fs/read_text_file`, `fs/write_text_file`
- `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`

Agent to client baseline notification:

- `session/update`

## Required protocol behavior

- Paths must be absolute.
- Line numbers are 1-based.
- Initialization must negotiate protocol version.
- Capabilities omitted by peer must be treated as unsupported.

## Transport state

- ACP formally defines stdio transport today.
- ACP docs mention streamable HTTP as draft/in progress.
- Custom transports are allowed if JSON-RPC lifecycle semantics are preserved.

## Session lifecycle

- `session/new` creates session, returns `sessionId`.
- `session/load` is optional and gated by `loadSession` capability.
- `session/prompt` runs one turn and returns `stopReason`.
- Streaming progress is entirely via `session/update` notifications.
- Cancellation is `session/cancel` notification and must end with `stopReason=cancelled`.

## Tool and HITL model

- Tool calls are modeled through `session/update` (`tool_call`, `tool_call_update`).
- HITL permission flow is a request/response RPC call (`session/request_permission`).

## ACP agent process relevance for this repo

From ACP docs agent list:

- Claude: ACP via agent process (`zed-industries/claude-code-acp`).
- Codex: ACP via agent process (`zed-industries/codex-acp`).
- OpenCode: ACP agent listed natively.

Gap to confirm for launch scope:

- Amp is not currently listed in ACP docs as a native ACP agent or published agent process.
- We need an explicit product decision: block Amp in v1 launch or provide/build an ACP agent process.
