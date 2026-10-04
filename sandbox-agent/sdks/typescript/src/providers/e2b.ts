import { NotFoundError, Sandbox, type SandboxBetaCreateOpts, type SandboxConnectOpts } from "@e2b/code-interpreter";
import { SandboxDestroyedError } from "../client.ts";
import type { SandboxProvider } from "./types.ts";
import { DEFAULT_AGENTS, SANDBOX_AGENT_INSTALL_SCRIPT } from "./shared.ts";

const DEFAULT_AGENT_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 3_600_000;
const SANDBOX_AGENT_PATH_EXPORT = 'export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"';

type E2BCreateOverrides = Omit<Partial<SandboxBetaCreateOpts>, "timeoutMs" | "autoPause">;
type E2BConnectOverrides = Omit<Partial<SandboxConnectOpts>, "timeoutMs">;
type E2BTemplateOverride = string | (() => string | Promise<string>);

export interface E2BProviderOptions {
  create?: E2BCreateOverrides | (() => E2BCreateOverrides | Promise<E2BCreateOverrides>);
  connect?: E2BConnectOverrides | ((sandboxId: string) => E2BConnectOverrides | Promise<E2BConnectOverrides>);
  template?: E2BTemplateOverride;
  agentPort?: number;
  timeoutMs?: number;
  autoPause?: boolean;
}

async function resolveOptions(value: E2BProviderOptions["create"] | E2BProviderOptions["connect"], sandboxId?: string): Promise<Record<string, unknown>> {
  if (!value) return {};
  if (typeof value === "function") {
    if (sandboxId) {
      return await (value as (id: string) => Record<string, unknown> | Promise<Record<string, unknown>>)(sandboxId);
    }
    return await (value as () => Record<string, unknown> | Promise<Record<string, unknown>>)();
  }
  return value;
}

async function resolveTemplate(value: E2BTemplateOverride | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  return typeof value === "function" ? await value() : value;
}

function buildShellCommand(command: string, strict = false): string {
  const strictPrefix = strict ? "set -euo pipefail; " : "";
  return `bash -lc '${strictPrefix}${SANDBOX_AGENT_PATH_EXPORT}; ${command}'`;
}

export function e2b(options: E2BProviderOptions = {}): SandboxProvider {
  const agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const autoPause = options.autoPause ?? true;

  return {
    name: "e2b",
    defaultCwd: "/home/user",
    async create(): Promise<string> {
      const createOpts = await resolveOptions(options.create);
      const rawTemplate = typeof createOpts.template === "string" ? createOpts.template : undefined;
      const restCreateOpts = { ...createOpts };
      delete restCreateOpts.template;
      const template = (await resolveTemplate(options.template)) ?? rawTemplate;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sandbox = template
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await Sandbox.betaCreate(template, { allowInternetAccess: true, ...restCreateOpts, timeoutMs, autoPause } as any)
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await Sandbox.betaCreate({ allowInternetAccess: true, ...restCreateOpts, timeoutMs, autoPause } as any);

      await sandbox.commands.run(buildShellCommand(`curl -fsSL ${SANDBOX_AGENT_INSTALL_SCRIPT} | sh`, true)).then((r) => {
        if (r.exitCode !== 0) throw new Error(`e2b install failed:\n${r.stderr}`);
      });
      for (const agent of DEFAULT_AGENTS) {
        await sandbox.commands.run(buildShellCommand(`sandbox-agent install-agent ${agent}`)).then((r) => {
          if (r.exitCode !== 0) throw new Error(`e2b agent install failed: ${agent}\n${r.stderr}`);
        });
      }
      await sandbox.commands.run(buildShellCommand(`sandbox-agent server --no-token --host 0.0.0.0 --port ${agentPort}`), { background: true, timeoutMs: 0 });

      return sandbox.sandboxId;
    },
    async destroy(sandboxId: string): Promise<void> {
      await this.pause?.(sandboxId);
    },
    async reconnect(sandboxId: string): Promise<void> {
      const connectOpts = await resolveOptions(options.connect, sandboxId);
      try {
        await Sandbox.connect(sandboxId, { ...connectOpts, timeoutMs } as SandboxConnectOpts);
      } catch (error) {
        if (error instanceof NotFoundError) {
          throw new SandboxDestroyedError(sandboxId, "e2b", { cause: error });
        }
        throw error;
      }
    },
    async pause(sandboxId: string): Promise<void> {
      const connectOpts = await resolveOptions(options.connect, sandboxId);
      const sandbox = await Sandbox.connect(sandboxId, { ...connectOpts, timeoutMs } as SandboxConnectOpts);
      await sandbox.betaPause();
    },
    async kill(sandboxId: string): Promise<void> {
      const connectOpts = await resolveOptions(options.connect, sandboxId);
      const sandbox = await Sandbox.connect(sandboxId, { ...connectOpts, timeoutMs } as SandboxConnectOpts);
      await sandbox.kill();
    },
    async getUrl(sandboxId: string): Promise<string> {
      const connectOpts = await resolveOptions(options.connect, sandboxId);
      const sandbox = await Sandbox.connect(sandboxId, { ...connectOpts, timeoutMs } as SandboxConnectOpts);
      return `https://${sandbox.getHost(agentPort)}`;
    },
    async ensureServer(sandboxId: string): Promise<void> {
      const connectOpts = await resolveOptions(options.connect, sandboxId);
      const sandbox = await Sandbox.connect(sandboxId, { ...connectOpts, timeoutMs } as SandboxConnectOpts);
      await sandbox.commands.run(buildShellCommand(`sandbox-agent server --no-token --host 0.0.0.0 --port ${agentPort}`), { background: true, timeoutMs: 0 });
    },
  };
}
