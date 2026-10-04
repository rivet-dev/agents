# OpenCode Research

Research notes on OpenCode's configuration, credential discovery, and runtime behavior based on agent-jj implementation.

## Overview

- **Provider**: Multi-provider (OpenAI, Anthropic, others)
- **Execution Method**: Embedded server via SDK, or CLI binary
- **Session Persistence**: Session ID (string)
- **SDK**: `@opencode-ai/sdk` (server + client)
- **Binary Location**: `~/.opencode/bin/opencode`
- **Written in**: Go (with Bubble Tea TUI)

## CLI Usage (Alternative to SDK)

OpenCode can be used as a standalone binary instead of embedding the SDK:

### Interactive TUI Mode
```bash
opencode                      # Start TUI in current directory
opencode /path/to/project     # Start in specific directory
opencode -c                   # Continue last session
opencode -s SESSION_ID        # Continue specific session
```

### Non-Interactive Mode (`opencode run`)
```bash
opencode run "your prompt here"
opencode run --format json "prompt"   # Raw JSON events output
opencode run -m anthropic/claude-sonnet-4-20250514 "prompt"
opencode run --agent plan "analyze this code"
opencode run -c "follow up question"  # Continue last session
opencode run -s SESSION_ID "prompt"   # Continue specific session
opencode run -f file1.ts -f file2.ts "review these files"
```

### Key CLI Flags
| Flag | Description |
|------|-------------|
| `--format json` | Output raw JSON events (for parsing) |
| `-m, --model PROVIDER/MODEL` | Model in format `provider/model` |
| `--agent AGENT` | Agent to use (`build`, `plan`) |
| `-c, --continue` | Continue last session |
| `-s, --session ID` | Continue specific session |
| `-f, --file FILE` | Attach file(s) to message |
| `--attach URL` | Attach to running server |
| `--port PORT` | Local server port |
| `--variant VARIANT` | Reasoning effort (e.g., `high`, `max`) |

### Headless Server Mode
```bash
opencode serve                        # Start headless server
opencode serve --port 4096            # Specific port
opencode attach http://localhost:4096 # Attach to running server
```

### Other Commands
```bash
opencode models                 # List available models
opencode models anthropic       # List models for provider
opencode auth                   # Manage credentials
opencode session                # Manage sessions
opencode export SESSION_ID      # Export session as JSON
opencode stats                  # Token usage statistics
```

Sources: [OpenCode GitHub](https://github.com/opencode-ai/opencode), [OpenCode Docs](https://opencode.ai/docs/cli/)

## Architecture

OpenCode runs as an embedded HTTP server per workspace/change:

```
┌─────────────────────┐
│   agent-jj backend  │
│                     │
│  ┌───────────────┐  │
│  │ OpenCode      │  │
│  │ Server        │◄─┼── HTTP API
│  │ (per change)  │  │
│  └───────────────┘  │
└─────────────────────┘
```

- One server per `changeId` (workspace+repo+change combination)
- Multiple sessions can share a server
- Server runs on dynamic port (4200-4300 range)

## Credential Discovery

### Priority Order

1. Environment variables: `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`
2. Environment variables: `OPENAI_API_KEY`, `CODEX_API_KEY`
3. Claude Code config files
4. Codex config files
5. OpenCode config files

### Config File Location

| Path | Description |
|------|-------------|
| `~/.local/share/opencode/auth.json` | Primary auth config |

### Auth File Structure

```json
{
  "anthropic": {
    "type": "api",
    "key": "sk-ant-..."
  },
  "openai": {
    "type": "api",
    "key": "sk-..."
  },
  "custom-provider": {
    "type": "oauth",
    "access": "token...",
    "refresh": "refresh-token...",
    "expires": 1704067200000
  }
}
```

### Provider Config Types

```typescript
interface OpenCodeProviderConfig {
  type: "api" | "oauth";
  key?: string;      // For API type
  access?: string;   // For OAuth type
  refresh?: string;  // For OAuth type
  expires?: number;  // Unix timestamp (ms)
}
```

OAuth tokens are validated for expiry before use.

## Server Management

### Starting a Server

```typescript
import { createOpencodeServer } from "@opencode-ai/sdk/server";
import { createOpencodeClient } from "@opencode-ai/sdk";

const server = await createOpencodeServer({
  hostname: "127.0.0.1",
  port: 4200,
  config: { logLevel: "DEBUG" }
});

const client = createOpencodeClient({
  baseUrl: `http://127.0.0.1:${port}`
});
```

### Server Configuration

```typescript
// From config.json
{
  "opencode": {
    "host": "127.0.0.1",        // Bind address
    "advertisedHost": "127.0.0.1" // External address (for tunnels)
  }
}
```

### Port Selection

Uses `get-port` package to find available port in range 4200-4300.

## Client API

### Session Management

```typescript
// Create session
const response = await client.session.create({});
const sessionId = response.data.id;

// Get session info
const session = await client.session.get({ path: { id: sessionId } });

// Get session messages
const messages = await client.session.messages({ path: { id: sessionId } });

// Get session todos
const todos = await client.session.todo({ path: { id: sessionId } });
```

### Sending Prompts

#### Synchronous

```typescript
const response = await client.session.prompt({
  path: { id: sessionId },
  body: {
    model: { providerID: "openai", modelID: "gpt-4o" },
    agent: "build",
    parts: [{ type: "text", text: "prompt text" }]
  }
});
```

#### Asynchronous (Streaming)

```typescript
// Start prompt asynchronously
await client.session.promptAsync({
  path: { id: sessionId },
  body: {
    model: { providerID: "openai", modelID: "gpt-4o" },
    agent: "build",
    parts: [{ type: "text", text: "prompt text" }]
  }
});

// Subscribe to events
const eventStream = await client.event.subscribe({});

for await (const event of eventStream.stream) {
  // Process events
}
```

## Event Types

| Event Type | Description |
|------------|-------------|
| `message.part.updated` | Message part streamed/updated |
| `session.status` | Session status changed |
| `session.idle` | Session finished processing |
| `session.error` | Session error occurred |
| `question.asked` | AI asking user question |
| `permission.asked` | AI requesting permission |

### Event Structure

```typescript
interface SDKEvent {
  type: string;
  properties: {
    part?: SDKPart & { sessionID?: string };
    delta?: string;          // Text delta for streaming
    status?: { type?: string };
    sessionID?: string;
    error?: { data?: { message?: string } };
    id?: string;
    questions?: QuestionInfo[];
    permission?: string;
    patterns?: string[];
    metadata?: Record<string, unknown>;
    always?: string[];
    tool?: { messageID?: string; callID?: string };
  };
}
```

## Message Parts

OpenCode has rich message part types:

| Type | Description |
|------|-------------|
| `text` | Plain text content |
| `reasoning` | Model reasoning (chain-of-thought) |
| `tool` | Tool invocation with status |
| `file` | File reference |
| `step-start` | Step boundary start |
| `step-finish` | Step boundary end with reason |
| `subtask` | Delegated subtask |

### Part Structure

```typescript
interface MessagePart {
  type: "text" | "reasoning" | "tool" | "file" | "step-start" | "step-finish" | "subtask" | "other";
  id: string;
  content: string;
  // Tool-specific
  toolName?: string;
  toolStatus?: "pending" | "running" | "completed" | "error";
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  // File-specific
  filename?: string;
  mimeType?: string;
  // Step-specific
  stepReason?: string;
  // Subtask-specific
  subtaskAgent?: string;
  subtaskDescription?: string;
}
```

## Questions and Permissions

### Question Request

```typescript
interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: Array<{
    header?: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  tool?: { messageID: string; callID: string };
}
```

### Responding to Questions

```typescript
// V1 client for question/permission APIs
const clientV1 = createOpencodeClientV1({
  baseUrl: `http://127.0.0.1:${port}`
});

// Reply with answers
await clientV1.question.reply({
  requestID: requestId,
  answers: [["selected option"]]  // Array of selected labels per question
});

// Reject question
await clientV1.question.reject({ requestID: requestId });
```

### Permission Request

```typescript
interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;     // Permission type (e.g., "file:write")
  patterns: string[];     // Affected paths/patterns
  metadata: Record<string, unknown>;
  always: string[];       // Options for "always allow"
  tool?: { messageID: string; callID: string };
}
```

### Responding to Permissions

```typescript
await clientV1.permission.reply({
  requestID: requestId,
  reply: "once" | "always" | "reject"
});
```

## Provider/Model Discovery

```typescript
// Get available providers and models
const providerResponse = await client.provider.list({});
const agentResponse = await client.app.agents({});

interface ProviderInfo {
  id: string;
  name: string;
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    toolCall: boolean;
  }>;
}

interface AgentInfo {
  id: string;
  name: string;
  primary: boolean;  // "build" and "plan" are primary
}
```

### Internal Agents (Hidden from UI)

- `compaction`
- `title`
- `summary`

## Token Usage

```typescript
interface TokenUsage {
  input: number;
  output: number;
  reasoning?: number;
  cache?: {
    read: number;
    write: number;
  };
}
```

Available in message `info` field for assistant messages.

## Agent Modes vs Permission Modes

OpenCode properly separates these concepts:

### Agent Modes

Agents are first-class concepts with their own system prompts and behavior:

| Agent ID | Description |
|----------|-------------|
| `build` | Default execution agent |
| `plan` | Planning/analysis agent |
| Custom | User-defined agents in config |

```typescript
// Sending a prompt with specific agent
await client.session.promptAsync({
  body: {
    agent: "plan",  // or "build", or custom agent ID
    parts: [{ type: "text", text: "..." }]
  }
});
```

### Listing Available Agents

```typescript
const agents = await client.app.agents({});
// Returns: [{ id: "build", name: "Build", primary: true }, ...]
```

### Permission Modes

Permissions are configured via rulesets on the session, separate from agent selection:

```typescript
interface PermissionRuleset {
  // Tool-specific permission rules
}
```

### Human-in-the-Loop

OpenCode has full interactive HITL via SSE events:

| Event | Endpoint |
|-------|----------|
| `question.asked` | `POST /question/{id}/reply` |
| `permission.asked` | `POST /permission/{id}/reply` |

See `research/human-in-the-loop.md` for full API details.

## Defaults

```typescript
const DEFAULT_OPENCODE_MODEL_ID = "gpt-4o";
const DEFAULT_OPENCODE_PROVIDER_ID = "openai";
```

## Concurrency Control

Server startup uses a lock to prevent race conditions:

```typescript
async function withStartLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = startLock;
  let release: () => void;
  startLock = new Promise((resolve) => { release = resolve; });
  await prior;
  try {
    return await fn();
  } finally {
    release();
  }
}
```

## Working Directory

Server must be started in the correct working directory:

```typescript
async function withWorkingDir<T>(workingDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(workingDir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}
```

## Polling Fallback

A polling mechanism checks session status every 2 seconds in case SSE events don't arrive:

```typescript
const pollInterval = setInterval(async () => {
  const session = await client.session.get({ path: { id: sessionId } });
  if (session.data?.status?.type === "idle") {
    abortController.abort();
  }
}, 2000);
```

## Model Discovery

OpenCode has the richest model discovery support with both CLI and HTTP API.

### CLI Commands

```bash
opencode models                 # List all available models
opencode models <provider>      # List models for a specific provider
```

### HTTP Endpoint

```
GET /provider
```

### Response Schema

```json
{
  "all": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "api": "string",
      "env": ["ANTHROPIC_API_KEY"],
      "npm": "string",
      "models": {
        "model-key": {
          "id": "string",
          "name": "string",
          "family": "string",
          "release_date": "string",
          "attachment": true,
          "reasoning": false,
          "tool_call": true,
          "cost": {
            "input": 0.003,
            "output": 0.015,
            "cache_read": 0.0003,
            "cache_write": 0.00375
          },
          "limit": {
            "context": 200000,
            "input": 200000,
            "output": 8192
          },
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "experimental": false,
          "status": "beta"
        }
      }
    }
  ],
  "default": {
    "anthropic": "claude-sonnet-4-20250514"
  },
  "connected": ["anthropic"]
}
```

### SDK Usage

```typescript
const client = createOpencodeClient();
const response = await client.provider.list();
```

### How to Replicate

When an OpenCode server is running, call `GET /provider` on its HTTP port. Returns full model metadata including capabilities, costs, context limits, and modalities.

## Command Execution & Process Management

### Agent Tool Execution

The agent executes commands via internal tools (not exposed in the HTTP API). The agent's tool calls are synchronous within its turn. Tool parts have states: `pending`, `running`, `completed`, `error`.

### PTY System (`/pty/*`) - User-Facing Terminals

Separate from the agent's command execution. PTYs are server-scoped interactive terminals for the user:

- `POST /pty` - Create PTY (command, args, cwd, title, env)
- `GET /pty` - List all PTYs
- `GET /pty/{ptyID}` - Get PTY info
- `PUT /pty/{ptyID}` - Update PTY (title, resize via `size: {rows, cols}`)
- `DELETE /pty/{ptyID}` - Kill and remove PTY
- `GET /pty/{ptyID}/connect` - WebSocket for bidirectional I/O

PTY events (globally broadcast via SSE): `pty.created`, `pty.updated`, `pty.exited`, `pty.deleted`.

The agent does NOT use the PTY system. PTYs are for the user's interactive terminal panel, independent of any AI session.

### Session Commands (`/session/{id}/command`, `/session/{id}/shell`) - Context Injection

External clients can inject command results into an AI session's conversation context:

- `POST /session/{sessionID}/command` - Executes a command and records the result as an `AssistantMessage` in the session. Required fields: `command`, `arguments`. The output becomes part of the AI's context for subsequent turns.
- `POST /session/{sessionID}/shell` - Similar but wraps in `sh -c`. Required fields: `command`, `agent`.
- `GET /command` - Lists available command definitions (metadata, not execution).

Session commands emit `command.executed` events with `sessionID` + `messageID`.

**Key distinction**: These endpoints execute commands directly (not via the AI), then inject the output into the session as if the AI produced it. The AI doesn't actively run the command - it just finds the output in its conversation history on the next turn.

### Three Separate Execution Mechanisms

| Mechanism | Who uses it | Scoped to | AI sees output? |
|-----------|-------------|-----------|----------------|
| Agent tools (internal) | AI agent | Session turn | Yes (immediate) |
| PTY (`/pty/*`) | User/frontend | Server (global) | No |
| Session commands (`/session/{id}/*`) | Frontend/SDK client | Session | Yes (next turn) |

The agent has no tool to interact with PTYs and cannot access the session command endpoints. When the agent needs to run a background process, it uses its internal bash-equivalent tool with shell backgrounding (`&`).

### Comparison

| Capability | Supported? | Notes |
|-----------|-----------|-------|
| Agent runs commands | Yes (internal tools) | Synchronous, blocks agent turn |
| User runs commands → agent sees output | Yes (`/session/{id}/command`) | HTTP API, first-class |
| External API for command injection | Yes | Session-scoped endpoints |
| Command source tracking | Implicit | Endpoint implies source (no enum) |
| Background process management | No | Shell `&` only for agent |
| PTY / interactive terminal | Yes (`/pty/*`) | Server-scoped, WebSocket I/O |

## Notes

- OpenCode is the most feature-rich runtime (streaming, questions, permissions)
- Server persists for the lifetime of a change (workspace+repo+change)
- Parts are streamed incrementally with delta updates
- V1 client is needed for question/permission APIs
- Working directory affects credential discovery and file operations
