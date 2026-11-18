#!/usr/bin/env bash
#
# Build and push the Foundry base sandbox image to Docker Hub.
#
# Usage:
#   ./foundry/scripts/publish-foundry-base.sh          # build + push
#   ./foundry/scripts/publish-foundry-base.sh --dry-run # build only, no push
#
# Prerequisites:
#   - docker login to Docker Hub (rivetdev org)
#   - Docker buildx available (ships with Docker Desktop / modern Docker)
#
# The image is tagged:
#   rivetdev/sandbox-agent:foundry-base-<YYYYMMDD>T<HHMMSS>Z
#   rivetdev/sandbox-agent:foundry-base-latest
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="rivetdev/sandbox-agent"
TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
TAG_DATED="${IMAGE}:foundry-base-${TIMESTAMP}"
TAG_LATEST="${IMAGE}:foundry-base-latest"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

echo "==> Building ${TAG_DATED}"
echo "    (also tagged ${TAG_LATEST})"
echo "    Platform: linux/amd64"
echo ""

docker build \
  --platform linux/amd64 \
  -f "${REPO_ROOT}/foundry/docker/foundry-base.Dockerfile" \
  -t "${TAG_DATED}" \
  -t "${TAG_LATEST}" \
  "${REPO_ROOT}"

echo ""
echo "==> Build complete"
echo "    ${TAG_DATED}"
echo "    ${TAG_LATEST}"

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "==> Dry run — skipping push"
  exit 0
fi

echo ""
echo "==> Pushing ${TAG_DATED}"
docker push "${TAG_DATED}"

echo "==> Pushing ${TAG_LATEST}"
docker push "${TAG_LATEST}"

echo ""
echo "==> Done"
echo "    ${TAG_DATED}"
