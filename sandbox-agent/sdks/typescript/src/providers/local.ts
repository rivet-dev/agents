import { spawnSandboxAgent, type SandboxAgentSpawnHandle, type SandboxAgentSpawnLogMode, type SandboxAgentSpawnOptions } from "../spawn.ts";
import type { SandboxProvider } from "./types.ts";

export interface LocalProviderOptions {
  host?: string;
  port?: number;
  token?: string;
  binaryPath?: string;
  log?: SandboxAgentSpawnLogMode;
  env?: Record<string, string>;
}

const localSandboxes = new Map<string, SandboxAgentSpawnHandle>();

type LocalSandboxProvider = SandboxProvider & {
  getToken(sandboxId: string): Promise<string | undefined>;
};

export function local(options: LocalProviderOptions = {}): SandboxProvider {
  const provider: LocalSandboxProvider = {
    name: "local",
    async create(): Promise<string> {
      const handle = await spawnSandboxAgent(
        {
          host: options.host,
          port: options.port,
          token: options.token,
          binaryPath: options.binaryPath,
          log: options.log,
          env: options.env,
        } satisfies SandboxAgentSpawnOptions,
        globalThis.fetch?.bind(globalThis),
      );

      const rawSandboxId = baseUrlToSandboxId(handle.baseUrl);
      localSandboxes.set(rawSandboxId, handle);
      return rawSandboxId;
    },
    async destroy(sandboxId: string): Promise<void> {
      const handle = localSandboxes.get(sandboxId);
      if (!handle) {
        return;
      }
      localSandboxes.delete(sandboxId);
      await handle.dispose();
    },
    async getUrl(sandboxId: string): Promise<string> {
      return `http://${sandboxId}`;
    },
    async getFetch(sandboxId: string): Promise<typeof globalThis.fetch> {
      const handle = localSandboxes.get(sandboxId);
      const token = options.token ?? handle?.token;
      const fetcher = globalThis.fetch?.bind(globalThis);
      if (!fetcher) {
        throw new Error("Fetch API is not available; provide a fetch implementation.");
      }

      if (!token) {
        return fetcher;
      }

      return async (input, init) => {
        const request = new Request(input, init);
        const targetUrl = new URL(request.url);
        targetUrl.protocol = "http:";
        targetUrl.host = sandboxId;
        const headers = new Headers(request.headers);
        if (!headers.has("authorization")) {
          headers.set("authorization", `Bearer ${token}`);
        }
        const forwarded = new Request(targetUrl.toString(), request);
        return fetcher(new Request(forwarded, { headers }));
      };
    },
    async getToken(sandboxId: string): Promise<string | undefined> {
      return options.token ?? localSandboxes.get(sandboxId)?.token;
    },
  };
  return provider;
}

function baseUrlToSandboxId(baseUrl: string): string {
  return new URL(baseUrl).host;
}
