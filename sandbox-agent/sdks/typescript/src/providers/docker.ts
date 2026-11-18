import Docker from "dockerode";
import getPort from "get-port";
import type { SandboxProvider } from "./types.ts";
import { DEFAULT_SANDBOX_AGENT_IMAGE } from "./shared.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_AGENT_PORT = 3000;

export interface DockerProviderOptions {
  image?: string;
  host?: string;
  agentPort?: number;
  env?: string[] | (() => string[] | Promise<string[]>);
  binds?: string[] | (() => string[] | Promise<string[]>);
  createContainerOptions?: Record<string, unknown>;
}

async function resolveValue<T>(value: T | (() => T | Promise<T>) | undefined, fallback: T): Promise<T> {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "function") {
    return await (value as () => T | Promise<T>)();
  }
  return value;
}

function extractMappedPort(
  inspect: { NetworkSettings?: { Ports?: Record<string, Array<{ HostPort?: string }> | null | undefined> } },
  containerPort: number,
): number {
  const hostPort = inspect.NetworkSettings?.Ports?.[`${containerPort}/tcp`]?.[0]?.HostPort;
  if (!hostPort) {
    throw new Error(`docker sandbox-agent port ${containerPort} is not published`);
  }
  return Number(hostPort);
}

export function docker(options: DockerProviderOptions = {}): SandboxProvider {
  const image = options.image ?? DEFAULT_SANDBOX_AGENT_IMAGE;
  const host = options.host ?? DEFAULT_HOST;
  const agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;
  const client = new Docker({ socketPath: "/var/run/docker.sock" });

  return {
    name: "docker",
    defaultCwd: "/home/sandbox",
    async create(): Promise<string> {
      const hostPort = await getPort();
      const env = await resolveValue(options.env, []);
      const binds = await resolveValue(options.binds, []);

      const container = await client.createContainer({
        Image: image,
        Cmd: ["server", "--no-token", "--host", "0.0.0.0", "--port", String(agentPort)],
        Env: env,
        ExposedPorts: { [`${agentPort}/tcp`]: {} },
        HostConfig: {
          AutoRemove: true,
          Binds: binds,
          PortBindings: {
            [`${agentPort}/tcp`]: [{ HostPort: String(hostPort) }],
          },
        },
        ...(options.createContainerOptions ?? {}),
      });

      await container.start();
      return container.id;
    },
    async destroy(sandboxId: string): Promise<void> {
      const container = client.getContainer(sandboxId);
      try {
        await container.stop({ t: 5 });
      } catch {}
      try {
        await container.remove({ force: true });
      } catch {}
    },
    async getUrl(sandboxId: string): Promise<string> {
      const container = client.getContainer(sandboxId);
      const hostPort = extractMappedPort(await container.inspect(), agentPort);
      return `http://${host}:${hostPort}`;
    },
  };
}
