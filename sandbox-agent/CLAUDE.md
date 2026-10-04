# Instructions

## Naming and Ownership

- This repository/product is **Sandbox Agent**.
- **Gigacode** is a separate user-facing UI/client, not the server product name.
- Gigacode integrates with Sandbox Agent via the OpenCode-compatible surface (`/opencode/*`) when that compatibility layer is enabled.
- Canonical extension namespace/domain string is `sandboxagent.dev` (no hyphen).
- Canonical custom ACP extension method prefix is `_sandboxagent/...` (no hyphen).

## Docs Terminology

- Never mention "ACP" in user-facing docs (`docs/**/*.mdx`) except in docs that are specifically about ACP itself (e.g. `docs/acp-http-client.mdx`).
- Never expose underlying protocol method names (e.g. `session/request_permission`, `session/create`, `_sandboxagent/session/detach`) in non-ACP docs. Describe the behavior in user-facing terms instead.
- Do not describe the underlying protocol implementation in docs. Only document the SDK surface (methods, types, options). ACP protocol details belong exclusively in ACP-specific pages.
- Do not use em dashes (`—`) in docs. Use commas, periods, or parentheses instead.

### Docs Source Of Truth (HTTP/CLI)

- For HTTP/CLI docs/examples, source of truth is:
  - `server/packages/sandbox-agent/src/router.rs`
  - `server/packages/sandbox-agent/src/cli.rs`
- Keep docs aligned to implemented endpoints/commands only (for example ACP under `/v1/acp`, not legacy session REST APIs).

## Docs Styling

- Docs styling is owned by the shared **`@rivet-dev/docs-theme`** repo (`github.com/rivet-dev/docs-theme`), consumed via `github:rivet-dev/docs-theme#<tag>` in `frontend/packages/website`. To change any docs styling (palette, header, sidebar, code blocks, fonts), edit that repo and follow its CLAUDE.md release workflow — never restyle docs here. This site owns only docs content + `frontend/packages/website/docs.config.mjs` (sidebar icons via each item's `attrs['data-icon']`).

## Change Tracking

- If the user asks to "push" changes, treat that as permission to commit and push all current workspace changes, not a hand-picked subset, unless the user explicitly scopes the push.
- Keep CLI subcommands and HTTP endpoints in sync.
- Update `docs/cli.mdx` when CLI behavior changes.
- Regenerate `docs/openapi.json` when HTTP contracts change.
- Keep `docs/inspector.mdx` and `docs/sdks/typescript.mdx` aligned with implementation.
- Append blockers/decisions to `research/acp/friction.md` during ACP work.
- `docs/agent-capabilities.mdx` lists models/modes/thought levels per agent. Update it when adding a new agent or changing `fallback_config_options`. If its "Last updated" date is >2 weeks old, re-run `cd scripts/agent-configs && npx tsx dump.ts` and update the doc to match. Source data: `scripts/agent-configs/resources/*.json` and hardcoded entries in `server/packages/sandbox-agent/src/router/support.rs` (`fallback_config_options`).
- Some agent models are gated by subscription (e.g. Claude `opus`). The live report only shows models available to the current credentials. The static doc and JSON resource files should list all known models regardless of subscription tier.

## Docker Test Image

- Docker-backed Rust and TypeScript tests build `docker/test-agent/Dockerfile` directly in-process and cache the image tag only in memory (`OnceLock` in Rust, module-level variable in TypeScript).
- Do not add cross-process image-build scripts unless there is a concrete need for them.

## Common Software Sync

- These three files must stay in sync:
  - `docs/common-software.mdx` (user-facing documentation)
  - `docker/test-common-software/Dockerfile` (packages installed in the test image)
  - `server/packages/sandbox-agent/tests/common_software.rs` (test assertions)
- When adding or removing software from `docs/common-software.mdx`, also add/remove the corresponding `apt-get install` line in the Dockerfile and add/remove the test in `common_software.rs`.
- Run `cargo test -p sandbox-agent --test common_software` to verify.

## Install Version References

- Channel policy:
  - Sandbox Agent install/version references use a pinned minor channel `0.N.x` (for curl URLs and `sandbox-agent` / `@sandbox-agent/cli` npm/bun installs).
  - Gigacode install/version references use `latest` (for `@sandbox-agent/gigacode` install/run commands and `gigacode-install.*` release promotion).
  - Release promotion policy: `latest` releases must still update `latest`; when a release is `latest`, Sandbox Agent must also be promoted to the matching minor channel `0.N.x`.
- Keep every install-version reference below in sync whenever versions/channels change:
  - `README.md`
  - `docs/acp-http-client.mdx`
  - `docs/cli.mdx`
  - `docs/quickstart.mdx`
  - `docs/sdk-overview.mdx`
  - `docs/react-components.mdx`
  - `docs/session-persistence.mdx`
  - `docs/deploy/local.mdx`
  - `docs/deploy/cloudflare.mdx`
  - `docs/deploy/vercel.mdx`
  - `docs/deploy/daytona.mdx`
  - `docs/deploy/e2b.mdx`
  - `docs/deploy/docker.mdx`
  - `frontend/packages/website/src/components/GetStarted.tsx`
  - `.claude/commands/post-release-testing.md`
  - `examples/cloudflare/Dockerfile`
  - `examples/daytona/src/index.ts`
  - `examples/shared/src/docker.ts`
  - `examples/docker/src/index.ts`
  - `examples/e2b/src/index.ts`
  - `examples/vercel/src/index.ts`
  - `scripts/release/main.ts`
  - `scripts/release/promote-artifacts.ts`
  - `scripts/release/sdk.ts`
