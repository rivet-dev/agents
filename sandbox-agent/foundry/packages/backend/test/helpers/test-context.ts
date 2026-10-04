import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type AppConfig } from "@sandbox-agent/foundry-shared";
import type { BackendDriver } from "../../src/driver.js";
import { initActorRuntimeContext } from "../../src/actors/context.js";
import { createDefaultAppShellServices } from "../../src/services/app-shell-runtime.js";

export function createTestConfig(overrides?: Partial<AppConfig>): AppConfig {
  return ConfigSchema.parse({
    auto_submit: true,
    notify: ["terminal" as const],
    organization: { default: "default" },
    backend: {
      host: "127.0.0.1",
      port: 7741,
      dbPath: join(tmpdir(), `hf-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`),
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

export function createTestRuntimeContext(driver: BackendDriver, configOverrides?: Partial<AppConfig>): { config: AppConfig } {
  const config = createTestConfig(configOverrides);
  initActorRuntimeContext(config, undefined, driver, createDefaultAppShellServices());
  return { config };
}
