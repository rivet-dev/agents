#!/bin/bash
set -euo pipefail

TARGET=${1:-x86_64-unknown-linux-musl}
VERSION=${2:-}

# Build arguments for Docker
BUILD_ARGS=""
if [ -n "$VERSION" ]; then
  BUILD_ARGS="--build-arg SANDBOX_AGENT_VERSION=$VERSION"
  echo "Building with version: $VERSION"
fi

case $TARGET in
  x86_64-unknown-linux-musl)
    echo "Building for Linux x86_64 musl"
    DOCKERFILE="linux-x86_64.Dockerfile"
    TARGET_STAGE="x86_64-builder"
    BINARY="sandbox-agent-$TARGET"
    GIGACODE="gigacode-$TARGET"
    ;;
  aarch64-unknown-linux-musl)
    echo "Building for Linux aarch64 musl"
    DOCKERFILE="linux-aarch64.Dockerfile"
    TARGET_STAGE="aarch64-builder"
    BINARY="sandbox-agent-$TARGET"
    GIGACODE="gigacode-$TARGET"
    ;;
  x86_64-pc-windows-gnu)
    echo "Building for Windows x86_64"
    DOCKERFILE="windows.Dockerfile"
    TARGET_STAGE=""
    BINARY="sandbox-agent-$TARGET.exe"
    GIGACODE="gigacode-$TARGET.exe"
    ;;
  x86_64-apple-darwin)
    echo "Building for macOS x86_64"
    DOCKERFILE="macos-x86_64.Dockerfile"
    TARGET_STAGE="x86_64-builder"
    BINARY="sandbox-agent-$TARGET"
    GIGACODE="gigacode-$TARGET"
    ;;
  aarch64-apple-darwin)
    echo "Building for macOS aarch64"
    DOCKERFILE="macos-aarch64.Dockerfile"
    TARGET_STAGE="aarch64-builder"
    BINARY="sandbox-agent-$TARGET"
    GIGACODE="gigacode-$TARGET"
    ;;
  *)
    echo "Unsupported target: $TARGET"
    exit 1
    ;;
 esac

DOCKER_BUILDKIT=1
if [ -n "$TARGET_STAGE" ]; then
  docker build --target "$TARGET_STAGE" $BUILD_ARGS -f "docker/release/$DOCKERFILE" -t "sandbox-agent-builder-$TARGET" .
else
  docker build $BUILD_ARGS -f "docker/release/$DOCKERFILE" -t "sandbox-agent-builder-$TARGET" .
fi

CONTAINER_ID=$(docker create "sandbox-agent-builder-$TARGET")
mkdir -p dist

docker cp "$CONTAINER_ID:/artifacts/$BINARY" "dist/"
docker cp "$CONTAINER_ID:/artifacts/$GIGACODE" "dist/"
docker rm "$CONTAINER_ID"

if [[ "$BINARY" != *.exe ]]; then
  chmod +x "dist/$BINARY"
  chmod +x "dist/$GIGACODE"
fi

echo "Binary saved to: dist/$BINARY"
echo "Binary saved to: dist/$GIGACODE"
