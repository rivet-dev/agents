/**
 * Tests for OpenCode-compatible provider/model listing.
 */

import { describe, it, expect, beforeAll, afterEach, beforeEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible Model API", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    handle = await spawnSandboxAgent({ opencodeCompat: true });
    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  it("should list models grouped by agent with real model IDs", async () => {
    const response = await client.provider.list();
    const providers = response.data?.all ?? [];
    const mockProvider = providers.find((entry) => entry.id === "mock");
    const ampProvider = providers.find((entry) => entry.id === "amp");
    const piProvider = providers.find((entry) => entry.id === "pi");
    const sandboxProvider = providers.find((entry) => entry.id === "sandbox-agent");
    expect(sandboxProvider).toBeUndefined();
    expect(mockProvider).toBeDefined();
    expect(ampProvider).toBeDefined();
    expect(piProvider).toBeDefined();

    const mockModels = mockProvider?.models ?? {};
    expect(mockModels["mock"]).toBeDefined();
    expect(mockModels["mock"].id).toBe("mock");
    expect(mockModels["mock"].family).toBe("Mock");

    const ampModels = ampProvider?.models ?? {};
    expect(ampModels["amp-default"]).toBeDefined();
    expect(ampModels["amp-default"].id).toBe("amp-default");
    expect(ampModels["amp-default"].family).toBe("Amp");

    expect(response.data?.default?.["mock"]).toBe("mock");
    expect(response.data?.default?.["amp"]).toBe("amp-default");
  });

  it("should keep provider backends visible when discovery is degraded", async () => {
    const response = await client.provider.list();
    const providers = response.data?.all ?? [];
    const providerIds = new Set(providers.map((provider) => provider.id));

    expect(providerIds.has("claude")).toBe(true);
    expect(providerIds.has("codex")).toBe(true);
    expect(providerIds.has("pi")).toBe(true);
    expect(providerIds.has("opencode") || Array.from(providerIds).some((id) => id.startsWith("opencode:"))).toBe(true);
  });
});
