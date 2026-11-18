# Spec: Search + Symbol Indexing

**Proposed API Changes**
- Add a search/indexing service to the core session manager (ripgrep-backed initially).
- Expose APIs for text search, file search, and symbol search.

**Summary**
OpenCode expects fast search endpoints for files, text, and symbols within a workspace. These must be safe and scoped.

**OpenCode Endpoints (Reference)**
- `GET /opencode/find`
- `GET /opencode/find/file`
- `GET /opencode/find/symbol`

**Core Functionality Required**
- Text search with pattern, case sensitivity, and result limits.
- File search with glob/substring match.
- Symbol indexing (language server or ctags-backed), with caching and incremental updates.
- Proper path scoping and escaping.

**OpenCode Compat Wiring + Tests**
- Replace stubs for `/find`, `/find/file`, `/find/symbol`.
- Add E2E tests with a fixture repo verifying search hits.
