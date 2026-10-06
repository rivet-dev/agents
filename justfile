# Sandbox Agent development recipes live in sandbox-agent/justfile.

# Release everything in this repository on one version line. See
# scripts/release/main.ts for the phases.
[group('release')]
release *ARGS:
	pnpm exec tsx ./scripts/release/main.ts {{ ARGS }}
