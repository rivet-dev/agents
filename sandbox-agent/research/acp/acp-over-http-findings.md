# ACP Over HTTP Findings (From Zulip Thread)

Date researched: 2026-02-10  
Thread: https://agentclientprotocol.zulipchat.com/#narrow/channel/543465-general/topic/ACP.20over.20HTTP/with/571476775

## Scope

This documents what people are actively piloting for ACP over HTTP and adjacent transports, based on the thread above (23 messages from 2026-01-09 to 2026-02-02).

## Key findings from the thread

1. There is no single settled transport yet; both Streamable HTTP and WebSocket are being actively piloted.
2. A repeated concern is that ACP is more bidirectional than MCP, which makes HTTP request/response modeling trickier (especially permission requests and other server-initiated requests).
3. MCP-style transport conventions are a strong reference point even when payloads remain ACP JSON-RPC.
4. WebSocket pilots report low protocol adaptation cost from stdio-style ACP wiring.
5. Streamable HTTP pilots are moving quickly and are considered important for ecosystem compatibility (existing HTTP infra, proxies, gateways, and remote-session resume UX).

## Concrete implementation patterns observed

## 1) Streamable HTTP profile (Goose)

Reference:
- https://github.com/block/goose/pull/6741
- https://github.com/block/goose/commit/274f6e3d7ed168ca8aa68c8683308086e01c88e6
- https://github.com/block/goose/commit/54aff56c4662c14db79c34c057e991512fb6dcaf

Observed shape:
- `POST /acp` for JSON-RPC input.
- `GET /acp` optional long-lived SSE stream.
- `DELETE /acp` to terminate session.
- `Acp-Session-Id` header for connection/session binding.
- `initialize` creates session + returns session header.
- JSON-RPC request handled via SSE response stream.
- JSON-RPC notifications/responses accepted with `202`.

Why it matters:
- Very close to MCP Streamable HTTP request patterns while keeping ACP payloads.
- Matches your goal to stay close to HTTP conventions already familiar to integrators.

## 2) WebSocket-first profile (JetBrains prototype, Agmente, others)

Thread references:
- JetBrains prototype (Anna Zhdan): WebSocket worked naturally with few ACP protocol changes.
- Agmente called out as using WebSockets for ACP.
- Other teams reportedly piloting WebSockets for technical reasons.

Observed shape:
- Single full-duplex socket carrying ACP JSON-RPC envelopes.
- Simpler server-initiated requests and interleaving of notifications/responses.
- Easier fanout/multiplexing (one report: `acp -> EventEmitter -> websocket`).

Why it matters:
- Lower complexity for bidirectional ACP semantics.
- But less aligned with strict HTTP-only environments without additional gatewaying.

## Recommended options for our v1

## Option A (recommended): Streamable HTTP as canonical v1 transport

Implement ACP over:
- `POST /v1/rpc`
- `GET /v1/rpc` (SSE, optional but recommended)
- `DELETE /v1/rpc`

Profile:
- Keep JSON-RPC payloads pure ACP.
- Use `X-ACP-Connection-Id` (or `Acp-Session-Id`) for connection identity.
- `initialize` without connection header creates agent process-backed connection.
- JSON-RPC requests stream responses/events over SSE.
- Notifications and JSON-RPC responses return `202 Accepted`.

Pros:
- Best alignment with your stated direction ("same as ACP, over HTTP").
- Integrates well with existing HTTP auth/proxy/gateway infrastructure.
- Closer to MCP-style operational patterns teams already understand.

Cons:
- More complex than WebSocket for bidirectional interleaving and timeout behavior.

## Option B: WebSocket as canonical transport + HTTP compatibility facade

Implement ACP internally over WebSocket semantics, then expose an HTTP facade for clients that require HTTP.

Pros:
- Cleaner full-duplex behavior for ACP’s bidirectional model.
- Potentially simpler core runtime behavior.

Cons:
- Less direct fit to your immediate "ACP over HTTP v1 API" objective.
- Requires and maintains a translation layer from day one.

## Recommendation

Choose Option A for v1 launch and keep Option B as a later optimization path if operational pain appears.

Rationale:
- It matches current product direction.
- It aligns with concrete ecosystem work already visible (Goose Streamable HTTP).
- It can still preserve a future WebSocket backend if needed later, without changing v1 public semantics.
