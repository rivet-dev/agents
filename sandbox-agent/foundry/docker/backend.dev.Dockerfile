# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3

ARG SANDBOX_AGENT_VERSION=0.3.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gh \
    nodejs \
    npm \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.28.2

RUN curl -fsSL "https://releases.rivet.dev/sandbox-agent/${SANDBOX_AGENT_VERSION}/install.sh" | sh

ENV PATH="/root/.local/bin:${PATH}"
ENV SANDBOX_AGENT_BIN="/root/.local/bin/sandbox-agent"
ENV RIVET_RUNNER_VERSION_FILE=/etc/foundry/rivet-runner-version
RUN mkdir -p /etc/foundry \
  && date +%s > /etc/foundry/rivet-runner-version

WORKDIR /app

# NOTE: Do NOT use `bun --hot` here. Bun's hot reloading re-initializes the
# server on a new port (e.g. 6421 instead of 6420) while the container still
# exposes the original port, breaking all client connections. Restart the
# backend container instead: `just foundry-dev-down && just foundry-dev`
CMD ["bash", "-lc", "git config --global --add safe.directory /app >/dev/null 2>&1 || true; pnpm install --frozen-lockfile --filter @sandbox-agent/foundry-backend... && exec bun foundry/packages/backend/src/index.ts start --host 0.0.0.0 --port 7741"]
