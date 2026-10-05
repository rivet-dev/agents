# Repository Instructions

This repository holds Rivet's agent projects. Project-specific rules live next to each project; read them before working there.

- `packages/`: Rivet agent packages (`@rivet-dev/pi`, `@rivet-dev/sandbox-adapter`).
- `docs/` and `examples/docs/`: the Agents docs published at rivet.dev/agents/docs. Rules in `docs/CLAUDE.md`.
- `sandbox-agent/`: Sandbox Agent. Rules in `sandbox-agent/CLAUDE.md`.

## Layout

- The repository root is a pnpm workspace (`pnpm-workspace.yaml`) holding `packages/*`, the docs snippets in `examples/docs`, and the release script in `scripts/release/`. Root scripts: `pnpm build`, `pnpm check-types` (after `build`), `pnpm test`, `pnpm lint`, `pnpm check-boundaries`, `pnpm test:packed`.
- `@rivet-dev/pi` takes `rivetkit` as a peer dependency because its actor runs in the user's registry. `@rivet-dev/sandbox-adapter` must not depend on RivetKit. `scripts/check-boundaries.mjs` enforces both.
- `sandbox-agent/` is its own pnpm workspace and Cargo workspace. Its Dockerfiles use `sandbox-agent/` as the build context, so its lockfile and workspace stay there. Run its `pnpm`, `cargo`, and `just` commands from inside `sandbox-agent/`.
- GitHub workflows live in the root `.github/workflows/` because GitHub only reads them there. Jobs that build Sandbox Agent set `working-directory: sandbox-agent`.
- Git hooks are configured once in the root `lefthook.yml`. Each job is scoped to the workspace whose formatter owns the files.
- Formatting: root files use the root `biome.json`. Files under `sandbox-agent/` use `sandbox-agent/biome.json`.

## Releases

- `just release <target> --version <version>` releases one target: `sandbox-agent` (crates, binaries, Docker images, npm packages; tag `v<version>`), `pi` (`@rivet-dev/pi`; tag `pi-v<version>`), or `sandbox-adapter` (`@rivet-dev/sandbox-adapter`; tag `sandbox-adapter-v<version>`). A target never publishes another target's packages.
- A root package release fails when its version is already on npm, or when a workspace dependency it pins is not on npm yet. Release the dependency first.
- Run `just release` from the repository root. The script is `scripts/release/main.ts`, the targets are in `scripts/release/target.ts`, and the CI workflow is `.github/workflows/release.yaml`.
- `ReleaseOpts.repoRoot` is the repository root and `ReleaseOpts.sandboxAgentRoot` is `sandbox-agent/`. Resolve Sandbox Agent paths (Cargo, `sdks/`, Docker, docs) from `sandboxAgentRoot`.

## Docs Sync

- `.github/workflows/docs-sync.yml` copies `docs/` and `examples/` into `rivet-dev/website`'s `vendor/agents/` on merge to `main` and opens a PR there. Do not edit `vendor/agents/` in the website.
