# Spec: Session Persistence & Metadata

**Proposed API Changes**
- Add a persistent session store to the core session manager (pluggable backend, default on-disk).
- Expose session metadata fields in the core API: `title`, `parent_id`, `project_id`, `directory`, `version`, `share_url`, `created_at`, `updated_at`, `status`.
- Add session list/get/update/delete/fork/share/todo/diff/revert/unrevert/abort/init operations to the core API.

**Summary**
Bring the core session manager to feature parity with OpenCode’s session metadata model. Sessions must be durable, queryable, and updatable, and must remain consistent with message history and event streams.

**OpenCode Endpoints (Reference)**
- `GET /opencode/session`
- `POST /opencode/session`
- `GET /opencode/session/{sessionID}`
- `PATCH /opencode/session/{sessionID}`
- `DELETE /opencode/session/{sessionID}`
- `GET /opencode/session/status`
- `GET /opencode/session/{sessionID}/children`
- `POST /opencode/session/{sessionID}/fork`
- `POST /opencode/session/{sessionID}/share`
- `DELETE /opencode/session/{sessionID}/share`
- `GET /opencode/session/{sessionID}/todo`
- `GET /opencode/session/{sessionID}/diff`
- `POST /opencode/session/{sessionID}/revert`
- `POST /opencode/session/{sessionID}/unrevert`
- `POST /opencode/session/{sessionID}/abort`
- `POST /opencode/session/{sessionID}/init`

**Core Functionality Required**
- Persistent storage for sessions and metadata (including parent/child relationships).
- Session status tracking (idle/busy/error) with timestamps.
- Share URL lifecycle (create/revoke).
- Forking semantics that clone metadata and link parent/child.
- Revert/unrevert bookkeeping tied to VCS snapshots (see VCS spec).
- Consistent ordering and deterministic IDs across restarts.

**OpenCode Compat Wiring + Tests**
- Replace stubs for: `/session` (GET/POST), `/session/{sessionID}` (GET/PATCH/DELETE), `/session/status`, `/session/{sessionID}/children`, `/session/{sessionID}/fork`, `/session/{sessionID}/share` (POST/DELETE), `/session/{sessionID}/todo`, `/session/{sessionID}/diff`, `/session/{sessionID}/revert`, `/session/{sessionID}/unrevert`, `/session/{sessionID}/abort`, `/session/{sessionID}/init`.
- Extend opencode-compat E2E tests to verify persistence across server restarts and correct metadata updates.
