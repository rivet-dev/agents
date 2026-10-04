# Spec: Provider Auth Lifecycle

**Proposed API Changes**
- Add provider credential management to the core session manager (integrated with existing credentials store).
- Expose OAuth and direct credential set/remove operations.

**Summary**
OpenCode expects provider auth and OAuth endpoints. We need a real provider registry and credential storage that ties to agent configuration.

**OpenCode Endpoints (Reference)**
- `GET /opencode/provider`
- `GET /opencode/provider/auth`
- `POST /opencode/provider/{providerID}/oauth/authorize`
- `POST /opencode/provider/{providerID}/oauth/callback`
- `PUT /opencode/auth/{providerID}`
- `DELETE /opencode/auth/{providerID}`

**Core Functionality Required**
- Provider registry with models, capabilities, and connection state.
- OAuth initiation/callback handling with credential storage.
- Direct credential setting/removal.
- Mapping to agent manager credentials and environment.

**OpenCode Compat Wiring + Tests**
- Replace stubs for `/provider`, `/provider/auth`, `/provider/{providerID}/oauth/*`, `/auth/{providerID}`.
- Add E2E tests for credential set/remove and provider list reflecting auth state.
