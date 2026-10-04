# OpenCode Web Customization & Local Run Notes

## Local Web UI (pointing at `/opencode`)

This uses the OpenCode web app from `~/misc/opencode/packages/app` and points it at the
Sandbox Agent OpenCode-compatible API. The OpenCode JS SDK emits **absolute** paths
(`"/global/event"`, `"/session/:id/message"`, etc.), so any base URL path is discarded.
To keep the UI working, sandbox-agent now exposes the OpenCode router at both
`/opencode/*` and the root (`/global/*`, `/session/*`, ...).

### 1) Start sandbox-agent (OpenCode compat)

```bash
cd /home/nathan/sandbox-agent.feat-opencode-compat
SANDBOX_AGENT_SKIP_INSPECTOR=1 SANDBOX_AGENT_LOG_STDOUT=1 \
  ./target/debug/sandbox-agent server --no-token --host 127.0.0.1 --port 2468 \
  --cors-allow-origin http://127.0.0.1:5173 \
  > /tmp/sandbox-agent-opencode.log 2>&1 &
```

Logs:

```bash
tail -f /tmp/sandbox-agent-opencode.log
```

### 2) Start OpenCode web app (dev)

```bash
cd /home/nathan/misc/opencode/packages/app
VITE_OPENCODE_SERVER_HOST=127.0.0.1 VITE_OPENCODE_SERVER_PORT=2468 \
  /home/nathan/.bun/bin/bun run dev -- --host 127.0.0.1 --port 5173 \
  > /tmp/opencode-web.log 2>&1 &
```

Logs:

```bash
tail -f /tmp/opencode-web.log
```

### 3) Open the UI

```
http://127.0.0.1:5173/
```

The app should connect to `http://127.0.0.1:2468` by default in dev (via
`VITE_OPENCODE_SERVER_HOST/PORT`). If you see a “Could not connect to server”
error, verify the sandbox-agent process is running and reachable on port 2468.

### Notes

- The web UI uses `VITE_OPENCODE_SERVER_HOST` and `VITE_OPENCODE_SERVER_PORT` to
  pick the OpenCode server in dev mode (see `packages/app/src/app.tsx`).
- When running in production, the app defaults to `window.location.origin` for
  the server URL. If you need a different target, you must configure it via the
  in-app “Switch server” dialog or change the build config.
- If you see a connect error in the web app, check CORS. By default, sandbox-agent
  allows no origins. You must pass `--cors-allow-origin` for the dev server URL.
- The OpenCode provider list now exposes a `sandbox-agent` provider with models
  for each agent (defaulting to `mock`). Use the provider/model selector in the UI
  to pick the backing agent instead of environment variables.

## Dev Server Learnings (Feb 4, 2026)

- The browser **cannot** reach `http://127.0.0.1:2468` unless the web UI is on the
  same machine. If the UI is loaded from `http://100.94.102.49:5173`, the server
  must be reachable at `http://100.94.102.49:2468`.
- The OpenCode JS SDK uses absolute paths, so a base URL path (like
  `http://host:port/opencode`) is ignored. This means the server must expose
  OpenCode routes at the **root** (`/global/*`, `/session/*`, ...), even if it
  also exposes them under `/opencode/*`.
- CORS must allow the UI origin. Example:
  ```bash
  ./target/debug/sandbox-agent server --no-token --host 0.0.0.0 --port 2468 \
    --cors-allow-origin http://100.94.102.49:5173
  ```
- Binding the dev servers to `0.0.0.0` is required for remote access. Verify
  `ss -ltnp | grep ':2468'` and `ss -ltnp | grep ':5173'`.
- If the UI throws “No default model found”, it usually means the `/provider`
  response lacks a providerID → modelID default mapping for a connected provider.
