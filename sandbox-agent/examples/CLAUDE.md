# Examples Instructions

## Docker Isolation

- Docker examples must behave like standalone sandboxes.
- Do not bind mount host files or host directories into Docker example containers.
- If an example needs tools, skills, or MCP servers, install them inside the container during setup.

## Testing Examples (ACP v2)

Examples should be validated against v2 endpoints:

1. Start the example: `SANDBOX_AGENT_DEV=1 pnpm start`
2. Create an ACP client by POSTing `initialize` to `/v2/rpc` with `x-acp-agent: mock` (or another installed agent).
3. Capture `x-acp-connection-id` from the response headers.
4. Open SSE stream: `GET /v2/rpc` with `x-acp-connection-id`.
5. Send `session/new` then `session/prompt` via `POST /v2/rpc` with the same connection id.
6. Close connection via `DELETE /v2/rpc` with `x-acp-connection-id`.

v1 reminder:

- `/v1/*` is removed and returns `410 Gone`.
