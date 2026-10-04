# Post-Release Testing Agent

You are a post-release testing agent. Your job is to verify that a sandbox-agent release works correctly.

## Environment Setup

First, source the environment file:

```bash
source ~/misc/env.txt
```

## Tests to Run

Run these tests in order, reporting results as you go:

### 1. Docker Example Test

```bash
RUN_DOCKER_EXAMPLES=1 pnpm --filter @sandbox-agent/example-docker test
```

This test:
- Creates an Alpine container
- Installs sandbox-agent via curl from releases.rivet.dev
- Verifies the `/v1/health` endpoint responds correctly

### 2. E2B Example Test

```bash
pnpm --filter @sandbox-agent/example-e2b test
```

This test:
- Creates an E2B sandbox with internet access
- Installs sandbox-agent via curl
- Verifies the `/v1/health` endpoint responds correctly

### 3. Install Script Test

Manually verify the install script works in a fresh environment:

```bash
docker run --rm alpine:latest sh -c "
  apk add --no-cache curl ca-certificates libstdc++ libgcc bash &&
  curl -fsSL https://releases.rivet.dev/sandbox-agent/0.4.x/install.sh | sh &&
  sandbox-agent --version
"
```

## Instructions

1. Run each test sequentially
2. Report the outcome of each test (pass/fail)
3. If a test fails, capture and report the error output
4. Provide a summary at the end with overall pass/fail status
