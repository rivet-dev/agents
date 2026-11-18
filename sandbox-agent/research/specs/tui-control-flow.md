# Spec: TUI Control Flow

**Proposed API Changes**
- Add a TUI control queue and state machine to the core session manager.
- Expose request/response transport for OpenCode TUI controls.

**Summary**
OpenCode’s TUI endpoints allow a remote controller to drive the UI. We need a server-side queue for control messages and a way to emit responses.

**OpenCode Endpoints (Reference)**
- `GET /opencode/tui/control/next`
- `POST /opencode/tui/control/response`
- `POST /opencode/tui/append-prompt`
- `POST /opencode/tui/clear-prompt`
- `POST /opencode/tui/execute-command`
- `POST /opencode/tui/open-help`
- `POST /opencode/tui/open-models`
- `POST /opencode/tui/open-sessions`
- `POST /opencode/tui/open-themes`
- `POST /opencode/tui/publish`
- `POST /opencode/tui/select-session`
- `POST /opencode/tui/show-toast`
- `POST /opencode/tui/submit-prompt`

**Core Functionality Required**
- Persistent queue of pending UI control actions.
- Response correlation (request/response IDs).
- Optional integration with session events for UI feedback.

**OpenCode Compat Wiring + Tests**
- Replace stubs for all `/tui/*` endpoints.
- Add E2E tests for control queue ordering and response handling.
