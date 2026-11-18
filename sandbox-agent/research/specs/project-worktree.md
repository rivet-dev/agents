# Spec: Project + Worktree Model

**Proposed API Changes**
- Add a project/worktree manager to the core session manager.
- Expose project metadata and active worktree operations (create/list/reset/delete).

**Summary**
OpenCode relies on project and worktree endpoints for context and repo operations. We need a real project model backed by the workspace and VCS.

**OpenCode Endpoints (Reference)**
- `GET /opencode/project`
- `GET /opencode/project/current`
- `PATCH /opencode/project/{projectID}`
- `GET /opencode/experimental/worktree`
- `POST /opencode/experimental/worktree`
- `DELETE /opencode/experimental/worktree`
- `POST /opencode/experimental/worktree/reset`

**Core Functionality Required**
- Project identity and metadata (id, title, directory, branch).
- Current project derivation by directory/session.
- Worktree creation/reset/delete tied to VCS.
- Return consistent IDs and location data.

**OpenCode Compat Wiring + Tests**
- Replace stubs for `/project`, `/project/current`, `/project/{projectID}`, and `/experimental/worktree*` endpoints.
- Add E2E tests for worktree lifecycle and project metadata correctness.
