# Missing Features Index

Features selected for implementation from the v1-to-v1 gap analysis.

## Completely UNIMPLEMENTED in v1

| # | Feature | Implementation notes |
|---|---------|---------------------|
| 1 | ~~Questions~~ | Deferred to agent process side ([#156](https://github.com/rivet-dev/sandbox-agent/issues/156)) |
| 2 | ~~Event history/polling~~ | Not selected |
| 3 | ~~Turn stream~~ | Not selected |
| 4 | **Filesystem API** -- all 8 endpoints (list, read, write, delete, mkdir, move, stat, upload-batch). ACP only has text-only `fs/read_text_file` + `fs/write_text_file` (agent->client direction). | |
| 5 | **Health endpoint** -- typed `HealthResponse` with status. | |
| 6 | **Server status** -- `ServerStatus` (Running/Stopped/Error), `ServerStatusInfo` (baseUrl, lastError, restartCount, uptimeMs). | |
| 7 | **Session termination** -- v1 had full `terminate`. v1 only has `session/cancel` (turn cancellation, not session kill). No explicit close/delete. | See existing ACP RFD |
| 8 | ~~Model variants~~ -- deferred for now. | Out of scope |
| 9 | ~~Agent capability flags~~ | Not selected |
| 10 | ~~`include_raw`~~ -- deferred for now. | Out of scope |

## Downgraded / Partial in v1

| # | Feature | Implementation notes |
|---|---------|---------------------|
| 11 | ~~Permission reply granularity~~ | Not selected |
| 12 | **Agent listing** -- v1 `GET /v1/agents` returned typed `AgentListResponse` with `installed`, `credentialsAvailable`, `path`, `capabilities`, `serverStatus`. v1 returns generic JSON. | |
| 13 | **Models/modes listing** -- expose as optional `models`/`modes` fields on agent response payloads (installed agents only), lazily populated. | No separate `/models` or `/modes` endpoints |
| 14 | **Message attachments** -- v1 `MessageRequest.attachments` (path, mime, filename). v1 ACP `embeddedContext` is only partial. | |
| 15 | **Session creation richness** -- v1 `CreateSessionRequest` had `mcp` (full MCP server config with OAuth, env headers, bearer tokens), `skills` (sources with git refs), `agent_version`, `directory`. Most have no ACP equivalent. | Check with our extensions, do not implement if already done |
| 16 | **Session info** -- v1 `SessionInfo` tracked `event_count`, `created_at`, `updated_at`, full `mcp` config. Mostly lost. | Add as sessions HTTP endpoint |
| 17 | **Error termination metadata** -- v1 captured `exit_code`, structured `StderrOutput` (head/tail/truncated). Gone. | |
