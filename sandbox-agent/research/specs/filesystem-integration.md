# Spec: Filesystem Integration

**Proposed API Changes**
- Add a workspace filesystem service to the core session manager with path scoping and traversal protection.
- Expose file list/content/status APIs via the core service for reuse in OpenCode compat.

**Summary**
Provide safe, read-oriented filesystem access needed by OpenCode for file listing, content retrieval, and status details within a session directory.

**OpenCode Endpoints (Reference)**
- `GET /opencode/file`
- `GET /opencode/file/content`
- `GET /opencode/file/status`
- `GET /opencode/path`

**Core Functionality Required**
- Path normalization and sandboxed root enforcement per session/project.
- File listing with filters (directory, glob, depth, hidden).
- File content retrieval with mime detection and optional range.
- File status (exists, type, size, last modified; optionally VCS status).
- Optional file tree caching for performance.

**OpenCode Compat Wiring + Tests**
- Replace stubs for `/file`, `/file/content`, `/file/status`, and `/path`.
- Add E2E tests for reading content, listing directories, and invalid path handling.
