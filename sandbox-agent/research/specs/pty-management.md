# Spec: PTY Management

**Proposed API Changes**
- Add a PTY manager to the core session manager to spawn, track, and stream terminal processes.
- Define a PTY IO channel for OpenCode connect operations (SSE or websocket).

**Summary**
OpenCode expects a PTY lifecycle API with live IO. We need real PTY creation and streaming output/input handling.

**OpenCode Endpoints (Reference)**
- `GET /opencode/pty`
- `POST /opencode/pty`
- `GET /opencode/pty/{ptyID}`
- `PUT /opencode/pty/{ptyID}`
- `DELETE /opencode/pty/{ptyID}`
- `GET /opencode/pty/{ptyID}/connect`

**Core Functionality Required**
- Spawn PTY processes with configurable cwd/args/title/env.
- Track PTY state (running/exited), pid, exit code.
- Streaming output channel with backpressure handling.
- Input write support with safe buffering.
- Cleanup on session termination.

**OpenCode Compat Wiring + Tests**
- Replace stubs for `/pty` and `/pty/{ptyID}` endpoints.
- Implement `/pty/{ptyID}/connect` streaming with real PTY IO.
- Add E2E tests for PTY spawn, output capture, and input echo.
