import { describe, expect, it } from "vitest";
import { ConfigSchema } from "@sandbox-agent/foundry-shared";
import { resolveOrganization } from "../src/organization/config.js";

describe("cli organization resolution", () => {
  it("uses default organization when no flag", () => {
    const config = ConfigSchema.parse({
      auto_submit: true as const,
      notify: ["terminal" as const],
      organization: { default: "team" },
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

    expect(resolveOrganization(undefined, config)).toBe("team");
    expect(resolveOrganization("alpha", config)).toBe("alpha");
  });
});
