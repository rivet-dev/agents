# Server Instructions

## ACP v1 Baseline

- v1 is ACP-native.
- `/v1/*` is removed and returns `410 Gone` (`application/problem+json`).
- `/opencode/*` is disabled during ACP core phases and returns `503`.
- Prompt/session traffic is ACP JSON-RPC over streamable HTTP on `/v1/rpc`:
  - `POST /v1/rpc`
  - `GET /v1/rpc` (SSE)
  - `DELETE /v1/rpc`
- Control-plane endpoints:
  - `GET /v1/health`
  - `GET /v1/agents`
  - `POST /v1/agents/{agent}/install`
- Binary filesystem transfer endpoints (intentionally HTTP, not ACP extension methods):
  - `GET /v1/fs/file`
  - `PUT /v1/fs/file`
  - `POST /v1/fs/upload-batch`
- Sandbox Agent ACP extension method naming:
  - Custom ACP methods use `_sandboxagent/...` (not `_sandboxagent/v1/...`).
  - Session detach method is `_sandboxagent/session/detach`.

## API Scope

- ACP is the primary protocol for agent/session behavior and all functionality that talks directly to the agent.
- ACP extensions may be used for gaps (for example `skills`, `models`, and related metadata), but the default is that agent-facing behavior is implemented by the agent through ACP.
- Custom HTTP APIs are for non-agent/session platform services (for example filesystem, terminals, and other host/runtime capabilities).
- Filesystem and terminal APIs remain Sandbox Agent-specific HTTP contracts and are not ACP.
  - Do not make Sandbox Agent core flows depend on ACP client implementations of `fs/*` or `terminal/*`; in practice those client-side capabilities are often incomplete or inconsistent.
  - ACP-native filesystem and terminal methods are also too limited for Sandbox Agent host/runtime needs, so prefer the native HTTP APIs for richer behavior.
- Keep `GET /v1/fs/file`, `PUT /v1/fs/file`, and `POST /v1/fs/upload-batch` on HTTP:
  - These are Sandbox Agent host/runtime operations with cross-agent-consistent behavior.
  - They may involve very large binary transfers that ACP JSON-RPC envelopes are not suited to stream.
  - This is intentionally separate from ACP native `fs/read_text_file` and `fs/write_text_file`.
  - ACP extension variants may exist in parallel, but SDK defaults should prefer HTTP for these binary transfer operations.

## Architecture

- HTTP contract and problem/error mapping: `server/packages/sandbox-agent/src/router.rs`
- ACP proxy runtime: `server/packages/sandbox-agent/src/acp_proxy_runtime.rs`
- ACP client runtime and agent process bridge: `server/packages/sandbox-agent/src/acp_runtime/mod.rs`
- Agent install logic (native + ACP agent process + lazy install): `server/packages/agent-management/`
- Inspector UI served at `/ui/` and bound to ACP over HTTP from `frontend/packages/inspector/`

## API Contract Rules

- Every `#[utoipa::path(...)]` handler needs a summary line + description lines in its doc comment.
- Every `responses(...)` entry must include `description`.
- Regenerate `docs/openapi.json` after endpoint contract changes.
- Keep CLI and HTTP endpoint behavior aligned (`docs/cli.mdx`).

## ACP Protocol Compliance

- Before adding any new ACP method, property, or config option category to the SDK, verify it exists in the ACP spec at `https://agentclientprotocol.com/llms-full.txt`.
- Valid `SessionConfigOptionCategory` values are: `mode`, `model`, `thought_level`, `other`, or custom categories prefixed with `_` (e.g. `_permission_mode`).
- Do not invent ACP properties or categories (e.g. `permission_mode` is not a valid ACP category — use `_permission_mode` if it's a custom extension, or use existing ACP mechanisms like `session/set_mode`).
- `NewSessionRequest` only has `_meta`, `cwd`, and `mcpServers`. Do not add non-ACP fields to it.
- Sandbox Agent SDK abstractions (like `SessionCreateRequest`) may add convenience properties, but must clearly map to real ACP methods internally and not send fabricated fields over the wire.

## Source Documents

- ACP protocol specification (full LLM-readable reference): `https://agentclientprotocol.com/llms-full.txt`
- `~/misc/acp-docs/schema/schema.json`
- `~/misc/acp-docs/schema/meta.json`
- `research/acp/spec.md`
- `research/acp/v1-schema-to-acp-mapping.md`
- `research/acp/friction.md`
- `research/acp/todo.md`

## Tests

Primary v1 integration coverage:
- `server/packages/sandbox-agent/tests/v1_api.rs`
- `server/packages/sandbox-agent/tests/v1_agent_process_matrix.rs`

Run:
```bash
cargo test -p sandbox-agent --test v1_api
cargo test -p sandbox-agent --test v1_agent_process_matrix
```

## Migration Docs Sync

- Keep `research/acp/spec.md` as the source spec.
- Update `research/acp/todo.md` when scope/status changes.
- Log blockers/decisions in `research/acp/friction.md`.

## Docker Examples (Dev Testing)

- When manually testing bleeding-edge (unreleased) versions of sandbox-agent in `examples/`, use `SANDBOX_AGENT_DEV=1` with the Docker-based examples.
- This triggers a local build of `docker/runtime/Dockerfile.full` which builds the server binary from local source and packages it into the Docker image.
- Example: `SANDBOX_AGENT_DEV=1 pnpm --filter @sandbox-agent/example-mcp start`
