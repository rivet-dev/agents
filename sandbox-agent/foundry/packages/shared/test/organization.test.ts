import { describe, expect, it } from "vitest";
import { ConfigSchema, resolveOrganizationId, type AppConfig } from "../src/index.js";

const cfg: AppConfig = ConfigSchema.parse({
  auto_submit: true,
  notify: ["terminal"],
  organization: { default: "team-a" },
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
});

describe("resolveOrganizationId", () => {
  it("prefers explicit flag", () => {
    expect(resolveOrganizationId("feature", cfg)).toBe("feature");
  });

  it("falls back to config default", () => {
    expect(resolveOrganizationId(undefined, cfg)).toBe("team-a");
  });

  it("falls back to literal default when config value is empty", () => {
    const empty = {
      ...cfg,
      organization: { default: "" },
    } as AppConfig;

    expect(resolveOrganizationId(undefined, empty)).toBe("default");
  });
});
