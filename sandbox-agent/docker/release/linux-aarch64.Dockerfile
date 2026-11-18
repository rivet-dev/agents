# syntax=docker/dockerfile:1.10.0

# Build inspector frontend
FROM node:22-alpine AS inspector-build
WORKDIR /app
RUN npm install -g pnpm

# Copy package files for workspaces
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/packages/inspector/package.json ./frontend/packages/inspector/
COPY sdks/cli-shared/package.json ./sdks/cli-shared/
COPY sdks/acp-http-client/package.json ./sdks/acp-http-client/
COPY sdks/react/package.json ./sdks/react/
COPY sdks/typescript/package.json ./sdks/typescript/

# Install dependencies
RUN pnpm install --filter @sandbox-agent/inspector...

# Copy SDK source (with pre-generated types from docs/openapi.json)
COPY docs/openapi.json ./docs/
COPY sdks/cli-shared ./sdks/cli-shared
COPY sdks/acp-http-client ./sdks/acp-http-client
COPY sdks/react ./sdks/react
COPY sdks/typescript ./sdks/typescript

# Build cli-shared, acp-http-client, SDK, then react (depends on SDK)
RUN cd sdks/cli-shared && pnpm exec tsup
RUN cd sdks/acp-http-client && pnpm exec tsup
RUN cd sdks/typescript && SKIP_OPENAPI_GEN=1 pnpm exec tsup
RUN cd sdks/react && pnpm exec tsup

# Copy inspector source and build
COPY frontend/packages/inspector ./frontend/packages/inspector
RUN cd frontend/packages/inspector && pnpm exec vite build

# Use Alpine with native musl for ARM64 builds (runs natively on ARM64 runner)
FROM rust:1.88-alpine AS aarch64-builder

# Accept version as build arg
ARG SANDBOX_AGENT_VERSION
ENV SANDBOX_AGENT_VERSION=${SANDBOX_AGENT_VERSION}

# Install dependencies
RUN apk add --no-cache \
    musl-dev \
    clang \
    llvm-dev \
    openssl-dev \
    openssl-libs-static \
    pkgconfig \
    git \
    curl \
    build-base

# Add musl target
RUN rustup target add aarch64-unknown-linux-musl

# Set environment variables for native musl build
ENV CARGO_INCREMENTAL=0 \
    CARGO_NET_GIT_FETCH_WITH_CLI=true \
    RUSTFLAGS="-C target-feature=+crt-static"

WORKDIR /build

# Copy the source code
COPY . .

# Copy pre-built inspector frontend
COPY --from=inspector-build /app/frontend/packages/inspector/dist ./frontend/packages/inspector/dist

# Build for Linux with musl (static binary) - aarch64
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build -p sandbox-agent -p gigacode --release --target aarch64-unknown-linux-musl && \
    mkdir -p /artifacts && \
    cp target/aarch64-unknown-linux-musl/release/sandbox-agent /artifacts/sandbox-agent-aarch64-unknown-linux-musl && \
    cp target/aarch64-unknown-linux-musl/release/gigacode /artifacts/gigacode-aarch64-unknown-linux-musl

# Default command to show help
CMD ["ls", "-la", "/artifacts"]
