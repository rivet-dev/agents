# Repository Instructions

This repository holds Rivet's agent projects. Project-specific rules live next to each project; read them before working there.

- `sandbox-agent/`: Sandbox Agent. Rules in `sandbox-agent/CLAUDE.md`.

## Layout

- The repository root is a small pnpm workspace (`pnpm-workspace.yaml`) that holds the release script in `scripts/release/`.
- `sandbox-agent/` is its own pnpm workspace and Cargo workspace. Its Dockerfiles use `sandbox-agent/` as the build context, so its lockfile and workspace stay there. Run its `pnpm`, `cargo`, and `just` commands from inside `sandbox-agent/`.
- GitHub workflows live in the root `.github/workflows/` because GitHub only reads them there. Jobs that build Sandbox Agent set `working-directory: sandbox-agent`.
- Git hooks are configured once in the root `lefthook.yml`. Each job is scoped to the workspace whose formatter owns the files.
- Formatting: root files use the root `biome.json`. Files under `sandbox-agent/` use `sandbox-agent/biome.json`.

## Releases

- Everything in the repository releases together on one version line, tagged `v<version>`.
- Run `just release` from the repository root. The script is `scripts/release/main.ts` and the CI workflow is `.github/workflows/release.yaml`.
- `ReleaseOpts.repoRoot` is the repository root and `ReleaseOpts.sandboxAgentRoot` is `sandbox-agent/`. Resolve Sandbox Agent paths (Cargo, `sdks/`, Docker, docs) from `sandboxAgentRoot`.
