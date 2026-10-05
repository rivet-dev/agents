# Sandbox Agent development recipes live in sandbox-agent/justfile.

# Release one target: `just release <sandbox-agent|pi|sandbox-adapter> --version <v>`.
# See scripts/release/main.ts for the phases.
[group('release')]
release *ARGS:
	pnpm exec tsx ./scripts/release/main.ts {{ ARGS }}
