import { Daytona } from "@daytonaio/sdk";
import type { SandboxProvider } from "./types.ts";
import { DEFAULT_SANDBOX_AGENT_IMAGE, buildServerStartCommand } from "./shared.ts";

const DEFAULT_AGENT_PORT = 3000;
const DEFAULT_PREVIEW_TTL_SECONDS = 4 * 60 * 60;
const DEFAULT_CWD = "/home/sandbox";

type DaytonaCreateParams = NonNullable<Parameters<Daytona["create"]>[0]>;

type DaytonaCreateOverrides = Partial<DaytonaCreateParams>;

export interface DaytonaProviderOptions {
  create?: DaytonaCreateOverrides | (() => DaytonaCreateOverrides | Promise<DaytonaCreateOverrides>);
  image?: DaytonaCreateParams["image"];
  agentPort?: number;
  cwd?: string;
  previewTtlSeconds?: number;
  deleteTimeoutSeconds?: number;
}

async function resolveCreateOptions(value: DaytonaProviderOptions["create"]): Promise<DaytonaCreateOverrides | undefined> {
  if (!value) return undefined;
  if (typeof value === "function") return await value();
  return value;
}

export function daytona(options: DaytonaProviderOptions = {}): SandboxProvider {
  const agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;
  const image = options.image ?? DEFAULT_SANDBOX_AGENT_IMAGE;
  const cwd = options.cwd ?? DEFAULT_CWD;
  const previewTtlSeconds = options.previewTtlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS;
  const client = new Daytona();

  return {
    name: "daytona",
    defaultCwd: cwd,
    async create(): Promise<string> {
      const createOpts = await resolveCreateOptions(options.create);
      const sandbox = await client.create({
        image,
        autoStopInterval: 0,
        ...createOpts,
      } as DaytonaCreateParams);
      await sandbox.process.executeCommand(buildServerStartCommand(agentPort));
      return sandbox.id;
    },
    async destroy(sandboxId: string): Promise<void> {
      const sandbox = await client.get(sandboxId);
      if (!sandbox) {
        return;
      }
      await sandbox.delete(options.deleteTimeoutSeconds);
    },
    async getUrl(sandboxId: string): Promise<string> {
      const sandbox = await client.get(sandboxId);
      if (!sandbox) {
        throw new Error(`daytona sandbox not found: ${sandboxId}`);
      }
      const preview = await sandbox.getSignedPreviewUrl(agentPort, previewTtlSeconds);
      return typeof preview === "string" ? preview : preview.url;
    },
    async ensureServer(sandboxId: string): Promise<void> {
      const sandbox = await client.get(sandboxId);
      if (!sandbox) {
        throw new Error(`daytona sandbox not found: ${sandboxId}`);
      }
      await sandbox.process.executeCommand(buildServerStartCommand(agentPort));
    },
  };
}
