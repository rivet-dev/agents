# Claude Code Research

Research notes on Claude Code's configuration, credential discovery, and runtime behavior based on agent-jj implementation.

## Overview

- **Provider**: Anthropic
- **Execution Method**: CLI subprocess (`claude` command)
- **Session Persistence**: Session ID (string)
- **SDK**: None (spawns CLI directly)

## ACP Terminology (Sandbox Agent v1)

Use these terms consistently when discussing Claude's ACP path:

| Term | Meaning |
|------|---------|
| **ACP agent process launcher** | The command used to start the ACP agent process, commonly an `npx` launcher script that executes `claude-code-acp`. |
| **ACP agent process** | The running ACP agent process spawned by Sandbox Agent from the launcher command. |
| **ACP client** | The client-visible transport handle identified by `X-ACP-Connection-Id`; requests and SSE are scoped to this ACP client. |

Related IDs:

- **ACP client ID**: value of `X-ACP-Connection-Id` (transport identity).
- **ACP session ID**: `sessionId` returned by `session/new` (conversation/session identity within ACP).

## Credential Discovery

### Priority Order

1. User-configured credentials (passed as `ANTHROPIC_API_KEY` env var)
2. Environment variables: `ANTHROPIC_API_KEY` or `CLAUDE_API_KEY`
3. Bootstrap extraction from config files
4. OAuth fallback (Claude CLI handles internally)

### Config File Locations

| Path | Description |
|------|-------------|
| `~/.claude.json.api` | API key config (highest priority) |
| `~/.claude.json` | General config |
| `~/.claude.json.nathan` | User-specific backup (custom) |
| `~/.claude/.credentials.json` | OAuth credentials |
| `~/.claude-oauth-credentials.json` | Docker mount alternative for OAuth |

### API Key Field Names (checked in order)

```json
{
  "primaryApiKey": "sk-ant-...",
  "apiKey": "sk-ant-...",
  "anthropicApiKey": "sk-ant-...",
  "customApiKey": "sk-ant-..."
}
```

Keys must start with `sk-ant-` prefix to be valid.

### OAuth Structure

```json
// ~/.claude/.credentials.json
{
  "claudeAiOauth": {
    "accessToken": "...",
    "expiresAt": "2024-01-01T00:00:00Z"
  }
}
```

OAuth tokens are validated for expiry before use.

## CLI Invocation

### Command Structure

```bash
claude \
  --print \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  [--resume SESSION_ID] \
  [--model MODEL_ID] \
  [--permission-mode plan] \
  "PROMPT"
```

### Arguments

| Flag | Description |
|------|-------------|
| `--print` | Output mode |
| `--output-format stream-json` | Newline-delimited JSON streaming |
| `--verbose` | Verbose output |
| `--dangerously-skip-permissions` | Skip permission prompts |
| `--resume SESSION_ID` | Resume existing session |
| `--model MODEL_ID` | Specify model (e.g., `claude-sonnet-4-20250514`) |
| `--permission-mode plan` | Plan mode (read-only exploration) |

### Environment Variables

Only `ANTHROPIC_API_KEY` is passed if an API key is found. If no key is found, Claude CLI uses its built-in OAuth flow from `~/.claude/.credentials.json`.

## Streaming Response Format

Claude CLI outputs newline-delimited JSON events:

```json
{"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}]}}
{"type": "tool_use", "tool_use": {"name": "Read", "input": {...}}}
{"type": "result", "result": "Final response text", "session_id": "abc123"}
```

### Event Types

| Type | Description |
|------|-------------|
| `assistant` | Assistant message with content blocks |
| `tool_use` | Tool invocation |
| `tool_result` | Tool result (may include `is_error`) |
| `result` | Final result with session ID |

### Content Block Types

```typescript
{
  type: "text" | "tool_use";
  text?: string;
  name?: string;      // tool name
  input?: object;     // tool input
}
```

## Limitations (Headless CLI)

- The headless CLI tool list does not include the `AskUserQuestion` tool, even though the Agent SDK documents it.
- As a result, prompting the CLI to "call AskUserQuestion" does not emit question events; it proceeds with normal tool/message flow instead.
- If we need structured question events, we can implement a wrapper around the Claude Agent SDK (instead of the CLI) and surface question events in our own transport.
- The current Python SDK repo does not expose `AskUserQuestion` types; it only supports permission prompts via the control protocol.

## Response Schema

```typescript
// ClaudeCliResponseSchema
{
  result?: string;           // Final response text
  session_id?: string;       // Session ID for resumption
  structured_output?: unknown; // Optional structured output
  error?: unknown;           // Error information
}
```

## Session Management

- Session ID is captured from streaming events (`event.session_id`)
- Use `--resume SESSION_ID` to continue a session
- Sessions are stored internally by Claude CLI

## Timeout

- Default timeout: 5 minutes (300,000 ms)
- Process is killed with `SIGTERM` on timeout

## Agent Modes vs Permission Modes

Claude conflates agent mode and permission mode - `plan` is a permission restriction that forces planning behavior.

### Permission Modes

| Mode | CLI Flag | Behavior |
|------|----------|----------|
| `default` | (none) | Normal permission prompts |
| `acceptEdits` | `--permission-mode acceptEdits` | Auto-accept file edits |
| `plan` | `--permission-mode plan` | Read-only, must ExitPlanMode to execute |
| `bypassPermissions` | `--dangerously-skip-permissions` | Skip all permission checks |

### Root Restrictions

**Claude refuses to run with `--dangerously-skip-permissions` when running as root (uid 0).**

This is a security measure built into Claude Code. When running as root:
- The CLI outputs: `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`
- The process exits immediately without executing

This affects container environments (Docker, Daytona, E2B, etc.) which commonly run as root.

**Workarounds:**
1. Run as a non-root user in the container
2. Use `default` permission mode (but this requires interactive approval)
3. Use `acceptEdits` mode for file operations (still requires Bash approval)

### Headless Permission Behavior

When permissions are denied in headless mode (`--print --output-format stream-json`):

1. Claude emits a `tool_use` event for the tool (e.g., Write, Bash)
2. A `user` event follows with `tool_result` containing `is_error: true`
3. Error message: `"Claude requested permissions to X, but you haven't granted it yet."`
4. Final `result` event includes `permission_denials` array listing all denied tools

```json
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{...}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"Claude requested permissions to write to /tmp/test.txt, but you haven't granted it yet."}]}}
{"type":"result","permission_denials":[{"tool_name":"Write","tool_use_id":"...","tool_input":{...}}]}
```

### Subagent Types

Claude supports spawning subagents via the `Task` tool with `subagent_type`:
- Custom agents defined in config
- Built-in agents like "Explore", "Plan"

### ExitPlanMode (Plan Approval)

When in `plan` permission mode, agent invokes `ExitPlanMode` tool to request execution:

```typescript
interface ExitPlanModeInput {
  allowedPrompts?: Array<{
    tool: "Bash";
    prompt: string;  // e.g., "run tests"
  }>;
}
```

This triggers a user approval event. In the universal API, this is converted to a question event with approve/reject options.

## Error Handling

- Non-zero exit codes result in errors
- stderr is captured and included in error messages
- Spawn errors are caught separately

## Conversion to Universal Format

Claude output is converted via `convertClaudeOutput()`:

1. If response is a string, wrap as assistant message
2. If response is object with `result` field, extract content
3. Parse with `ClaudeCliResponseSchema` as fallback
4. Extract `structured_output` as metadata if present

## Model Discovery

Claude Code's `/models` slash command uses the **standard Anthropic Models API**.

### API Endpoint

```
GET https://api.anthropic.com/v1/models?beta=true
```

Found by reverse engineering the CLI bundle at `node_modules/@anthropic-ai/claude-code/cli.js`.

### API Client

The CLI contains an internal `Models` class with two methods:

```javascript
// List all models
GET /v1/models?beta=true

// Retrieve a single model
GET /v1/models/${modelId}?beta=true
```

Uses `this._client.getAPIList()` which handles paginated responses. The `?beta=true` query parameter is hardcoded to include beta/preview models.

### Authentication

Uses the same Anthropic API key / OAuth credentials that Claude Code uses for conversations. The request goes to the standard Anthropic API base URL.

### Hardcoded Context Window Data

The CLI also contains hardcoded output token limits for certain models (used as fallback):

```javascript
{
  "claude-opus-4-20250514": 8192,
  "claude-opus-4-0": 8192,
  "claude-opus-4-1-20250805": 8192,
  // ... more entries
}
```

### How to Replicate

Call the Anthropic API directly — no need to go through the Claude CLI:

```
GET https://api.anthropic.com/v1/models?beta=true
x-api-key: <ANTHROPIC_API_KEY>
anthropic-version: 2023-06-01
```

## Command Execution & Process Management

### Agent Tool Execution

The agent executes commands via the `Bash` tool. This is synchronous - the agent blocks until the command exits. Tool schema:

```json
{
  "command": "string",
  "timeout": "number",
  "workingDirectory": "string"
}
```

There is no background process support. If the agent needs a long-running process (e.g., dev server), it uses shell backgrounding (`&`) within a single `Bash` tool call.

### User-Initiated Command Execution (`!` prefix)

Claude Code's TUI supports `!command` syntax where the user types `!npm test` to run a command directly. The output is injected into the conversation as a user message so the agent can see it on the next turn.

**This is a client-side TUI feature only.** It is not exposed in the API schema or streaming protocol. The CLI runs the command locally and stuffs the output into the next user message. There is no protocol-level concept of "user ran a command" vs "agent ran a command."

### No External Command Injection API

External clients (SDKs, frontends) cannot programmatically inject command results into Claude's conversation context. The only way to provide command output to the agent is:
- Include it in the user prompt text
- Use the `!` prefix in the interactive TUI

### Comparison

| Capability | Supported? | Notes |
|-----------|-----------|-------|
| Agent runs commands | Yes (`Bash` tool) | Synchronous, blocks agent turn |
| User runs commands → agent sees output | Yes (`!cmd` in TUI) | Client-side only, not in protocol |
| External API for command injection | No | |
| Background process management | No | Shell `&` only |
| PTY / interactive terminal | No | |

## Notes

- Claude CLI manages its own OAuth refresh internally
- No SDK dependency - direct CLI subprocess
- stdin is closed immediately after spawn
- Working directory is set via `cwd` option on spawn
