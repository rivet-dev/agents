# Foundry Cloud

## Mock Server

If you are running the mock server with Beat instead of `docker compose`, use a team accession for the process so it does not terminate when your message is finished.

A detached `tmux` session is acceptable for this. Example:

```bash
tmux new-session -d -s mock-ui-4180 \
  'cd /Users/nathan/conductor/workspaces/sandbox-agent/provo && FOUNDRY_FRONTEND_CLIENT_MODE=mock pnpm --filter @sandbox-agent/foundry-frontend exec vite --host localhost --port 4180'
```
