# @sandbox-agent/mock-acp-agent

Minimal newline-delimited ACP JSON-RPC mock agent.

Behavior:
- Echoes every inbound message as `mock/echo` notification.
- For requests (`method` + `id`), returns `result.echoed` payload.
- For `mock/ask_client`, emits an agent-initiated `mock/request` before response.
- For responses from client (`id` without `method`), emits `mock/client_response` notification.
