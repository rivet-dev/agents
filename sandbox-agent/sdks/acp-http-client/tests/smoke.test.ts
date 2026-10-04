import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { AcpHttpClient, type SessionNotification } from "../src/index.ts";
import { spawnSandboxAgent, type SandboxAgentSpawnHandle } from "../../typescript/src/spawn.ts";
import { prepareMockAgentDataHome } from "../../typescript/tests/helpers/mock-agent.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findBinary(): string | null {
  if (process.env.SANDBOX_AGENT_BIN) {
    return process.env.SANDBOX_AGENT_BIN;
  }

  const cargoPaths = [resolve(__dirname, "../../../target/debug/sandbox-agent"), resolve(__dirname, "../../../target/release/sandbox-agent")];

  for (const p of cargoPaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return null;
}

const BINARY_PATH = findBinary();
if (!BINARY_PATH) {
  throw new Error("sandbox-agent binary not found. Build it (cargo build -p sandbox-agent) or set SANDBOX_AGENT_BIN.");
}
if (!process.env.SANDBOX_AGENT_BIN) {
  process.env.SANDBOX_AGENT_BIN = BINARY_PATH;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 5000, stepMs = 25): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value !== undefined && value !== null) {
      return value;
    }
    await sleep(stepMs);
  }
  throw new Error("timed out waiting for condition");
}

describe("AcpHttpClient integration", () => {
  let handle: SandboxAgentSpawnHandle;
  let baseUrl: string;
  let token: string;
  let dataHome: string;

  beforeAll(async () => {
    dataHome = mkdtempSync(join(tmpdir(), "acp-http-client-"));
    prepareMockAgentDataHome(dataHome);

    handle = await spawnSandboxAgent({
      enabled: true,
      log: "silent",
      timeoutMs: 30000,
      env: {
        XDG_DATA_HOME: dataHome,
        HOME: dataHome,
        USERPROFILE: dataHome,
        APPDATA: join(dataHome, "AppData", "Roaming"),
        LOCALAPPDATA: join(dataHome, "AppData", "Local"),
      },
    });
    baseUrl = handle.baseUrl;
    token = handle.token;
  });

  afterAll(async () => {
    await handle.dispose();
    rmSync(dataHome, { recursive: true, force: true });
  });

  it("runs initialize/newSession/prompt against real /v1/acp/{server_id}", async () => {
    const updates: SessionNotification[] = [];
    const serverId = `acp-http-client-${Date.now().toString(36)}`;

    const client = new AcpHttpClient({
      baseUrl,
      token,
      transport: {
        path: `/v1/acp/${encodeURIComponent(serverId)}`,
        bootstrapQuery: { agent: "mock" },
      },
      client: {
        sessionUpdate: async (notification) => {
          updates.push(notification);
        },
      },
    });

    const initialize = await client.initialize();
    expect(initialize.protocolVersion).toBeTruthy();

    const session = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    expect(session.sessionId).toBeTruthy();

    const prompt = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "acp package integration" }],
    });
    expect(prompt.stopReason).toBe("end_turn");

    await waitFor(() => {
      const text = updates
        .flatMap((entry) => {
          if (entry.update.sessionUpdate !== "agent_message_chunk") {
            return [];
          }
          const content = entry.update.content;
          if (content.type !== "text") {
            return [];
          }
          return [content.text];
        })
        .join("");
      return text.includes("mock: acp package integration") ? text : undefined;
    });

    await client.disconnect();
  });

  it("answers session/request_permission while session/prompt is still in flight", async () => {
    const permissionRequests: Array<{ sessionId: string; title?: string | null }> = [];
    const serverId = `acp-http-client-permissions-${Date.now().toString(36)}`;

    const client = new AcpHttpClient({
      baseUrl,
      token,
      transport: {
        path: `/v1/acp/${encodeURIComponent(serverId)}`,
        bootstrapQuery: { agent: "mock" },
      },
      client: {
        requestPermission: async (request) => {
          permissionRequests.push({
            sessionId: request.sessionId,
            title: request.toolCall.title,
          });
          return {
            outcome: {
              outcome: "selected",
              optionId: "reject-once",
            },
          };
        },
      },
    });

    await client.initialize();

    const session = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    const prompt = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "please trigger permission" }],
    });

    expect(prompt.stopReason).toBe("end_turn");
    expect(permissionRequests).toEqual([
      {
        sessionId: session.sessionId,
        title: "Write mock.txt",
      },
    ]);

    await client.disconnect();
  });
});
