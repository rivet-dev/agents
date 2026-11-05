import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthMethod } from "acp-http-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxAgent } from "../src/index.ts";
import { local } from "../src/providers/local.ts";
import { prepareMockAgentDataHome } from "./helpers/mock-agent.ts";

describe("adapter authentication over the real server", () => {
  let sdk: SandboxAgent | undefined;
  let dataHome: string | undefined;

  afterEach(async () => {
    await sdk?.destroySandbox();
    if (dataHome) await rm(dataHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    sdk = undefined;
    dataHome = undefined;
  });

  async function start(
    agent: Parameters<typeof prepareMockAgentDataHome>[1],
    authentication?: NonNullable<Parameters<typeof SandboxAgent.start>[0]["authentication"]>,
  ) {
    dataHome = mkdtempSync(join(tmpdir(), "sandbox-agent-auth-"));
    const env = prepareMockAgentDataHome(dataHome, agent);
    sdk = await SandboxAgent.start({ sandbox: local({ env, log: "pipe", token: "test-server-token" }), authentication });
    return sdk;
  }

  it("selects an advertised method not in the legacy hard-coded list", async () => {
    const selectMethod = vi.fn(async (_agent: string, methods: readonly AuthMethod[]) => ({ methodId: methods[0].id }));
    const client = await start({ methodId: "api-key" }, { selectMethod });

    const session = await client.createSession({ agent: "mock" });

    expect(session.agent).toBe("mock");
    expect(selectMethod).toHaveBeenCalledWith("mock", [{ id: "api-key", name: "Test authentication" }]);
    await client.createSession({ agent: "mock" });
    expect(selectMethod).toHaveBeenCalledOnce();
  });

  it("advertises gateway capabilities and sends the selected method metadata", async () => {
    const selectMethod = vi.fn((_agent: string, methods: readonly AuthMethod[]) => ({
      methodId: methods[0].id,
      _meta: { gateway: { baseUrl: "https://gateway.example.com", headers: { Authorization: "Bearer test-gateway-token" } } },
    }));
    const client = await start(
      { methodId: "gateway", gateway: true },
      {
        clientCapabilities: { auth: { _meta: { gateway: true } } },
        selectMethod,
      },
    );

    const session = await client.createSession({ agent: "mock" });

    expect(session.agent).toBe("mock");
    expect(selectMethod).toHaveBeenCalledWith("mock", [{ id: "gateway", name: "Test authentication" }]);
  });

  it("surfaces a selected method's authentication failure", async () => {
    const client = await start(
      { methodId: "api-key", reject: true },
      {
        selectMethod: () => ({ methodId: "api-key" }),
      },
    );

    await expect(client.createSession({ agent: "mock" })).rejects.toThrow("Test authentication rejected");
  });

  it("preserves automatic authentication when no selector is supplied", async () => {
    const client = await start({ methodId: "anthropic-api-key" });

    const session = await client.createSession({ agent: "mock" });

    expect(session.agent).toBe("mock");
  });

  it("allows a selector to skip authentication without falling back to a legacy method", async () => {
    const client = await start({ methodId: "anthropic-api-key" }, { selectMethod: () => undefined });

    await expect(client.createSession({ agent: "mock" })).rejects.toThrow("Authentication required");
  });

  it("preserves an error thrown by an application's selector", async () => {
    const failure = new Error("Application authentication unavailable");
    const client = await start(
      { methodId: "api-key" },
      {
        selectMethod: () => {
          throw failure;
        },
      },
    );

    await expect(client.createSession({ agent: "mock" })).rejects.toBe(failure);
  });

  it("uses the same selection options when connecting to an existing server", async () => {
    const owner = await start({ methodId: "api-key" });
    const client = await SandboxAgent.connect({
      baseUrl: new URL(owner.inspectorUrl).origin,
      token: "test-server-token",
      authentication: { selectMethod: (_agent, methods) => ({ methodId: methods[0].id }) },
    });
    try {
      const session = await client.createSession({ agent: "mock" });
      expect(session.agent).toBe("mock");
    } finally {
      await client.dispose();
    }
  });
});
