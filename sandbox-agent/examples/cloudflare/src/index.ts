import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { runPromptEndpointStream, type PromptRequest } from "./prompt-endpoint";

export { Sandbox } from "@cloudflare/sandbox";

type Bindings = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  CODEX_API_KEY?: string;
};

type AppEnv = { Bindings: Bindings };

const PORT = 8000;

/** Check if sandbox-agent is already running by probing its health endpoint */
async function isServerRunning(sandbox: Sandbox): Promise<boolean> {
  try {
    const result = await sandbox.exec(`curl -sf http://localhost:${PORT}/v1/health`);
    return result.success;
  } catch {
    return false;
  }
}

async function getReadySandbox(name: string, env: Bindings): Promise<Sandbox> {
  const sandbox = getSandbox(env.Sandbox, name);
  const envVars: Record<string, string> = {};
  if (env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = env.OPENAI_API_KEY;
  if (env.CODEX_API_KEY) envVars.CODEX_API_KEY = env.CODEX_API_KEY;
  if (!envVars.CODEX_API_KEY && envVars.OPENAI_API_KEY) envVars.CODEX_API_KEY = envVars.OPENAI_API_KEY;
  await sandbox.setEnvVars(envVars);

  if (!(await isServerRunning(sandbox))) {
    await sandbox.startProcess(`sandbox-agent server --no-token --host 0.0.0.0 --port ${PORT}`);

    for (let i = 0; i < 30; i++) {
      if (await isServerRunning(sandbox)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return sandbox;
}

async function proxyToSandbox(sandbox: Sandbox, request: Request, path: string): Promise<Response> {
  const query = new URL(request.url).search;
  return sandbox.containerFetch(
    `http://localhost${path}${query}`,
    {
      method: request.method,
      headers: request.headers,
      body: request.body,
    },
    PORT,
  );
}

const app = new Hono<AppEnv>();

app.onError((error) => {
  return new Response(String(error), { status: 500 });
});

app.post("/sandbox/:name/prompt", async (c) => {
  if (!(c.req.header("content-type") ?? "").includes("application/json")) {
    throw new HTTPException(400, { message: "Content-Type must be application/json" });
  }

  let payload: PromptRequest;
  try {
    payload = await c.req.json<PromptRequest>();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const sandbox = await getReadySandbox(c.req.param("name"), c.env);
  return streamSSE(c, async (stream) => {
    try {
      await runPromptEndpointStream(sandbox, payload, PORT, async (event) => {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
      });
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ ok: true }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message }),
      });
    }
  });
});

app.all("/sandbox/:name/proxy/*", async (c) => {
  const sandbox = await getReadySandbox(c.req.param("name"), c.env);
  const wildcard = c.req.param("*");
  const path = wildcard ? `/${wildcard}` : "/";
  return proxyToSandbox(sandbox, c.req.raw, path);
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
