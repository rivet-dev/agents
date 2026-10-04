# Cloudflare Sandbox Agent Example

Deploy sandbox-agent inside a Cloudflare Sandbox.

## Prerequisites

- Cloudflare account with Workers Paid plan
- Docker running locally for `wrangler dev`
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for the coding agents

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Create `.dev.vars` with your API keys:

```bash
echo "ANTHROPIC_API_KEY=your-api-key" > .dev.vars
```

## Development

Start the development server:

```bash
pnpm run dev
```

Test the endpoint:

```bash
curl http://localhost:8787
```

Test prompt routing through the SDK with a custom sandbox fetch handler:

```bash
curl -N -X POST "http://localhost:8787/sandbox/demo/prompt" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"agent":"codex","prompt":"Reply with one short sentence."}'
```

The response is an SSE stream with events:
- `session.created`
- `session.event`
- `prompt.completed`
- `done`

### Troubleshooting: only two events

If you only see:
- outbound `session/prompt`
- inbound prompt result with `stopReason: "end_turn"`

then ACP `session/update` notifications are not flowing. In Cloudflare sandbox paths this can happen if you forward `AbortSignal` from SDK fetch init into `containerFetch(...)` for long-lived ACP SSE requests.

Use:

```ts
const sdk = await SandboxAgent.connect({
  fetch: (input, init) =>
    sandbox.containerFetch(
      input as Request | string | URL,
      {
        ...(init ?? {}),
        // Avoid passing AbortSignal through containerFetch; it can drop ACP SSE updates.
        signal: undefined,
      },
      PORT,
    ),
});
```

Without `session/update` events, assistant text/tool deltas will not appear in UI streams.

## Deploy

```bash
pnpm run deploy
```

Note: Production preview URLs require a custom domain with wildcard DNS routing.
See [Cloudflare Production Deployment](https://developers.cloudflare.com/sandbox/guides/production-deployment/) for details.
