import { SandboxAgent } from "sandbox-agent";
import { vercel } from "sandbox-agent/vercel";

function collectEnvVars(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return env;
}

function inspectorUrlToBaseUrl(inspectorUrl: string): string {
  return inspectorUrl.replace(/\/ui\/$/, "");
}

export async function setupVercelSandboxAgent(): Promise<{
  baseUrl: string;
  token?: string;
  cleanup: () => Promise<void>;
}> {
  const client = await SandboxAgent.start({
    sandbox: vercel({
      create: {
        runtime: "node24",
        env: collectEnvVars(),
      },
    }),
  });

  return {
    baseUrl: inspectorUrlToBaseUrl(client.inspectorUrl),
    cleanup: async () => {
      await client.killSandbox();
    },
  };
}
