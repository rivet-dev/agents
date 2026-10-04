# Research: Process & Terminal System Design

Research on PTY/terminal and process management APIs across sandbox platforms, with design recommendations for sandbox-agent.

## Competitive Landscape

### Transport Comparison

| Platform | PTY Transport | Command Transport | Unified? |
|----------|--------------|-------------------|----------|
| **OpenCode** | WebSocket (`/pty/{id}/connect`) | REST (session-scoped, AI-mediated) | No |
| **E2B** | gRPC server-stream (output) + unary RPC (input) | Same gRPC service | Yes |
| **Daytona** | WebSocket | REST | No |
| **Kubernetes** | WebSocket (channel byte mux) | Same WebSocket | Yes |
| **Docker** | HTTP connection hijack | Same connection | Yes |
| **Fly.io** | SSH over WireGuard | REST (sync, 60s max) | No |
| **Vercel Sandboxes** | No PTY API | REST SDK (async generator for logs) | N/A |
| **Gitpod** | gRPC (Listen=output, Write=input) | Same gRPC service | Yes |

### Resize Mechanism

| Platform | How | Notes |
|----------|-----|-------|
| **OpenCode** | `PUT /pty/{id}` with `size: {rows, cols}` | Separate REST call |
| **E2B** | Separate `Update` RPC | Separate gRPC call |
| **Daytona** | Separate HTTP POST | Sends SIGWINCH |
| **Kubernetes** | In-band WebSocket message (channel byte 4) | `{"Width": N, "Height": N}` |
| **Docker** | `POST /exec/{id}/resize?h=N&w=N` | Separate REST call |
| **Gitpod** | Separate `SetSize` RPC | Separate gRPC call |

**Consensus**: Almost all platforms use a separate call for resize. Only Kubernetes does it in-band. Since resize is a control signal (not data), a separate mechanism is cleaner.

### I/O Multiplexing

I/O multiplexing is how platforms distinguish between stdout, stderr, and PTY data on a shared connection.

| Platform | Method | Detail |
|----------|--------|--------|
| **Docker** | 8-byte binary header per frame | Byte 0 = stream type (0=stdin, 1=stdout, 2=stderr). When TTY=true, no mux (raw stream). |
| **Kubernetes** | 1-byte channel prefix per WebSocket message | 0=stdin, 1=stdout, 2=stderr, 3=error, 4=resize, 255=close |
| **E2B** | gRPC `oneof` in protobuf | `DataEvent.output` is `oneof { bytes stdout, bytes stderr, bytes pty }` |
| **OpenCode** | None | PTY is a unified stream. Commands capture stdout/stderr separately in response. |
| **Daytona** | None | PTY is unified. Commands return structured `{stdout, stderr}`. |

**Key insight**: When a process runs with a PTY allocated, stdout and stderr are merged by the kernel into a single stream. Multiplexing only matters for non-PTY command execution. OpenCode and Daytona handle this by keeping PTY (unified stream) and commands (structured response) as separate APIs.

### Reconnection

| Platform | Method | Replays missed output? |
|----------|--------|----------------------|
| **E2B** | `Connect` RPC by PID or tag | No - only new events from reconnect point |
| **Daytona** | New WebSocket to same PTY session | No |
| **Kubernetes** | Not supported (connection = session) | N/A |
| **Docker** | Not supported (connection = session) | N/A |
| **OpenCode** | `GET /pty/{id}/connect` (WebSocket) | Unknown (not documented) |

### Process Identification

| Platform | ID Type | Notes |
|----------|---------|-------|
| **OpenCode** | String (`pty_N`) | Pattern `^pty.*` |
| **E2B** | PID (uint32) or tag (string) | Dual selector |
| **Daytona** | Session ID / PID | |
| **Docker** | Exec ID (string, server-generated) | |
| **Kubernetes** | Connection-scoped | No ID - the WebSocket IS the process |
| **Gitpod** | Alias (string) | Human-readable |

### Scoping

| Platform | PTY Scope | Command Scope |
|----------|-----------|---------------|
| **OpenCode** | Server-wide (global) | Session-specific (AI-mediated) |
| **E2B** | Sandbox-wide | Sandbox-wide |
| **Daytona** | Sandbox-wide | Sandbox-wide |
| **Docker** | Container-scoped | Container-scoped |
| **Kubernetes** | Pod-scoped | Pod-scoped |

## Key Questions & Analysis

### Q: Should PTY transport be WebSocket?

**Yes.** WebSocket is the right choice for PTY I/O:
- Bidirectional: client sends keystrokes, server sends terminal output
- Low latency: no HTTP request overhead per keystroke
- Persistent connection: terminal sessions are long-lived
- Industry consensus: OpenCode, Daytona, and Kubernetes all use WebSocket for PTY

### Q: Should command transport be WebSocket or REST?

**REST is sufficient for commands. WebSocket is not needed.**

The distinction comes down to the nature of each operation:

- **PTY**: Long-lived, bidirectional, interactive. User types, terminal responds. Needs WebSocket.
- **Commands**: Request-response. Client says "run `ls -la`", server runs it, returns stdout/stderr/exit_code. This is a natural REST operation.

The "full duplex" question: commands don't need full duplex because:
1. Input is sent once at invocation (the command string)
2. Output is collected and returned when the process exits
3. There's no ongoing interactive input during execution

For **streaming output** of long-running commands (e.g., `npm install`), there are two clean options:
1. **SSE**: Server-Sent Events for output streaming (output-only, which is all you need)
2. **PTY**: If the user needs to interact with the process (send ctrl+c, provide stdin), they should use a PTY instead

This matches how OpenCode separates the two: commands are REST, PTYs are WebSocket.

**Recommendation**: Keep commands as REST. If a command needs streaming output or interactive input, the user should create a PTY instead. This avoids building a second WebSocket protocol for a use case that PTYs already cover.

### Q: Should resize be WebSocket in-band or separate POST?

**Separate endpoint (PUT or POST).**

Reasons:
- Resize is a control signal, not data. Mixing it into the data stream requires a framing protocol to distinguish resize messages from terminal input.
- OpenCode already defines `PUT /pty/{id}` with `size: {rows, cols}` - this is the existing spec.
- E2B, Daytona, Docker, and Gitpod all use separate calls.
- Only Kubernetes does in-band (because their channel-byte protocol already has a mux layer).
- A separate endpoint is simpler to implement, test, and debug.

**Recommendation**: Use `PUT /pty/{id}` with `size` field (matching OpenCode spec). Alternatively, a dedicated `POST /pty/{id}/resize` if we want to keep update and resize semantically separate.

### Q: What is I/O multiplexing?

I/O multiplexing is the mechanism for distinguishing between different data streams (stdout, stderr, stdin, control signals) on a single connection.

**When it matters**: Non-PTY command execution where stdout and stderr need to be kept separate.

**When it doesn't matter**: PTY sessions. When a PTY is allocated, the kernel merges stdout and stderr into a single stream (the PTY master fd). There is only one output stream. This is why terminals show stdout and stderr interleaved - the PTY doesn't distinguish them.

**For sandbox-agent**: Since PTYs are unified streams and commands use REST (separate stdout/stderr in the JSON response), we don't need a multiplexing protocol. The API design naturally separates the two cases.

### Q: How should reconnect work?

**Reconnect is an application-level concept, not just HTTP/WebSocket reconnection.**

The distinction:

- **HTTP/WebSocket reconnect**: The transport-level connection drops and is re-established. This is handled by the client library automatically (retry logic, exponential backoff). The server doesn't need to know.
- **Process reconnect**: The client disconnects from a running process but the process keeps running. Later, the client (or a different client) connects to the same process and starts receiving output again.

**E2B's model**: Disconnecting a stream (via AbortController) leaves the process running. `Connect` RPC by PID or tag re-establishes the output stream. Missed output during disconnection is lost. This works because:
1. Processes are long-lived (servers, shells)
2. For terminals, the screen state can be recovered by the shell/application redrawing
3. For commands, if you care about all output, don't disconnect

**Recommendation for sandbox-agent**: Reconnect should be supported at the application level:
1. `GET /pty/{id}/connect` (WebSocket) can be called multiple times for the same PTY
2. If the WebSocket drops, the PTY process keeps running
3. Client reconnects by opening a new WebSocket to the same endpoint
4. No output replay (too complex, rarely needed - terminal apps redraw on reconnect via SIGWINCH)
5. This is essentially what OpenCode's `/pty/{id}/connect` endpoint already implies

This naturally leads to the **persistent process system** concept (see below).

### Q: How are PTY events different from PTY transport?

Two completely separate channels serving different purposes:

**PTY Events** (via SSE on `/event` or `/sessions/{id}/events/sse`):
- Lifecycle notifications: `pty.created`, `pty.updated`, `pty.exited`, `pty.deleted`
- Lightweight JSON metadata (PTY id, status, exit code)
- Broadcast to all subscribers
- Used by UIs to update PTY lists, show status indicators, handle cleanup

**PTY Transport** (via WebSocket on `/pty/{id}/connect`):
- Raw terminal I/O: binary input/output bytes
- High-frequency, high-bandwidth
- Point-to-point (one client connected to one PTY)
- Used by terminal emulators (xterm.js) to render the terminal

**Analogy**: Events are like email notifications ("a new terminal was opened"). Transport is like the phone call (the actual terminal session).

### Q: How are PTY and commands different in OpenCode?

They serve fundamentally different purposes:

**PTY (`/pty/*`)** - Direct execution environment:
- Server-scoped (not tied to any AI session)
- Creates a real terminal process
- User interacts directly via WebSocket
- Not part of the AI conversation
- Think: "the terminal panel in VS Code"

**Commands (`/session/{sessionID}/command`, `/session/{sessionID}/shell`)** - AI-mediated execution:
- Session-scoped (tied to an AI session)
- The command is sent **to the AI assistant** for execution
- Creates an `AssistantMessage` in the session's conversation history
- Output becomes part of the AI's context
- Think: "asking Claude to run a command as a tool call"

**Why commands are session-specific**: Because they're AI operations, not direct execution. When you call `POST /session/{id}/command`, the server:
1. Creates an assistant message in the session
2. Runs the command
3. Captures output as message parts
4. Emits `message.part.updated` events
5. The AI can see this output in subsequent turns

This is how the AI "uses terminal tools" - the command infrastructure provides the bridge between the AI session and system execution.

### Q: Should scoping be system-wide?

**Yes, for both PTY and commands.**

Current OpenCode behavior:
- PTYs: Already server-wide (global)
- Commands: Session-scoped (for AI context injection)

**For sandbox-agent**, since we're the orchestration layer (not the AI):
- **PTYs**: System-wide. Any client should be able to list, connect to, or manage any PTY.
- **Commands/processes**: System-wide. Process execution is a system primitive, not an AI primitive. If a caller wants to associate a process with a session, they can do so at their layer.

The session-scoping of commands in OpenCode is an OpenCode-specific concern (AI context injection). Sandbox-agent should provide the lower-level primitive (system-wide process execution) and let the OpenCode compat layer handle the session association.

## Persistent Process System

### The Concept

A persistent process system means:
1. **Spawn** a process (PTY or command) via API
2. Process runs independently of any client connection
3. **Connect/disconnect** to the process I/O at will
4. Process continues running through disconnections
5. **Query** process status, list running processes
6. **Kill/signal** processes explicitly

This is distinct from the typical "connection = process lifetime" model (Kubernetes, Docker exec) where closing the connection kills the process.

### How E2B Does It

E2B's `Process` service is the best reference implementation:

```
Start(cmd, pty?) → stream of events (output)
Connect(pid/tag) → stream of events (reconnect)
SendInput(pid, data) → ok
Update(pid, size) → ok (resize)
SendSignal(pid, signal) → ok
List() → running processes
```

Key design choices:
- **Unified service**: PTY and command are the same service, differentiated by the `pty` field in `StartRequest`
- **Process outlives connection**: Disconnecting the output stream (aborting the `Start`/`Connect` RPC) does NOT kill the process
- **Explicit termination**: Must call `SendSignal(SIGKILL)` to stop a process
- **Tag-based selection**: Processes can be tagged at creation for later lookup without knowing the PID

### Recommendation for Sandbox-Agent

Sandbox-agent should implement a **persistent process manager** that:

1. **Is system-wide** (not session-scoped)
2. **Supports both PTY and non-PTY modes**
3. **Decouples process lifetime from connection lifetime**
4. **Exposes via both REST (lifecycle) and WebSocket (I/O)**

#### Proposed API Surface

**Process Lifecycle (REST)**:
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/processes` | Create/spawn a process (PTY or command) |
| `GET` | `/v1/processes` | List all processes |
| `GET` | `/v1/processes/{id}` | Get process info (status, pid, exit code) |
| `DELETE` | `/v1/processes/{id}` | Kill process (SIGTERM, then SIGKILL) |
| `POST` | `/v1/processes/{id}/signal` | Send signal (SIGTERM, SIGKILL, SIGINT, etc.) |
| `POST` | `/v1/processes/{id}/resize` | Resize PTY (rows, cols) |
| `POST` | `/v1/processes/{id}/input` | Send stdin/pty input (REST fallback) |

**Process I/O (WebSocket)**:
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/processes/{id}/connect` | WebSocket for bidirectional I/O |

**Process Events (SSE)**:
| Event | Description |
|-------|-------------|
| `process.created` | Process spawned |
| `process.updated` | Process metadata changed |
| `process.exited` | Process terminated (includes exit code) |
| `process.deleted` | Process record removed |

#### Create Request

```json
{
  "command": "bash",
  "args": ["-i", "-l"],
  "cwd": "/workspace",
  "env": {"TERM": "xterm-256color"},
  "pty": {                         // Optional - if present, allocate PTY
    "rows": 24,
    "cols": 80
  },
  "tag": "main-terminal",          // Optional - for lookup by name
  "label": "Terminal 1"            // Optional - display name
}
```

#### Process Object

```json
{
  "id": "proc_abc123",
  "tag": "main-terminal",
  "label": "Terminal 1",
  "command": "bash",
  "args": ["-i", "-l"],
  "cwd": "/workspace",
  "pid": 12345,
  "pty": true,
  "status": "running",             // "running" | "exited"
  "exit_code": null,               // Set when exited
  "created_at": "2025-01-15T...",
  "exited_at": null
}
```

#### OpenCode Compatibility Layer

The OpenCode compat layer maps to this system:

| OpenCode Endpoint | Maps To |
|-------------------|---------|
| `POST /pty` | `POST /v1/processes` (with `pty` field) |
| `GET /pty` | `GET /v1/processes?pty=true` |
| `GET /pty/{id}` | `GET /v1/processes/{id}` |
| `PUT /pty/{id}` | `POST /v1/processes/{id}/resize` + metadata update |
| `DELETE /pty/{id}` | `DELETE /v1/processes/{id}` |
| `GET /pty/{id}/connect` | `GET /v1/processes/{id}/connect` |
| `POST /session/{id}/command` | Create process + capture output into session |
| `POST /session/{id}/shell` | Create process (shell mode) + capture output into session |

### Open Questions

1. **Output buffering for reconnect**: Should we buffer recent output (e.g., last 64KB) so reconnecting clients get some history? E2B doesn't do this, but it would improve UX for flaky connections.

2. **Process limits**: Should there be a max number of concurrent processes? E2B doesn't expose one, but sandbox environments have limited resources.

3. **Auto-cleanup**: Should processes be auto-cleaned after exiting? Options:
   - Keep forever until explicitly deleted
   - Auto-delete after N seconds/minutes
   - Keep metadata but release resources

4. **Input via REST vs WebSocket-only**: The REST `POST /processes/{id}/input` endpoint is useful for one-shot input (e.g., "send ctrl+c") without establishing a WebSocket. E2B has both `SendInput` (unary) and `StreamInput` (streaming) for this reason.

5. **Multiple WebSocket connections to same process**: Should we allow multiple clients to connect to the same process simultaneously? (Pair programming, monitoring). E2B supports this via multiple `Connect` calls.

## User-Initiated Command Injection ("Run command, give AI context")

A common pattern across agents: the user (or frontend) runs a command and the output is injected into the AI's conversation context. This is distinct from the agent running a command via its own tools.

| Agent | Feature | Mechanism | Protocol-level? |
|-------|---------|-----------|----------------|
| **Claude Code** | `!command` prefix in TUI | CLI runs command locally, injects output as user message | No - client-side hack, not in API schema |
| **Codex** | `user_shell` source | `ExecCommandSource` enum distinguishes `agent` vs `user_shell` vs `unified_exec_*` | Yes - first-class protocol event |
| **OpenCode** | `/session/{id}/command` | HTTP endpoint runs command, records result as `AssistantMessage` | Yes - HTTP API |
| **Amp** | N/A | Not supported | N/A |

**Design implication for sandbox-agent**: The process system should support an optional `session_id` field when creating a process. If provided, the process output is associated with that session so the agent can see it. If not provided, the process runs independently (like a PTY). This unifies:
- User interactive terminals (no session association)
- User-initiated commands for AI context (session association)
- Agent-initiated background processes (session association)

## Sources

- [E2B Process Proto](https://github.com/e2b-dev/E2B) - `process.proto` gRPC service definition
- [E2B JS SDK](https://github.com/e2b-dev/E2B/tree/main/packages/js-sdk) - `commands/pty.ts`, `commands/index.ts`
- [Daytona SDK](https://www.daytona.io/docs/en/typescript-sdk/process/) - REST + WebSocket PTY API
- [Kubernetes RemoteCommand](https://github.com/kubernetes/apimachinery/blob/master/pkg/util/remotecommand/constants.go) - WebSocket subprotocol
- [Docker Engine API](https://docker-docs.uclv.cu/engine/api/v1.21/) - Exec API with stream multiplexing
- [Fly.io Machines API](https://fly.io/docs/machines/api/) - REST exec with 60s limit
- [Gitpod terminal.proto](https://codeberg.org/kanishka-reading-list/gitpod/src/branch/main/components/supervisor-api/terminal.proto) - gRPC terminal service
- [OpenCode OpenAPI Spec](https://github.com/opencode-ai/opencode) - PTY and session command endpoints
