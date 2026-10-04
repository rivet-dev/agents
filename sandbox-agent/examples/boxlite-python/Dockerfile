FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://releases.rivet.dev/sandbox-agent/0.4.x/install.sh | sh
RUN sandbox-agent install-agent claude
RUN sandbox-agent install-agent codex
