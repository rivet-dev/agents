# syntax=docker/dockerfile:1.10.0
#
# Foundry base sandbox image.
#
# Builds sandbox-agent from source (reusing the upstream Dockerfile.full build
# stages) and layers Foundry-specific tooling on top: sudo, git, neovim, gh,
# node, bun, chromium, and agent-browser.
#
# Build:
#   docker build --platform linux/amd64 \
#     -f foundry/docker/foundry-base.Dockerfile \
#     -t rivetdev/sandbox-agent:foundry-base-<timestamp> .
#
# Must be invoked from the repository root so the COPY . picks up the full
# source tree for the Rust + inspector build stages.

# ============================================================================
# Build inspector frontend
# ============================================================================
FROM --platform=linux/amd64 node:22-alpine AS inspector-build
WORKDIR /app
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/packages/inspector/package.json ./frontend/packages/inspector/
COPY sdks/cli-shared/package.json ./sdks/cli-shared/
COPY sdks/acp-http-client/package.json ./sdks/acp-http-client/
COPY sdks/react/package.json ./sdks/react/
COPY sdks/typescript/package.json ./sdks/typescript/

RUN pnpm install --filter @sandbox-agent/inspector...

COPY docs/openapi.json ./docs/
COPY sdks/cli-shared ./sdks/cli-shared
COPY sdks/acp-http-client ./sdks/acp-http-client
COPY sdks/react ./sdks/react
COPY sdks/typescript ./sdks/typescript

RUN cd sdks/cli-shared && pnpm exec tsup
RUN cd sdks/acp-http-client && pnpm exec tsup
RUN cd sdks/typescript && SKIP_OPENAPI_GEN=1 pnpm exec tsup
RUN cd sdks/react && pnpm exec tsup

COPY frontend/packages/inspector ./frontend/packages/inspector
RUN cd frontend/packages/inspector && pnpm exec vite build

# ============================================================================
# AMD64 Builder - sandbox-agent static binary
# ============================================================================
FROM --platform=linux/amd64 rust:1.88.0 AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    musl-tools \
    musl-dev \
    llvm-14-dev \
    libclang-14-dev \
    clang-14 \
    libssl-dev \
    pkg-config \
    ca-certificates \
    g++ \
    g++-multilib \
    git \
    curl \
    wget && \
    rm -rf /var/lib/apt/lists/*

RUN wget -q https://github.com/cross-tools/musl-cross/releases/latest/download/x86_64-unknown-linux-musl.tar.xz && \
    tar -xf x86_64-unknown-linux-musl.tar.xz -C /opt/ && \
    rm x86_64-unknown-linux-musl.tar.xz && \
    rustup target add x86_64-unknown-linux-musl

ENV PATH="/opt/x86_64-unknown-linux-musl/bin:$PATH" \
    LIBCLANG_PATH=/usr/lib/llvm-14/lib \
    CLANG_PATH=/usr/bin/clang-14 \
    CC_x86_64_unknown_linux_musl=x86_64-unknown-linux-musl-gcc \
    CXX_x86_64_unknown_linux_musl=x86_64-unknown-linux-musl-g++ \
    AR_x86_64_unknown_linux_musl=x86_64-unknown-linux-musl-ar \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=x86_64-unknown-linux-musl-gcc \
    CARGO_INCREMENTAL=0 \
    CARGO_NET_GIT_FETCH_WITH_CLI=true

ENV SSL_VER=1.1.1w
RUN wget https://www.openssl.org/source/openssl-$SSL_VER.tar.gz && \
    tar -xzf openssl-$SSL_VER.tar.gz && \
    cd openssl-$SSL_VER && \
    ./Configure no-shared no-async --prefix=/musl --openssldir=/musl/ssl linux-x86_64 && \
    make -j$(nproc) && \
    make install_sw && \
    cd .. && \
    rm -rf openssl-$SSL_VER*

ENV OPENSSL_DIR=/musl \
    OPENSSL_INCLUDE_DIR=/musl/include \
    OPENSSL_LIB_DIR=/musl/lib \
    PKG_CONFIG_ALLOW_CROSS=1 \
    RUSTFLAGS="-C target-feature=+crt-static -C link-arg=-static-libgcc"

WORKDIR /build
COPY . .

COPY --from=inspector-build /app/frontend/packages/inspector/dist ./frontend/packages/inspector/dist

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build -p sandbox-agent --release --target x86_64-unknown-linux-musl -j4 && \
    cp target/x86_64-unknown-linux-musl/release/sandbox-agent /sandbox-agent

# ============================================================================
# Runtime - Foundry base sandbox image
# ============================================================================
FROM --platform=linux/amd64 node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# --- System packages --------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    gnupg \
    neovim \
    sudo \
    unzip \
    wget \
    # Chromium and its runtime deps
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# --- GitHub CLI (gh) -------------------------------------------------------
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# --- Bun --------------------------------------------------------------------
RUN curl -fsSL https://bun.sh/install | bash \
    && mv /root/.bun/bin/bun /usr/local/bin/bun \
    && ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
    && rm -rf /root/.bun

# --- sandbox-agent binary (from local build) --------------------------------
COPY --from=builder /sandbox-agent /usr/local/bin/sandbox-agent
RUN chmod +x /usr/local/bin/sandbox-agent

# --- sandbox user with passwordless sudo ------------------------------------
RUN useradd -m -s /bin/bash sandbox \
    && echo "sandbox ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/sandbox \
    && chmod 0440 /etc/sudoers.d/sandbox

USER sandbox
WORKDIR /home/sandbox

# Point Chromium/Playwright at the system binary
ENV CHROME_PATH=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# --- Install all sandbox-agent agents + agent-browser -----------------------
RUN sandbox-agent install-agent --all
RUN sudo npm install -g agent-browser

EXPOSE 2468

ENTRYPOINT ["sandbox-agent"]
CMD ["server", "--host", "0.0.0.0", "--port", "2468"]
