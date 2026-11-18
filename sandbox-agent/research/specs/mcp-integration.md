# Spec: MCP Integration

**Proposed API Changes**
- Add an MCP server registry to the core session manager.
- Support MCP auth lifecycle and connect/disconnect operations.
- Expose tool discovery metadata for OpenCode tooling.

**Summary**
OpenCode expects MCP server registration, authentication, and connectivity endpoints, plus tool discovery for those servers.

**OpenCode Endpoints (Reference)**
- `GET /opencode/mcp`
- `POST /opencode/mcp`
- `POST /opencode/mcp/{name}/auth`
- `DELETE /opencode/mcp/{name}/auth`
- `POST /opencode/mcp/{name}/auth/callback`
- `POST /opencode/mcp/{name}/auth/authenticate`
- `POST /opencode/mcp/{name}/connect`
- `POST /opencode/mcp/{name}/disconnect`
- `GET /opencode/experimental/tool`
- `GET /opencode/experimental/tool/ids`

**Core Functionality Required**
- Register MCP servers with config (url, transport, auth type).
- Auth flows (token exchange, callback handling).
- Connect/disconnect lifecycle and health.
- Tool listing and tool ID exposure for connected servers.

**OpenCode Compat Wiring + Tests**
- Replace stubs for `/mcp*` and `/experimental/tool*`.
- Add E2E tests using a real MCP test server to validate auth + tool list flows.
