# Contributing

Documentation lives in `docs/` (Mintlify). Start with:

- `docs/index.mdx` for the overview
- `docs/quickstart.mdx` to run the daemon
- `docs/http-api.mdx` and `docs/cli.mdx` for API references

## Development Setup

### Prerequisites

- Rust (latest stable)
- Node.js 20+
- pnpm 9+
- [just](https://github.com/casey/just) (optional, but recommended)

### Quickstart

Run the agent locally:

```bash
sandbox-agent --token "$SANDBOX_TOKEN" --host 127.0.0.1 --port 2468
```

Extract API keys from local agent configs (Claude Code, Codex, OpenCode, Amp):

```bash
# Print env vars
sandbox-agent credentials extract-env

# Export to current shell
eval "$(sandbox-agent credentials extract-env --export)"
```

Run the web console (includes all dependencies):

```bash
pnpm dev -F @sandbox-agent/inspector
# or
just dev
```

### Common Commands

```bash
# Run checks (cargo check, fmt, typecheck)
just check

# Run tests
just test

# Format code
just fmt

# Build the agent
just build
```

## Releasing

Releases are managed through a release script that handles version bumps, artifact uploads, npm/crates.io publishing, and GitHub releases.

### Prerequisites

1. Install dependencies in the release script directory:
   ```bash
   cd scripts/release && pnpm install && cd ../..
   ```

2. Ensure you have the following configured:
   - `gh` CLI authenticated
   - npm authenticated (`npm login`)
   - `CARGO_REGISTRY_TOKEN` for crates.io (or run `cargo login`)
   - R2 credentials: `R2_RELEASES_ACCESS_KEY_ID` and `R2_RELEASES_SECRET_ACCESS_KEY`
     (or 1Password CLI for local dev)

### Release Commands

```bash
# Release with automatic patch bump
just release --patch

# Release with minor bump
just release --minor

# Release with specific version
just release --version 0.2.0

# Release a pre-release
just release --version 0.2.0-rc.1 --no-latest
```

### Release Flow

The release process has three phases:

**1. setup-local** (runs locally via `just release`):
- Confirms release details with user
- Runs local checks (cargo check, fmt, typecheck)
- Updates version numbers across all packages
- Generates artifacts (OpenAPI spec, TypeScript SDK)
- Commits and pushes changes
- Triggers the GitHub Actions release workflow

**2. setup-ci** (runs in CI):
- Runs full test suite (Rust + TypeScript)
- Builds TypeScript SDK and uploads to R2 at `sandbox-agent/{commit}/typescript/`

**3. binaries** (runs in CI, parallel with setup-ci completing):
- Builds binaries for all platforms via Docker cross-compilation
- Uploads binaries to R2 at `sandbox-agent/{commit}/binaries/`

**4. complete-ci** (runs in CI after setup + binaries):
- Publishes crates to crates.io
- Publishes npm packages (SDK + CLI)
- Promotes artifacts from `{commit}/` to `{version}/` (S3-to-S3 copy)
- Creates git tag and pushes
- Creates GitHub release with auto-generated notes

### Manual Steps

To run specific steps manually:

```bash
# Run only local checks
cd scripts/release && pnpm exec tsx ./main.ts --version 0.1.0 --only-steps run-local-checks

# Build binaries locally
just release-build-all
```

## Project Structure

```
sandbox-daemon/
├── server/packages/     # Rust crates
│   ├── sandbox-agent/   # Main agent binary
│   ├── agent-schema/    # Agent-specific schemas (Claude, Codex, etc.)
│   └── ...
├── sdks/
│   ├── typescript/      # TypeScript SDK (npm: sandbox-agent)
│   └── cli/             # CLI wrapper (npm: @sandbox-agent/cli)
├── frontend/packages/
│   └── inspector/       # Web console UI
├── docs/                # Mintlify documentation
└── scripts/release/     # Release automation
```
