import { describe, expect, it } from "vitest";
import { ConfigSchema, type AppConfig } from "@sandbox-agent/foundry-shared";
import { availableSandboxProviderIds, defaultSandboxProviderId, resolveSandboxProviderId } from "../src/sandbox-config.js";

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return ConfigSchema.parse({
    auto_submit: true,
    notify: ["terminal"],
    organization: { default: "default" },
    backend: {
      host: "127.0.0.1",
      port: 7741,
      dbPath: "~/.local/share/foundry/task.db",
      opencode_poll_interval: 2,
      github_poll_interval: 30,
      backup_interval_secs: 3600,
      backup_retention_days: 7,
    },
    sandboxProviders: {
      local: {},
      e2b: {},
    },
    ...overrides,
  });
}

describe("sandbox config", () => {
  it("defaults to local when e2b is not configured", () => {
    const config = makeConfig();
    expect(defaultSandboxProviderId(config)).toBe("local");
    expect(availableSandboxProviderIds(config)).toEqual(["local"]);
  });

  it("prefers e2b when an api key is configured", () => {
    const config = makeConfig({
      sandboxProviders: {
        local: {},
        e2b: { apiKey: "test-token" },
      },
    });
    expect(defaultSandboxProviderId(config)).toBe("e2b");
    expect(availableSandboxProviderIds(config)).toEqual(["e2b", "local"]);
    expect(resolveSandboxProviderId(config, "e2b")).toBe("e2b");
  });

  it("rejects selecting e2b without an api key", () => {
    const config = makeConfig();
    expect(() => resolveSandboxProviderId(config, "e2b")).toThrow("E2B provider is not configured");
  });
});
