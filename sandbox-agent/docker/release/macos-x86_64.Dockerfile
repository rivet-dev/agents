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

FROM rust:1.88.0 AS base

# Install dependencies
RUN apt-get update && apt-get install -y \
    clang \
    cmake \
    patch \
    libxml2-dev \
    wget \
    xz-utils \
    curl \
    git && \
    rm -rf /var/lib/apt/lists/*

# Install osxcross
RUN git config --global --add safe.directory '*' && \
    git clone https://github.com/tpoechtrager/osxcross /root/osxcross && \
    cd /root/osxcross && \
    wget -nc https://github.com/phracker/MacOSX-SDKs/releases/download/11.3/MacOSX11.3.sdk.tar.xz && \
    mv MacOSX11.3.sdk.tar.xz tarballs/ && \
    UNATTENDED=yes OSX_VERSION_MIN=10.7 ./build.sh

# Add osxcross to PATH
ENV PATH="/root/osxcross/target/bin:$PATH"

# Tell Clang/bindgen to use the macOS SDK, and nudge Clang to prefer osxcross binutils.
ENV OSXCROSS_SDK=MacOSX11.3.sdk \
    SDKROOT=/root/osxcross/target/SDK/MacOSX11.3.sdk \
    BINDGEN_EXTRA_CLANG_ARGS_X86_64_apple_darwin="--sysroot=/root/osxcross/target/SDK/MacOSX11.3.sdk -isystem /root/osxcross/target/SDK/MacOSX11.3.sdk/usr/include" \
    CFLAGS_X86_64_apple_darwin="-B/root/osxcross/target/bin" \
    CXXFLAGS_X86_64_apple_darwin="-B/root/osxcross/target/bin" \
    CARGO_TARGET_X86_64_APPLE_DARWIN_LINKER=x86_64-apple-darwin20.4-clang \
    CC_x86_64_apple_darwin=x86_64-apple-darwin20.4-clang \
    CXX_x86_64_apple_darwin=x86_64-apple-darwin20.4-clang++ \
    AR_X86_64_apple_darwin=x86_64-apple-darwin20.4-ar \
    RANLIB_X86_64_apple_darwin=x86_64-apple-darwin20.4-ranlib \
    MACOSX_DEPLOYMENT_TARGET=10.14 \
    CARGO_INCREMENTAL=0 \
    CARGO_NET_GIT_FETCH_WITH_CLI=true

# Set working directory
WORKDIR /build

# Build for x86_64 macOS
FROM base AS x86_64-builder

# Accept version as build arg
ARG SANDBOX_AGENT_VERSION
ENV SANDBOX_AGENT_VERSION=${SANDBOX_AGENT_VERSION}

# Install macOS x86_64 target
RUN rustup target add x86_64-apple-darwin

# Configure Cargo for cross-compilation (x86_64)
RUN mkdir -p /root/.cargo && \
    echo '\
[target.x86_64-apple-darwin]\n\
linker = "x86_64-apple-darwin20.4-clang"\n\
ar = "x86_64-apple-darwin20.4-ar"\n\
' > /root/.cargo/config.toml

# Copy the source code
COPY . .

# Copy pre-built inspector frontend
COPY --from=inspector-build /app/frontend/packages/inspector/dist ./frontend/packages/inspector/dist

# Build for x86_64 macOS
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build -p sandbox-agent -p gigacode --release --target x86_64-apple-darwin && \
    mkdir -p /artifacts && \
    cp target/x86_64-apple-darwin/release/sandbox-agent /artifacts/sandbox-agent-x86_64-apple-darwin && \
    cp target/x86_64-apple-darwin/release/gigacode /artifacts/gigacode-x86_64-apple-darwin

# Default command to show help
CMD ["ls", "-la", "/artifacts"]
