# Spec: Session Summarization + Todo

**Proposed API Changes**
- Add summarization and todo generation to the core session manager.
- Store summaries/todos as session artifacts with versioning.

**Summary**
OpenCode expects session summarize and todo endpoints backed by actual model output.

**OpenCode Endpoints (Reference)**
- `POST /opencode/session/{sessionID}/summarize`
- `GET /opencode/session/{sessionID}/todo`

**Core Functionality Required**
- Generate a summary using the selected model/provider.
- Store and return the latest summary (and optionally history).
- Generate and store todo items derived from session activity.

**OpenCode Compat Wiring + Tests**
- Replace stubs for `/session/{sessionID}/summarize` and `/session/{sessionID}/todo`.
- Add E2E tests validating summary content and todo list structure.
