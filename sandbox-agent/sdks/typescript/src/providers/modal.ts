import { ModalClient, type Image, type SandboxCreateParams } from "modal";
import type { SandboxProvider } from "./types.ts";
import { DEFAULT_SANDBOX_AGENT_IMAGE } from "./shared.ts";

const DEFAULT_AGENT_PORT = 3000;
const DEFAULT_APP_NAME = "sandbox-agent";
const DEFAULT_MEMORY_MIB = 2048;

type ModalCreateOverrides = Omit<Partial<SandboxCreateParams>, "secrets" | "encryptedPorts"> & {
  secrets?: Record<string, string>;
  encryptedPorts?: number[];
  appName?: string;
};

export interface ModalProviderOptions {
  create?: ModalCreateOverrides | (() => ModalCreateOverrides | Promise<ModalCreateOverrides>);
  image?: string | Image;
  agentPort?: number;
}

async function resolveCreateOptions(value: ModalProviderOptions["create"]): Promise<ModalCreateOverrides> {
  if (!value) return {};
  return typeof value === "function" ? await value() : value;
}

export function modal(options: ModalProviderOptions = {}): SandboxProvider {
  const agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;
  const client = new ModalClient();

  return {
    name: "modal",
    defaultCwd: "/root",
    async create(): Promise<string> {
      const createOpts = await resolveCreateOptions(options.create);
      const appName = createOpts.appName ?? DEFAULT_APP_NAME;
      const baseImage = options.image ?? DEFAULT_SANDBOX_AGENT_IMAGE;
      const app = await client.apps.fromName(appName, { createIfMissing: true });

      // The default `-full` base image already includes sandbox-agent and all
      // agents pre-installed, so no additional dockerfile commands are needed.
      const image = typeof baseImage === "string" ? client.images.fromRegistry(baseImage) : baseImage;

      const envVars = createOpts.secrets ?? {};
      const secrets = Object.keys(envVars).length > 0 ? [await client.secrets.fromObject(envVars)] : [];
      const sandboxCreateOpts = { ...createOpts };
      delete sandboxCreateOpts.appName;
      delete sandboxCreateOpts.secrets;

      const extraPorts = createOpts.encryptedPorts ?? [];
      delete sandboxCreateOpts.encryptedPorts;

      const sb = await client.sandboxes.create(app, image, {
        ...sandboxCreateOpts,
        encryptedPorts: [agentPort, ...extraPorts],
        secrets,
        memoryMiB: sandboxCreateOpts.memoryMiB ?? DEFAULT_MEMORY_MIB,
      });

      // Start the server as a long-running exec process. We intentionally
      // do NOT await p.wait() — the process stays alive for the sandbox
      // lifetime and keeps the port open for the tunnel.
      sb.exec(["sandbox-agent", "server", "--no-token", "--host", "0.0.0.0", "--port", String(agentPort)]);

      return sb.sandboxId;
    },
    async destroy(sandboxId: string): Promise<void> {
      const sb = await client.sandboxes.fromId(sandboxId);
      await sb.terminate();
    },
    async getUrl(sandboxId: string): Promise<string> {
      const sb = await client.sandboxes.fromId(sandboxId);
      const tunnels = await sb.tunnels();
      const tunnel = tunnels[agentPort];
      if (!tunnel) {
        throw new Error(`modal: no tunnel found for port ${agentPort}`);
      }
      return tunnel.url;
    },
    async ensureServer(sandboxId: string): Promise<void> {
      const sb = await client.sandboxes.fromId(sandboxId);
      sb.exec(["sandbox-agent", "server", "--no-token", "--host", "0.0.0.0", "--port", String(agentPort)]);
    },
  };
}
