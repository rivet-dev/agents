import { Sandbox } from "@vercel/sandbox";
import type { SandboxProvider } from "./types.ts";
import { DEFAULT_AGENTS, SANDBOX_AGENT_INSTALL_SCRIPT } from "./shared.ts";

const DEFAULT_AGENT_PORT = 3000;

export interface VercelProviderOptions {
  create?: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>);
  agentPort?: number;
}

async function resolveCreateOptions(value: VercelProviderOptions["create"], agentPort: number): Promise<Record<string, unknown>> {
  const resolved = typeof value === "function" ? await value() : (value ?? {});
  return {
    ports: [agentPort],
    ...resolved,
  };
}

async function runVercelCommand(sandbox: InstanceType<typeof Sandbox>, cmd: string, args: string[] = []): Promise<void> {
  const result = await sandbox.runCommand({ cmd, args });
  if (result.exitCode !== 0) {
    const stderr = await result.stderr();
    throw new Error(`vercel command failed: ${cmd} ${args.join(" ")}\n${stderr}`);
  }
}

export function vercel(options: VercelProviderOptions = {}): SandboxProvider {
  const agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;

  return {
    name: "vercel",
    defaultCwd: "/home/vercel-sandbox",
    async create(): Promise<string> {
      const sandbox = await Sandbox.create((await resolveCreateOptions(options.create, agentPort)) as Parameters<typeof Sandbox.create>[0]);

      await runVercelCommand(sandbox, "sh", ["-c", `curl -fsSL ${SANDBOX_AGENT_INSTALL_SCRIPT} | sh`]);
      for (const agent of DEFAULT_AGENTS) {
        await runVercelCommand(sandbox, "sandbox-agent", ["install-agent", agent]);
      }
      await sandbox.runCommand({
        cmd: "sandbox-agent",
        args: ["server", "--no-token", "--host", "0.0.0.0", "--port", String(agentPort)],
        detached: true,
      });

      return sandbox.sandboxId;
    },
    async destroy(sandboxId: string): Promise<void> {
      const sandbox = await Sandbox.get({ sandboxId });
      await sandbox.stop();
    },
    async getUrl(sandboxId: string): Promise<string> {
      const sandbox = await Sandbox.get({ sandboxId });
      return sandbox.domain(agentPort);
    },
    async ensureServer(sandboxId: string): Promise<void> {
      const sandbox = await Sandbox.get({ sandboxId });
      await sandbox.runCommand({
        cmd: "sandbox-agent",
        args: ["server", "--no-token", "--host", "0.0.0.0", "--port", String(agentPort)],
        detached: true,
      });
    },
  };
}
