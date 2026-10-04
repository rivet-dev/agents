# Delete Or Comment Out First

This is the initial, deliberate teardown list before building ACP-native v1.

## Hard delete first (in-house protocol types and converters)

- `server/packages/universal-agent-schema/Cargo.toml`
- `server/packages/universal-agent-schema/src/lib.rs`
- `server/packages/universal-agent-schema/src/agents/mod.rs`
- `server/packages/universal-agent-schema/src/agents/claude.rs`
- `server/packages/universal-agent-schema/src/agents/codex.rs`
- `server/packages/universal-agent-schema/src/agents/opencode.rs`
- `server/packages/universal-agent-schema/src/agents/amp.rs`
- `spec/universal-schema.json`
- `docs/session-transcript-schema.mdx`
- `docs/conversion.mdx`

## Hard delete next (generated schema pipeline used only for in-house normalization)

- `server/packages/extracted-agent-schemas/Cargo.toml`
- `server/packages/extracted-agent-schemas/build.rs`
- `server/packages/extracted-agent-schemas/src/lib.rs`
- `server/packages/extracted-agent-schemas/tests/schema_roundtrip.rs`
- `resources/agent-schemas/` (entire folder)

## Remove/replace immediately (v1 hard removal)

- `server/packages/sandbox-agent/src/router.rs`: remove `/v1` handlers and replace with a unified `410 v1 removed` handler.
- `server/packages/sandbox-agent/src/cli.rs`: remove/disable `api` subcommands that target `/v1`.
- `sdks/typescript/src/client.ts`: methods bound to `/v1/*` routes.
- `sdks/typescript/src/generated/openapi.ts`: current v1 OpenAPI output.
- `docs/openapi.json`: current v1 OpenAPI document.

## Compatibility surface to disable during ACP core

- `server/packages/sandbox-agent/src/opencode_compat.rs`
- `server/packages/sandbox-agent/tests/opencode-compat/`
- `docs/opencode-compatibility.mdx`

Rationale: this layer is based on current v1 session/event model. Comment it out/disable it during ACP core implementation to avoid coupling and drift.

Important: OpenCode <-> ACP support is still required, but it is explicitly reintroduced in Phase 7 after ACP v1 core transport/runtime are stable.

## Tests to remove or disable with v1

- `server/packages/sandbox-agent/tests/http/`
- `server/packages/sandbox-agent/tests/sessions/`
- `server/packages/sandbox-agent/tests/agent-flows/`
- `server/packages/sandbox-agent/tests/http_endpoints.rs`
- `server/packages/sandbox-agent/tests/sessions.rs`
- `server/packages/sandbox-agent/tests/agent_flows.rs`

Replace with ACP-native contract tests in v1.
