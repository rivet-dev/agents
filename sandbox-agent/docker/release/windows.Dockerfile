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

FROM rust:1.88.0

# Accept version as build arg
ARG SANDBOX_AGENT_VERSION
ENV SANDBOX_AGENT_VERSION=${SANDBOX_AGENT_VERSION}

# Install dependencies
RUN apt-get update && apt-get install -y \
    llvm-14-dev \
    libclang-14-dev \
    clang-14 \
    gcc-mingw-w64-x86-64 \
    g++-mingw-w64-x86-64 \
    binutils-mingw-w64-x86-64 \
    ca-certificates \
    curl \
    git && \
    rm -rf /var/lib/apt/lists/*

# Switch MinGW-w64 to the POSIX threading model toolchain
RUN update-alternatives --set x86_64-w64-mingw32-gcc /usr/bin/x86_64-w64-mingw32-gcc-posix && \
    update-alternatives --set x86_64-w64-mingw32-g++ /usr/bin/x86_64-w64-mingw32-g++-posix

# Install target
RUN rustup target add x86_64-pc-windows-gnu

# Configure Cargo for Windows cross-compilation
RUN mkdir -p /root/.cargo && \
    echo '\
[target.x86_64-pc-windows-gnu]\n\
linker = "x86_64-w64-mingw32-gcc"\n\
' > /root/.cargo/config.toml

# Set environment variables for cross-compilation
ENV CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc \
    CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc \
    CXX_x86_64_pc_windows_gnu=x86_64-w64-mingw32-g++ \
    CC_x86_64-pc-windows-gnu=x86_64-w64-mingw32-gcc \
    CXX_x86_64-pc-windows-gnu=x86_64-w64-mingw32-g++ \
    LIBCLANG_PATH=/usr/lib/llvm-14/lib \
    CLANG_PATH=/usr/bin/clang-14 \
    CARGO_INCREMENTAL=0 \
    CARGO_NET_GIT_FETCH_WITH_CLI=true

# Set working directory
WORKDIR /build

# Copy the source code
COPY . .

# Copy pre-built inspector frontend
COPY --from=inspector-build /app/frontend/packages/inspector/dist ./frontend/packages/inspector/dist

# Build for Windows
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build -p sandbox-agent -p gigacode --release --target x86_64-pc-windows-gnu && \
    mkdir -p /artifacts && \
    cp target/x86_64-pc-windows-gnu/release/sandbox-agent.exe /artifacts/sandbox-agent-x86_64-pc-windows-gnu.exe && \
    cp target/x86_64-pc-windows-gnu/release/gigacode.exe /artifacts/gigacode-x86_64-pc-windows-gnu.exe

# Default command to show help
CMD ["ls", "-la", "/artifacts"]
