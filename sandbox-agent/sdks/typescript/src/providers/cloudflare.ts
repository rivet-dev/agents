import type { SandboxProvider } from "./types.ts";

const DEFAULT_AGENT_PORT = 3000;

export interface CloudflareSandboxClient {
  create?(options?: Record<string, unknown>): Promise<{ id?: string; sandboxId?: string }>;
  connect?(
    sandboxId: string,
    options?: Record<string, unknown>,
  ): Promise<{
    close?(): Promise<void>;
    stop?(): Promise<void>;
    containerFetch(input: RequestInfo | URL, init?: RequestInit, port?: number): Promise<Response>;
  }>;
}

export interface CloudflareProviderOptions {
  sdk: CloudflareSandboxClient;
  create?: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>);
  agentPort?: number;
}

async function resolveCreateOptions(value: CloudflareProviderOptions["create"]): Promise<Record<string, unknown>> {
  if (!value) {
    return {};
  }
  if (typeof value === "function") {
    return await value();
  }
  return value;
}

export function cloudflare(options: CloudflareProviderOptions): SandboxProvider {
  const agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;
  const sdk = options.sdk;

  return {
    name: "cloudflare",
    defaultCwd: "/root",
    async create(): Promise<string> {
      if (typeof sdk.create !== "function") {
        throw new Error('sandbox provider "cloudflare" requires a sdk with a `create()` method.');
      }
      const sandbox = await sdk.create(await resolveCreateOptions(options.create));
      const sandboxId = sandbox.sandboxId ?? sandbox.id;
      if (!sandboxId) {
        throw new Error("cloudflare sandbox did not return an id");
      }
      return sandboxId;
    },
    async destroy(sandboxId: string): Promise<void> {
      if (typeof sdk.connect !== "function") {
        throw new Error('sandbox provider "cloudflare" requires a sdk with a `connect()` method.');
      }
      const sandbox = await sdk.connect(sandboxId);
      if (typeof sandbox.close === "function") {
        await sandbox.close();
        return;
      }
      if (typeof sandbox.stop === "function") {
        await sandbox.stop();
      }
    },
    async getFetch(sandboxId: string): Promise<typeof globalThis.fetch> {
      if (typeof sdk.connect !== "function") {
        throw new Error('sandbox provider "cloudflare" requires a sdk with a `connect()` method.');
      }
      const sandbox = await sdk.connect(sandboxId);
      return async (input, init) =>
        sandbox.containerFetch(
          input,
          {
            ...(init ?? {}),
            signal: undefined,
          },
          agentPort,
        );
    },
  };
}
