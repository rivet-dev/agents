# Spec: Formatter + LSP Integration

**Proposed API Changes**
- Add a formatter service and LSP status registry to the core session manager.
- Provide per-language formatter availability and LSP server status.

**Summary**
OpenCode surfaces formatter and LSP availability via dedicated endpoints. We need real integration (or at minimum, real status introspection).

**OpenCode Endpoints (Reference)**
- `GET /opencode/formatter`
- `GET /opencode/lsp`

**Core Functionality Required**
- Discover available formatters by language in the workspace.
- Track LSP server status (running, capabilities).
- Optional API to trigger formatting for a file (future extension).

**OpenCode Compat Wiring + Tests**
- Replace stubs for `/formatter` and `/lsp`.
- Add E2E tests that validate formatter/LSP presence for fixture languages.
