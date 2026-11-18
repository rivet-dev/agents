# OpenCode Compatibility Tests

These tests verify that sandbox-agent exposes OpenCode-compatible API endpoints under `/opencode` and that they are usable with the official [`@opencode-ai/sdk`](https://www.npmjs.com/package/@opencode-ai/sdk) TypeScript SDK.

## Purpose

The goal is to enable sandbox-agent to be used as a drop-in replacement for OpenCode's server, allowing tools and integrations built for OpenCode to work seamlessly with sandbox-agent.

## Test Coverage

The tests cover the following OpenCode API surfaces:

### Session Management (`session.test.ts`)
- `POST /session` - Create a new session
- `GET /session` - List all sessions
- `GET /session/{id}` - Get session details
- `PATCH /session/{id}` - Update session properties
- `DELETE /session/{id}` - Delete a session

### Messaging (`messaging.test.ts`)
- `POST /session/{id}/message` - Send a prompt to the session
- `POST /session/{id}/prompt_async` - Send async prompt
- `GET /session/{id}/message` - List messages
- `GET /session/{id}/message/{messageID}` - Get specific message
- `POST /session/{id}/abort` - Abort session

### Event Streaming (`events.test.ts`)
- `GET /event` - Subscribe to all events (SSE)
- `GET /global/event` - Subscribe to global events (SSE)
- `GET /session/status` - Get session status

### Permissions (`permissions.test.ts`)
- `POST /session/{id}/permissions/{permissionID}` - Respond to permission request

### OpenAPI Coverage (Rust)
- `cargo test -p sandbox-agent --test opencode_openapi`
- Compares the Utoipa-generated OpenCode spec against `resources/agent-schemas/artifacts/openapi/opencode.json`

## Running Tests

```bash
# From this directory
pnpm test

# Or from the workspace root
pnpm --filter @sandbox-agent/opencode-compat-tests test
```

## Prerequisites

1. Build the sandbox-agent binary:
   ```bash
   cargo build -p sandbox-agent
   ```

2. Or set `SANDBOX_AGENT_BIN` environment variable to point to a pre-built binary.

## Test Approach

Each test:
1. Spawns a fresh sandbox-agent instance on a unique port
2. Uses `createOpencodeClient` from `@opencode-ai/sdk` to connect
3. Tests the OpenCode-compatible endpoints
4. Cleans up the server instance

This ensures tests are isolated and can run in parallel.

## Current Status

These tests validate the `/opencode` compatibility layer and should pass when the endpoints are mounted and responding with OpenCode-compatible shapes.

## Implementation Notes

To make sandbox-agent OpenCode-compatible, the following needs to be implemented:

1. **OpenCode API Routes** - Exposed under `/opencode`
2. **Request/Response Mapping** - OpenCode response shapes with stubbed data where needed
3. **SSE Event Streaming** - OpenCode event format for SSE
4. **Permission Handling** - Accepts OpenCode permission replies

See the OpenCode SDK types at `/home/nathan/misc/opencode/packages/sdk/js/src/gen/types.gen.ts` for the expected API shapes.
