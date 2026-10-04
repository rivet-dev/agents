# Spec: Command + Shell Execution

**Proposed API Changes**
- Add command execution APIs to the core session manager (non-PTY, single-shot).
- Define output capture and error handling semantics in the session event stream.

**Summary**
OpenCode routes for command/shell execution should run real commands in the session context and stream outputs to OpenCode message parts and events.

**OpenCode Endpoints (Reference)**
- `GET /opencode/command`
- `POST /opencode/session/{sessionID}/command`
- `POST /opencode/session/{sessionID}/shell`

**Core Functionality Required**
- Execute commands with cwd/env + timeout support.
- Capture stdout/stderr, exit code, and duration.
- Optional streaming output to session events.
- Map command output into OpenCode `message.part.updated` events.

**OpenCode Compat Wiring + Tests**
- Replace stubs for `/command`, `/session/{sessionID}/command`, `/session/{sessionID}/shell`.
- Add E2E tests to run a simple command and validate output is returned and events are emitted.
