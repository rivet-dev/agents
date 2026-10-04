import { SandboxAgent } from "sandbox-agent";
import { daytona } from "sandbox-agent/daytona";

function collectEnvVars(): Record<string, string> {
  const envVars: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return envVars;
}

function inspectorUrlToBaseUrl(inspectorUrl: string): string {
  return inspectorUrl.replace(/\/ui\/$/, "");
}

export async function setupDaytonaSandboxAgent(): Promise<{
  baseUrl: string;
  token?: string;
  extraHeaders?: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  const client = await SandboxAgent.start({
    sandbox: daytona({
      create: { envVars: collectEnvVars() },
    }),
  });

  return {
    baseUrl: inspectorUrlToBaseUrl(client.inspectorUrl),
    cleanup: async () => {
      await client.killSandbox();
    },
  };
}
