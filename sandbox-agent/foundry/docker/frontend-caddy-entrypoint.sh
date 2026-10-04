#!/bin/sh
set -eu

escape_js() {
  printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

normalize_backend_endpoint() {
  case "${1:-}" in
    */api/rivet)
      printf '%s/v1/rivet' "${1%/api/rivet}"
      ;;
    *)
      printf '%s' "${1:-}"
      ;;
  esac
}

cat > /srv/__foundry_runtime_config.js <<EOF
window.__FOUNDRY_RUNTIME_CONFIG__ = {
  backendEndpoint: "$(escape_js "$(normalize_backend_endpoint "${VITE_HF_BACKEND_ENDPOINT:-}")")",
  defaultWorkspaceId: "$(escape_js "${VITE_HF_WORKSPACE:-}")",
  frontendClientMode: "$(escape_js "${FOUNDRY_FRONTEND_CLIENT_MODE:-remote}")"
};
EOF

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
