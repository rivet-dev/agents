# Spec: Tool Calls + File Actions (Session Manager)

**Proposed API Changes**
- Add tool call lifecycle tracking in the core session manager (call started, delta, completed, result).
- Add file action integration (write/patch/rename/delete) with audited events.

**Summary**
OpenCode expects tool calls and file actions to surface through message parts and events. The core session manager must track tool call lifecycles and file actions reliably.

**OpenCode Endpoints (Reference)**
- `GET /opencode/event`
- `GET /opencode/global/event`
- `POST /opencode/session/{sessionID}/message`

**Core Functionality Required**
- Explicit tool call tracking with call IDs, arguments, outputs, timing, and status.
- File action execution (write/patch/rename/delete) with safe path scoping.
- Emission of file edit events tied to actual writes.
- Mapping tool call and file action data into universal events for conversion.

**OpenCode Compat Wiring + Tests**
- Replace stubbed tool/file part generation with real data sourced from session manager tool/file APIs.
- Add E2E tests to validate tool call lifecycle events and file edit events.
