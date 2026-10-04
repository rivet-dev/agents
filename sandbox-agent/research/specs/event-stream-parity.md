# Spec: Event Stream Parity

**Proposed API Changes**
- Ensure all core session manager events map to OpenCode’s expected event types and sequencing.
- Provide structured, ordered event delivery with backpressure handling.

**Summary**
OpenCode relies on SSE event streams for UI state. We need full parity in event ordering, types, and payloads, not just message/part events.

**OpenCode Endpoints (Reference)**
- `GET /opencode/event`
- `GET /opencode/global/event`

**Core Functionality Required**
- Deterministic event ordering and replay by offset.
- Explicit `session.status` transitions (busy/idle/error).
- `message.updated` and `message.part.updated` with full payloads.
- Permission and question events with full metadata.
- Error events with structured details.

**OpenCode Compat Wiring + Tests**
- Replace partial event emission with full parity for all supported events.
- Add E2E tests that validate event ordering and type coverage in SSE streams.
