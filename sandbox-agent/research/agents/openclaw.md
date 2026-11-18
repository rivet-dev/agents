# OpenClaw (formerly Clawdbot) Research

Research notes on OpenClaw's architecture, API, and automation patterns for integration with sandbox-agent.

## Overview

- **Provider**: Multi-provider (Anthropic, OpenAI, etc. via Pi agent)
- **Execution Method**: WebSocket Gateway + HTTP APIs
- **Session Persistence**: Session Key (string) + Session ID (UUID)
- **SDK**: No official SDK - uses WebSocket/HTTP protocol directly
- **Binary**: `clawdbot` (npm global install or local)
- **Default Port**: 18789 (WebSocket + HTTP multiplex)

## Architecture

OpenClaw is architected differently from other coding agents (Claude Code, Codex, OpenCode, Amp):

```
┌─────────────────────────────────────┐
│           Gateway Service           │  ws://127.0.0.1:18789
│      (long-running daemon)          │  http://127.0.0.1:18789
│                                     │
│  ┌─────────────────────────────┐    │
│  │ Pi Agent (embedded RPC)     │    │
│  │ - Tool execution            │    │
│  │ - Model routing             │    │
│  │ - Session management        │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
         │
         ├── WebSocket (full control plane)
         ├── HTTP /v1/chat/completions (OpenAI-compatible)
         ├── HTTP /v1/responses (OpenResponses-compatible)
         ├── HTTP /tools/invoke (single tool invocation)
         └── HTTP /hooks/agent (webhook triggers)
```

**Key Difference**: OpenClaw runs as a **daemon** that owns the agent runtime. Other agents (Claude, Codex, Amp) spawn a subprocess per turn. OpenClaw is more similar to OpenCode's server model but with a persistent gateway.

## Automation Methods (Priority Order)

### 1. WebSocket Gateway Protocol (Recommended)

Full-featured bidirectional control with streaming events.

#### Connection Handshake

```typescript
// Connect to Gateway
const ws = new WebSocket("ws://127.0.0.1:18789");

// First frame MUST be connect request
ws.send(JSON.stringify({
  type: "req",
  id: "1",
  method: "connect",
  params: {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "gateway-client",  // or custom client id
      version: "1.0.0",
      platform: "linux",
      mode: "backend"
    },
    role: "operator",
    scopes: ["operator.admin"],
    caps: [],
    auth: { token: "YOUR_GATEWAY_TOKEN" }
  }
}));

// Expect hello-ok response
// { type: "res", id: "1", ok: true, payload: { type: "hello-ok", ... } }
```

#### Agent Request

```typescript
// Send agent turn request
const runId = crypto.randomUUID();
ws.send(JSON.stringify({
  type: "req",
  id: runId,
  method: "agent",
  params: {
    message: "Your prompt here",
    idempotencyKey: runId,
    sessionKey: "agent:main:main",  // or custom session key
    thinking: "low",  // optional: low|medium|high
    deliver: false,   // don't send to messaging channel
    timeout: 300000   // 5 minute timeout
  }
}));
```

#### Response Flow (Two-Stage)

```typescript
// Stage 1: Immediate ack
// { type: "res", id: "...", ok: true, payload: { runId, status: "accepted", acceptedAt: 1234567890 } }

// Stage 2: Streaming events
// { type: "event", event: "agent", payload: { runId, seq: 1, stream: "output", data: {...} } }
// { type: "event", event: "agent", payload: { runId, seq: 2, stream: "tool", data: {...} } }
// ...

// Stage 3: Final response (same id as request)
// { type: "res", id: "...", ok: true, payload: { runId, status: "ok", summary: "completed", result: {...} } }
```

### 2. OpenAI-Compatible HTTP API

For simple integration with tools expecting OpenAI Chat Completions.

**Enable in config:**
```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true }
      }
    }
  }
}
```

**Request:**
```bash
curl -X POST http://127.0.0.1:18789/v1/chat/completions \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "clawdbot:main",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

**Model Format:**
- `model: "clawdbot:<agentId>"` (e.g., `"clawdbot:main"`)
- `model: "agent:<agentId>"` (alias)

### 3. OpenResponses HTTP API

For clients that speak OpenResponses (item-based input, function tools).

**Enable in config:**
```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true }
      }
    }
  }
}
```

**Request:**
```bash
curl -X POST http://127.0.0.1:18789/v1/responses \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "clawdbot:main",
    "input": "Hello",
    "stream": true
  }'
```

### 4. Webhooks (Fire-and-Forget)

For event-driven automation without maintaining a connection.

**Enable in config:**
```json5
{
  hooks: {
    enabled: true,
    token: "webhook-secret",
    path: "/hooks"
  }
}
```

**Request:**
```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H "Authorization: Bearer webhook-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Run this task",
    "name": "Automation",
    "sessionKey": "hook:automation:task-123",
    "deliver": false,
    "timeoutSeconds": 120
  }'
```

**Response:** `202 Accepted` (async run started)

### 5. CLI Subprocess

For simple one-off automation (similar to Claude Code pattern).

```bash
clawdbot agent --message "Your prompt" --session-key "automation:task"
```

## Session Management

### Session Key Format

```
agent:<agentId>:<sessionType>
agent:main:main          # Main agent, main session
agent:main:subagent:abc  # Subagent session
agent:beta:main          # Beta agent, main session
hook:email:msg-123       # Webhook-spawned session
global                   # Legacy global session
```

### Session Operations (WebSocket)

```typescript
// List sessions
{ type: "req", id: "...", method: "sessions.list", params: { limit: 50, activeMinutes: 120 } }

// Resolve session info
{ type: "req", id: "...", method: "sessions.resolve", params: { key: "agent:main:main" } }

// Patch session settings
{ type: "req", id: "...", method: "sessions.patch", params: {
  key: "agent:main:main",
  thinkingLevel: "medium",
  model: "anthropic/claude-sonnet-4-20250514"
}}

// Reset session (clear history)
{ type: "req", id: "...", method: "sessions.reset", params: { key: "agent:main:main" } }

// Delete session
{ type: "req", id: "...", method: "sessions.delete", params: { key: "agent:main:main" } }

// Compact session (summarize history)
{ type: "req", id: "...", method: "sessions.compact", params: { key: "agent:main:main" } }
```

### Session CLI

```bash
clawdbot sessions                    # List sessions
clawdbot sessions --active 120       # Active in last 2 hours
clawdbot sessions --json             # JSON output
```

## Streaming Events

### Event Format

```typescript
interface AgentEvent {
  runId: string;       // Correlates to request
  seq: number;         // Monotonically increasing per run
  stream: string;      // Event category
  ts: number;          // Unix timestamp (ms)
  data: Record<string, unknown>;  // Event-specific payload
}
```

### Stream Types

| Stream | Description |
|--------|-------------|
| `output` | Text output chunks |
| `tool` | Tool invocation/result |
| `thinking` | Extended thinking content |
| `status` | Run status changes |
| `error` | Error information |

### Event Categories

| Event Type | Payload |
|------------|---------|
| `assistant.delta` | `{ text: "..." }` |
| `tool.start` | `{ name: "Read", input: {...} }` |
| `tool.result` | `{ name: "Read", result: "..." }` |
| `thinking.delta` | `{ text: "..." }` |
| `run.complete` | `{ summary: "..." }` |
| `run.error` | `{ error: "..." }` |

## Token Usage / Cost Tracking

OpenClaw tracks tokens per response and supports cost estimation.

### In-Chat Commands

```
/status              # Session model, context usage, last response tokens, estimated cost
/usage off|tokens|full  # Toggle per-response usage footer
/usage cost          # Local cost summary from session logs
```

### Configuration

Token costs are configured per model:
```json5
{
  models: {
    providers: {
      anthropic: {
        models: [{
          id: "claude-sonnet-4-20250514",
          cost: {
            input: 3.00,       // USD per 1M tokens
            output: 15.00,
            cacheRead: 0.30,
            cacheWrite: 3.75
          }
        }]
      }
    }
  }
}
```

### Programmatic Access

Token usage is included in agent response payloads:
```typescript
// In final response or streaming events
{
  usage: {
    inputTokens: 1234,
    outputTokens: 567,
    cacheReadTokens: 890,
    cacheWriteTokens: 123
  }
}
```

## Authentication

### Gateway Token

```bash
# Environment variable
CLAWDBOT_GATEWAY_TOKEN=your-secret-token

# Or config file
{
  gateway: {
    auth: {
      mode: "token",
      token: "your-secret-token"
    }
  }
}
```

### HTTP Requests

```
Authorization: Bearer YOUR_TOKEN
```

### WebSocket Connect

```typescript
{
  params: {
    auth: { token: "YOUR_TOKEN" }
  }
}
```

## Status Sync

### Health Check

```typescript
// WebSocket
{ type: "req", id: "...", method: "health", params: {} }

// HTTP
curl http://127.0.0.1:18789/health  # Basic health
clawdbot health --json              # Detailed health
```

### Status Response

```typescript
{
  ok: boolean;
  linkedChannel?: string;
  models?: { available: string[] };
  agents?: { configured: string[] };
  presence?: PresenceEntry[];
  uptimeMs?: number;
}
```

### Presence Events

The gateway pushes presence updates to all connected clients:
```typescript
// Event
{ type: "event", event: "presence", payload: { entries: [...], stateVersion: {...} } }
```

## Comparison with Other Agents

| Aspect | OpenClaw | Claude Code | Codex | OpenCode | Amp |
|--------|----------|-------------|-------|----------|-----|
| **Process Model** | Daemon | Subprocess | Server | Server | Subprocess |
| **Protocol** | WebSocket + HTTP | CLI JSONL | JSON-RPC stdio | HTTP + SSE | CLI JSONL |
| **Session Resume** | Session Key | `--resume` | Thread ID | Session ID | `--continue` |
| **Multi-Turn** | Same session key | Same session ID | Same thread | Same session | Same session |
| **Streaming** | WS events + SSE | JSONL | Notifications | SSE | JSONL |
| **HITL** | No | No (headless) | No (SDK) | Yes (SSE) | No |
| **SDK** | None (protocol) | None (CLI) | Yes | Yes | Closed |

### Key Differences

1. **Daemon Model**: OpenClaw runs as a persistent gateway service, not a per-turn subprocess
2. **Multi-Protocol**: Supports WebSocket, OpenAI-compatible HTTP, OpenResponses, and webhooks
3. **Channel Integration**: Built-in WhatsApp/Telegram/Discord/iMessage support
4. **Node System**: Mobile/desktop nodes can connect for camera, canvas, location, etc.
5. **No HITL**: Like Claude/Codex/Amp, permissions are configured upfront, not interactive

## Integration Patterns for sandbox-agent

### Recommended: Persistent WebSocket Connection

```typescript
class OpenClawDriver {
  private ws: WebSocket;
  private pending = new Map<string, { resolve, reject }>();
  
  async connect(url: string, token: string) {
    this.ws = new WebSocket(url);
    await this.handshake(token);
    this.ws.on("message", (data) => this.handleMessage(JSON.parse(data)));
  }
  
  async runAgent(params: {
    message: string;
    sessionKey?: string;
    thinking?: string;
  }): Promise<AgentResult> {
    const runId = crypto.randomUUID();
    const events: AgentEvent[] = [];
    
    return new Promise((resolve, reject) => {
      this.pending.set(runId, { resolve, reject, events });
      this.ws.send(JSON.stringify({
        type: "req",
        id: runId,
        method: "agent",
        params: {
          message: params.message,
          sessionKey: params.sessionKey ?? "agent:main:main",
          thinking: params.thinking,
          deliver: false,
          idempotencyKey: runId
        }
      }));
    });
  }
  
  private handleMessage(frame: GatewayFrame) {
    if (frame.type === "event" && frame.event === "agent") {
      const pending = this.pending.get(frame.payload.runId);
      if (pending) pending.events.push(frame.payload);
    } else if (frame.type === "res") {
      const pending = this.pending.get(frame.id);
      if (pending && frame.payload?.status === "ok") {
        pending.resolve({ result: frame.payload, events: pending.events });
        this.pending.delete(frame.id);
      } else if (pending && frame.payload?.status === "error") {
        pending.reject(new Error(frame.payload.summary));
        this.pending.delete(frame.id);
      }
      // Ignore "accepted" acks
    }
  }
}
```

### Alternative: HTTP API (Simpler)

```typescript
async function runOpenClawPrompt(prompt: string, sessionKey?: string) {
  const response = await fetch("http://127.0.0.1:18789/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.CLAWDBOT_GATEWAY_TOKEN}`,
      "Content-Type": "application/json",
      "x-clawdbot-session-key": sessionKey ?? "automation:sandbox"
    },
    body: JSON.stringify({
      model: "clawdbot:main",
      messages: [{ role: "user", content: prompt }],
      stream: false
    })
  });
  return response.json();
}
```

## Configuration for sandbox-agent Integration

Recommended config for automated use:

```json5
{
  gateway: {
    port: 18789,
    auth: {
      mode: "token",
      token: "${CLAWDBOT_GATEWAY_TOKEN}"
    },
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
        responses: { enabled: true }
      }
    }
  },
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-20250514"
      },
      thinking: { level: "low" },
      workspace: "${HOME}/workspace"
    }
  }
}
```

## Notes

- OpenClaw is significantly more complex than other agents due to its gateway architecture
- The multi-protocol support (WS, OpenAI, OpenResponses, webhooks) provides flexibility
- Session management is richer (labels, spawn tracking, model/thinking overrides)
- No SDK means direct protocol implementation is required
- The daemon model means connection lifecycle management is important (reconnects, etc.)
- Agent responses are two-stage: immediate ack + final result (handle both)
- Tool policy filtering is configurable per agent/session/group
