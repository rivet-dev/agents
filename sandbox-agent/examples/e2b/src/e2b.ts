import { SandboxAgent } from "sandbox-agent";
import { e2b } from "sandbox-agent/e2b";

function collectEnvVars(): Record<string, string> {
  const envs: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return envs;
}

function inspectorUrlToBaseUrl(inspectorUrl: string): string {
  return inspectorUrl.replace(/\/ui\/$/, "");
}

export async function setupE2BSandboxAgent(): Promise<{
  baseUrl: string;
  token?: string;
  cleanup: () => Promise<void>;
}> {
  const template = process.env.E2B_TEMPLATE;
  const client = await SandboxAgent.start({
    sandbox: e2b({
      template,
      create: { envs: collectEnvVars() },
    }),
  });

  return {
    baseUrl: inspectorUrlToBaseUrl(client.inspectorUrl),
    cleanup: async () => {
      await client.killSandbox();
    },
  };
}
