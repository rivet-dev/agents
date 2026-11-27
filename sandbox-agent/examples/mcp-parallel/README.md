# Parallel Search MCP configuration and smoke test

Store a named Parallel Search MCP configuration through the Sandbox Agent SDK,
reload it, and check `web_search` and `web_fetch` over Streamable HTTP. The
[anonymous endpoint](https://docs.parallel.ai/integrations/mcp/search-mcp)
is free for light use without a Parallel API key and has lower rate limits than
authenticated access. This example needs no model credentials, starts no agent
session, and does not verify agent tool dispatch.

## Run

Install Node.js 20+, pnpm 9+, and
[Sandbox Agent](https://sandboxagent.dev/docs/quickstart). From `sandbox-agent/`
in this checkout, install and build the SDK and example dependencies:

```sh
pnpm --filter @sandbox-agent/example-mcp-parallel... install --frozen-lockfile
SKIP_OPENAPI_GEN=1 pnpm --filter sandbox-agent build
```

Start a local server in another terminal:

```sh
sandbox-agent server --no-token --host 127.0.0.1 --port 2468
```

Run the example from `sandbox-agent/`, specifying an absolute directory on the
server for its saved configuration:

```sh
pnpm --filter @sandbox-agent/example-mcp-parallel start http://127.0.0.1:2468 /tmp/parallel-mcp-example
```

For a server that requires a token, set `SANDBOX_TOKEN`. The example stores only
the `parallel-search` entry, reuses an identical entry, and refuses to overwrite
a different one. Other MCP entries and agent defaults remain unchanged. It
prints search excerpts and fetched content from Rivet's documentation, then
disconnects. Network errors and rate limits cause a nonzero exit.

The entry remains in the server directory's `.sandbox-agent/config/mcp.json`.
The smoke test uses the SDK's `getMcpConfig` result as its connection settings;
storing an entry alone does not attach it to a running agent session. For session
setup, see the existing [MCP example](../mcp/src/index.ts).

To remove the example entry from the local server:

```sh
curl --fail -X DELETE 'http://127.0.0.1:2468/v1/config/mcp?directory=/tmp/parallel-mcp-example&mcpName=parallel-search'
```
