# Amp Research

Research notes on Sourcegraph Amp's configuration, credential discovery, and runtime behavior.

## Overview

- **Provider**: Anthropic (via Sourcegraph, proxied through ampcode.com)
- **Execution Method**: CLI subprocess (`amp` command)
- **Session Persistence**: Session ID (string)
- **SDK**: `@sourcegraph/amp-sdk` (closed source)
- **Binary**: Bun-bundled JS application (ELF wrapping Bun runtime + embedded JS)
- **Binary Location**: `/usr/local/bin/amp`
- **Backend**: `https://ampcode.com/` (server-side proxy for all LLM requests)

## CLI Usage

### Interactive Mode
```bash
amp "your prompt here"
amp --model claude-sonnet-4 "your prompt"
```

### Non-Interactive Mode
```bash
amp --print --output-format stream-json "your prompt"
amp --print --output-format stream-json --dangerously-skip-permissions "prompt"
amp --continue SESSION_ID "follow up"
```

### Key CLI Flags

| Flag | Description |
|------|-------------|
| `--print` | Output mode (non-interactive) |
| `--output-format stream-json` | JSONL streaming output |
| `--dangerously-skip-permissions` | Skip permission prompts |
| `--continue SESSION_ID` | Resume existing session |
| `--model MODEL` | Specify model |
| `--toolbox TOOLBOX` | Toolbox configuration |

## Credential Discovery

### Priority Order

1. Environment variable: `ANTHROPIC_API_KEY`
2. Sourcegraph authentication
3. Claude Code credentials (shared)

### Config File Locations

| Path | Description |
|------|-------------|
| `~/.amp/config.json` | Primary config |
| `~/.claude/.credentials.json` | Shared with Claude Code |

Amp can use Claude Code's OAuth credentials as fallback.

## Streaming Response Format

Amp outputs newline-delimited JSON events:

```json
{"type": "system", "subtype": "init", "session_id": "...", "tools": [...]}
{"type": "assistant", "message": {...}, "session_id": "..."}
{"type": "user", "message": {...}, "session_id": "..."}
{"type": "result", "subtype": "success", "result": "...", "session_id": "..."}
```

### Event Types

| Type | Description |
|------|-------------|
| `system` | System initialization with tools list |
| `assistant` | Assistant message with content blocks |
| `user` | User message (tool results) |
| `result` | Final result with session ID |

### Content Block Types

```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "thinking"; thinking: string }
  | { type: "redacted_thinking"; data: string };
```

## Response Schema

```typescript
interface AmpResultMessage {
  type: "result";
  subtype: "success";
  duration_ms: number;
  is_error: boolean;
  num_turns: number;
  result: string;
  session_id: string;
}
```

## Session Management

- Session ID captured from streaming events
- Use `--continue SESSION_ID` to resume
- Sessions stored internally by Amp CLI

## Agent Modes vs Permission Modes

### Permission Modes (Declarative Rules)

Amp uses declarative permission rules configured before execution:

```typescript
interface PermissionRule {
  tool: string;  // Glob pattern: "Bash", "mcp__playwright__*"
  matches?: { [argumentName: string]: string | string[] | boolean };
  action: "allow" | "reject" | "ask" | "delegate";
  context?: "thread" | "subagent";
}
```

| Action | Behavior |
|--------|----------|
| `allow` | Automatically permit |
| `reject` | Automatically deny |
| `ask` | Prompt user (CLI handles internally) |
| `delegate` | Delegate to subagent context |

### Example Rules

```typescript
const permissions: PermissionRule[] = [
  { tool: "Read", action: "allow" },
  { tool: "Bash", matches: { command: "git *" }, action: "allow" },
  { tool: "Write", action: "ask" },
  { tool: "mcp__*", action: "reject" }
];
```

### Agent Modes

No documented agent mode concept. Behavior controlled via:
- `--toolbox` flag for different tool configurations
- Permission rules for feature coverage restrictions

### Bypass All Permissions

```bash
amp --dangerously-skip-permissions "prompt"
```

Or via SDK:
```typescript
execute(prompt, { dangerouslyAllowAll: true });
```

## Human-in-the-Loop

### No Interactive HITL API

While permission rules support `"ask"` action, Amp does not expose an SDK-level API for programmatically responding to permission requests. The CLI handles user interaction internally.

For universal API integration, Amp should be run with:
- Pre-configured permission rules, or
- `dangerouslyAllowAll: true` to bypass

## SDK Usage

```typescript
import { execute, type AmpOptions } from '@sourcegraph/amp-sdk';

interface AmpOptions {
  cwd?: string;
  dangerouslyAllowAll?: boolean;
  toolbox?: string;
  mcpConfig?: MCPConfig;
  permissions?: PermissionRule[];
  continue?: boolean | string;
}

const result = await execute(prompt, options);
```

## Installation

```bash
# Get latest version
VERSION=$(curl -s https://storage.googleapis.com/amp-public-assets-prod-0/cli/cli-version.txt)

# Linux x64
curl -fsSL "https://storage.googleapis.com/amp-public-assets-prod-0/cli/${VERSION}/amp-linux-x64" \
  -o /usr/local/bin/amp && chmod +x /usr/local/bin/amp

# Linux ARM64
curl -fsSL "https://storage.googleapis.com/amp-public-assets-prod-0/cli/${VERSION}/amp-linux-arm64" \
  -o /usr/local/bin/amp && chmod +x /usr/local/bin/amp

# macOS ARM64
curl -fsSL "https://storage.googleapis.com/amp-public-assets-prod-0/cli/${VERSION}/amp-darwin-arm64" \
  -o /usr/local/bin/amp && chmod +x /usr/local/bin/amp

# macOS x64
curl -fsSL "https://storage.googleapis.com/amp-public-assets-prod-0/cli/${VERSION}/amp-darwin-x64" \
  -o /usr/local/bin/amp && chmod +x /usr/local/bin/amp
```

## Timeout

- Default timeout: 5 minutes (300,000 ms)
- Process killed with `SIGTERM` on timeout

## Model Discovery

**No model discovery mechanism exists.** Amp uses a server-side proxy architecture where model selection is abstracted behind "modes".

### Architecture (Reverse Engineered)

Amp is **NOT a Go binary** as previously thought — it is a **Bun-bundled JavaScript application** (ELF binary wrapping Bun runtime + embedded JS). The CLI logs confirm: `"argv":["bun","/$bunfs/root/amp-linux-x64",...]`.

**Amp is a server-side proxy.** All LLM requests go through `https://ampcode.com/`:
1. CLI authenticates via `AMP_API_KEY` env var or browser-based OAuth to `https://ampcode.com/auth/cli-login`
2. On startup, calls `getUserInfo` against `https://ampcode.com/`
3. Model selection is handled **server-side**, not client-side

### Modes Instead of Models

Amp uses **modes** (`--mode` / `-m` flag) instead of direct model selection. Each mode bundles a model, system prompt, and tool selection together server-side.

#### Agent Modes

| Mode | Primary Model | Description |
|------|---------------|-------------|
| `smart` | Claude Opus 4.6 | Default. Unconstrained state-of-the-art model use, maximum capability and autonomy |
| `rush` | Claude Haiku 4.5 | Faster and cheaper, suitable for small, well-defined tasks |
| `deep` | GPT-5.2 Codex | Deep reasoning with extended thinking for complex problems. Requires `amp.experimental.modes: ["deep"]` |
| `free` | Unknown | Free tier (listed in CLI `--help` but not on docs site) |
| `large` | Unknown | Hidden/undocumented mode (referenced in docs but no details) |

Source: [ampcode.com/manual](https://ampcode.com/manual), [ampcode.com/models](https://ampcode.com/models)

#### Specialized Models (not user-selectable)

Amp also uses additional models for specific subtasks:

| Role | Model | Purpose |
|------|-------|---------|
| Review | Gemini 3 Pro | Code review and bug detection |
| Search subagent | Gemini 3 Flash | Codebase retrieval |
| Oracle subagent | GPT-5.2 | Complex code reasoning |
| Librarian subagent | Claude Sonnet 4.5 | External code research |
| Image/PDF analysis | Gemini 3 Flash | Multimodal input processing |
| Content generation | Gemini 3 Pro Image (Painter) | Image generation |
| Task (context) | Gemini 2.5 Flash | Context management |
| Thread categorization | Gemini 2.5 Flash-Lite | Thread organization |
| Title generation | Claude Haiku 4.5 | Thread title generation |

#### Mode Subsettings

- **`amp.experimental.modes`** — Array of experimental mode names to enable. Currently only `["deep"]` is documented.
- **`amp.internal.deepReasoningEffort`** — Override reasoning effort for GPT-5.2 Codex in deep mode. Options: `medium`, `high`, `xhigh`. Default: `medium`. Keyboard shortcut `Alt+D` cycles through `deep` → `deep²` → `deep³` (corresponding to medium → high → xhigh).

#### Switching Modes

- **CLI flag**: `--mode <value>` or `-m <value>`
- **Interactive TUI**: `Ctrl+O` → type "mode"
- **Editor extension**: Mode selector in the prompt field

#### No Programmatic Mode Listing

There is no CLI command (`amp modes list`) or API endpoint to list available modes. The modes are:
- Hardcoded in the `--help` text: `deep, free, rush, smart`
- Documented on [ampcode.com/manual](https://ampcode.com/manual) and [ampcode.com/models](https://ampcode.com/models)
- Up-to-date list available at [ampcode.com/manual#agent-modes](https://ampcode.com/manual#agent-modes)

The `--model` flag also still exists on the CLI but modes are the primary interface. It's unclear if `--model` bypasses mode selection or if it's ignored.

### Reverse Engineering Methodology

#### Step 1: CLI help analysis

```bash
amp --help
```

Revealed:
- `-m, --mode <value>` flag with `deep`, `free`, `rush`, `smart` options (not `--model` for models)
- `AMP_URL` env var defaults to `https://ampcode.com/`
- `AMP_API_KEY` env var for authentication
- Settings at `~/.config/amp/settings.json`
- Logs at `~/.cache/amp/logs/cli.log`

#### Step 2: Binary analysis

```bash
file ~/.local/bin/amp   # → ELF 64-bit LSB executable, 117MB
ls -lh ~/.local/bin/amp # → 117M
strings ~/.local/bin/amp | grep 'ampcode' # → 43 matches, embedded JS visible
```

The `file` command showed an ELF binary, initially suggesting a compiled Go binary. But `strings` revealed embedded JavaScript source code, and the debug logs later confirmed it's actually a **Bun-bundled application** (`argv: ["bun", "/$bunfs/root/amp-linux-x64", ...]`).

The embedded JS is minified but partially readable via `strings`. Found tool definitions (`edit_file`, `write_file`, `create_file`), skill loading code, and MCP integration code. Did not find hardcoded model lists or mode→model mappings — these are server-side.

#### Step 3: strace (failed for network, useful for file IO)

```bash
strace -e trace=connect -f amp --execute "say hello" ...
```

**Result: No `AF_INET` connections captured.** Only saw:
- `AF_UNIX` socket to `/tmp/tmux-1000/default` (tmux IPC)
- `socketpair()` for internal IPC between threads

**Why it failed:** Bun uses `io_uring` for async network IO on Linux, which bypasses traditional `connect()`/`sendto()` syscalls. strace hooks into the syscall layer, but io_uring submits work directly to the kernel via shared memory rings, making it invisible to strace.

Even with full syscall tracing (`strace -f -s 512` capturing 27,000 lines), zero TCP connections appeared.

#### Step 4: Process network inspection (partial success)

```bash
# While amp was running:
ss -tnp | grep amp
cat /proc/<pid>/net/tcp6
```

From `/proc/net/tcp6`, decoded a connection to port `01BB` (443/HTTPS). Resolved the destination to `34.54.147.251` via:

```bash
dig ampcode.com +short  # → 34.54.147.251
```

Confirmed Amp connects to `ampcode.com:443`. But `ss -tnp` couldn't attribute the connection to the amp process (process had already exited or Bun's process model confused ss).

#### Step 5: Debug logging (most useful)

```bash
env AMP_API_KEY=fake-key amp --execute "say hello" --stream-json --log-level debug
# Then read: ~/.cache/amp/logs/cli.log
```

The debug log revealed the complete startup sequence and API flow. Key log messages:
- `"Initializing CLI context"` — shows `hasAmpAPIKey`, `hasAmpURL`, `hasSettingsFile`
- `"Resolved Amp URL"` → `https://ampcode.com/`
- `"API key lookup before login"` — `found: true/false`
- `"API request for getUserInfo failed: 401"` — confirms API call to ampcode.com with our fake key
- `"Starting Amp background services"` — proceeds even after auth failure

#### Step 6: Fake API key to bypass login (success)

Without `AMP_API_KEY`, Amp hangs indefinitely trying to open a browser for OAuth at `https://ampcode.com/auth/cli-login?authToken=...&callbackPort=...`. Setting `AMP_API_KEY=fake-key` bypasses the browser login flow and reaches the API call stage (where it gets a 401).

#### Step 7: NODE_DEBUG (failed)

```bash
env NODE_DEBUG=http,https,net amp ...
```

No output — Bun ignores Node.js debug environment variables.

### What Was NOT Captured

- **Actual HTTP request/response bodies** — Would require mitmproxy with HTTPS interception (set `amp.proxy` or `HTTPS_PROXY` env var, install custom CA cert). Not attempted.
- **Mode→model mappings** — These are server-side in ampcode.com. The CLI sends a mode name and the server selects the model.
- **Full API schema** — Only saw `getUserInfo` endpoint name in error message. Thread creation, message streaming, and other endpoints are unknown.
- **Whether `--model` bypasses mode selection** — Couldn't test without a valid API key.

### Future Investigation

To capture full HTTP traffic, set up mitmproxy:

```bash
# Install mitmproxy
pip install mitmproxy

# Start proxy
mitmproxy --listen-port 8080

# Run amp through proxy (amp.proxy setting or env var)
# amp respects amp.proxy setting in ~/.config/amp/settings.json:
# { "amp.proxy": "http://localhost:8080" }
#
# Then install mitmproxy's CA cert for TLS interception.
```

Alternatively, since amp is a Bun binary, it may respect `HTTPS_PROXY` env var by default (Go's `net/http` does, Bun's `fetch` may as well).

### API Flow (from debug logs)

```
1. "Starting Amp CLI" (version 0.0.1770352274-gd36e02)
2. "Initializing CLI context" (hasAmpAPIKey: true/false)
3. "Resolved Amp URL" → https://ampcode.com/
4. Skills loading, MCP initialization, toolbox registration
5. "API key lookup before login"
6. getUserInfo API call → https://ampcode.com/ (401 with invalid key)
7. "Starting Amp background services"
8. Thread creation + message streaming via ampcode.com
```

### Current Behavior

The sandbox-agent passes `--model` through to Amp without validation:

```rust
if let Some(model) = options.model.as_deref() {
    command.arg("--model").arg(model);
}
```

### Possible Approaches

1. **Proxy provider APIs** — Not applicable; Amp proxies through ampcode.com, not directly to model providers
2. **Hardcode known modes** — Expose the four modes (`deep`, `free`, `rush`, `smart`) as the available "model" options
3. **Wait for Amp API** — Amp may add model/mode discovery in a future release
4. **Scrape ampcode.com** — Check if the web UI exposes available modes/models

## Command Execution & Process Management

### Agent Tool Execution

Amp executes commands via the `Bash` tool, similar to Claude Code. Synchronous execution, blocks the agent turn. Permission rules can pre-authorize specific commands:

```typescript
{ tool: "Bash", matches: { command: "git *" }, action: "allow" }
```

### No User-Initiated Command Injection

Amp does not expose any mechanism for external clients to inject command results into the agent's context. No `!` prefix equivalent, no command injection API.

### Comparison

| Capability | Supported? | Notes |
|-----------|-----------|-------|
| Agent runs commands | Yes (`Bash` tool) | Synchronous, blocks agent turn |
| User runs commands → agent sees output | No | |
| External API for command injection | No | |
| Command source tracking | No | |
| Background process management | No | Shell `&` only |
| PTY / interactive terminal | No | |

## Notes

- Amp is similar to Claude Code (same streaming format)
- Can share credentials with Claude Code
- No interactive HITL - must use pre-configured permissions
- SDK is closed source but types are documented
- MCP server integration supported via `mcpConfig`
