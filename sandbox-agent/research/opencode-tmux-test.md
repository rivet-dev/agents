# OpenCode TUI Test Plan (Tmux)

This plan captures OpenCode TUI output and sends input via tmux so we can validate `/opencode` end-to-end.

## Prereqs
- `opencode` installed and on PATH.
- `tmux` installed (e.g., `/home/linuxbrew/.linuxbrew/bin/tmux`).
- Local sandbox-agent binary built.

## Environment
- `SANDBOX_AGENT_LOG_DIR=/path` to set server log dir
- `SANDBOX_AGENT_LOG_TO_FILE=1` to redirect logs to files
- `SANDBOX_AGENT_LOG_STDOUT=1` to force logs on stdout/stderr
- `SANDBOX_AGENT_LOG_HTTP=0` to disable request logs
- `SANDBOX_AGENT_LOG_HTTP_HEADERS=1` to include request headers (Authorization redacted)
- `RUST_LOG=...` for trace filtering

## Steps
1. Build and run the server using the local binary:
   ```bash
   SANDBOX_AGENT_SKIP_INSPECTOR=1 cargo build -p sandbox-agent
   SANDBOX_AGENT_LOG_HTTP_HEADERS=1 ./target/debug/sandbox-agent server \
     --host 127.0.0.1 --port 2468 --token "$TOKEN"
   ```
2. Create a session via the OpenCode API:
   ```bash
   SESSION_JSON=$(curl -sS -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{}' \
     http://127.0.0.1:2468/opencode/session)
   SESSION_ID=$(node -e "const v=JSON.parse(process.env.SESSION_JSON||'{}');process.stdout.write(v.id||'');")
   ```
3. Start the OpenCode TUI in tmux:
   ```bash
   tmux new-session -d -s opencode \
     "opencode attach http://127.0.0.1:2468/opencode --session $SESSION_ID --password $TOKEN"
   ```
4. Send a prompt:
   ```bash
   tmux send-keys -t opencode:0.0 "hello" C-m
   ```
5. Capture output:
   ```bash
   tmux capture-pane -pt opencode:0.0 -S -200 > /tmp/opencode-screen.txt
   ```
6. Inspect server logs for requests (when log-to-file is enabled):
   ```bash
   tail -n 200 ~/.local/share/sandbox-agent/logs/log-$(date +%m-%d-%y)
   ```
7. Repeat after adjusting `/opencode` stubs until the TUI displays responses.

## Notes
- Tmux captures terminal output only. GUI outputs require screenshots or logs.
- If OpenCode connects to another host/port, logs will show no requests.
- If the prompt stays in the input box, use `C-m` to submit (plain `Enter` may not trigger send in tmux).
