# Spec: VCS Integration

**Proposed API Changes**
- Add a VCS service to the core session manager (Git-first) with status, diff, branch, and revert operations.
- Expose APIs for session-level diff and revert/unrevert semantics.

**Summary**
Enable OpenCode endpoints that depend on repository state, diffs, and revert flows.

**OpenCode Endpoints (Reference)**
- `GET /opencode/vcs`
- `GET /opencode/session/{sessionID}/diff`
- `POST /opencode/session/{sessionID}/revert`
- `POST /opencode/session/{sessionID}/unrevert`

**Core Functionality Required**
- Repo discovery from session directory (with safe fallback).
- Status summary (branch, dirty files, ahead/behind).
- Diff generation (staged/unstaged, per file and full).
- Revert/unrevert mechanics with temporary snapshots or stashes.
- Integration with file status endpoint when available.

**OpenCode Compat Wiring + Tests**
- Replace stubs for `/vcs`, `/session/{sessionID}/diff`, `/session/{sessionID}/revert`, `/session/{sessionID}/unrevert`.
- Add E2E tests that modify a fixture repo and validate diff + revert flows.
