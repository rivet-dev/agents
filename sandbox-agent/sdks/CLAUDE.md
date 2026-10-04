# SDK Instructions

## TypeScript SDK Architecture

- TypeScript clients are split into:
  - `acp-http-client`: protocol-pure ACP-over-HTTP (`/v1/acp`) with no Sandbox-specific HTTP helpers.
  - `sandbox-agent`: `SandboxAgent` SDK wrapper that combines ACP session operations with Sandbox control-plane and filesystem helpers.
- `SandboxAgent` entry points are `SandboxAgent.connect(...)` and `SandboxAgent.start(...)`.
- Stable Sandbox session methods are `createSession`, `resumeSession`, `resumeOrCreateSession`, `destroySession`, `rawSendSessionMethod`, `onSessionEvent`, `setSessionMode`, `setSessionModel`, `setSessionThoughtLevel`, `setSessionConfigOption`, `getSessionConfigOptions`, `getSessionModes`, `respondPermission`, `rawRespondPermission`, and `onPermissionRequest`.
- `Session` helpers are `prompt(...)`, `rawSend(...)`, `onEvent(...)`, `setMode(...)`, `setModel(...)`, `setThoughtLevel(...)`, `setConfigOption(...)`, `getConfigOptions()`, `getModes()`, `respondPermission(...)`, `rawRespondPermission(...)`, and `onPermissionRequest(...)`.
- Cleanup is `sdk.dispose()`.

### React Component Methodology

- Shared React UI belongs in `sdks/react` only when it is reusable outside the Inspector.
- If the same UI pattern is shared between the Sandbox Agent Inspector and Foundry, prefer extracting it into `sdks/react` instead of maintaining parallel implementations.
- Keep shared components unstyled by default: behavior in the package, styling in the consumer via `className`, slot-level `classNames`, render overrides, and `data-*` hooks.
- Prefer extracting reusable pieces such as transcript, composer, and conversation surfaces. Keep Inspector-specific shells such as session selection, session headers, and control-plane actions in `frontend/packages/inspector/`.
- Document all shared React components in `docs/react-components.mdx`, and keep that page aligned with the exported surface in `sdks/react/src/index.ts`.

### TypeScript SDK Naming Conventions

- Use `respond<Thing>(id, reply)` for SDK methods that reply to an agent-initiated request (e.g. `respondPermission`). This is the standard pattern for answering any inbound JSON-RPC request from the agent.
- Prefix raw/low-level escape hatches with `raw` (e.g. `rawRespondPermission`, `rawSend`). These accept protocol-level types directly and bypass SDK abstractions.

### Docs Source Of Truth

- For TypeScript docs/examples, source of truth is implementation in:
  - `sdks/typescript/src/client.ts`
  - `sdks/typescript/src/index.ts`
  - `sdks/acp-http-client/src/index.ts`
- Do not document TypeScript APIs unless they are exported and implemented in those files.

## Tests

- TypeScript SDK tests should run against a real running server/runtime over real `/v1` HTTP APIs, typically using the real `mock` agent for deterministic behavior.
- Do not use Vitest fetch/transport mocks to simulate server functionality in TypeScript SDK tests.
