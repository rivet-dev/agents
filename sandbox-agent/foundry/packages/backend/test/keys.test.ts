import { describe, expect, it } from "vitest";
import { auditLogKey, githubDataKey, organizationKey, taskKey, taskSandboxKey } from "../src/actors/keys.js";

describe("actor keys", () => {
  it("prefixes every key with organization namespace", () => {
    const keys = [
      organizationKey("default"),
      taskKey("default", "repo", "task"),
      taskSandboxKey("default", "sbx"),
      auditLogKey("default"),
      githubDataKey("default"),
    ];

    for (const key of keys) {
      expect(key[0]).toBe("org");
      expect(key[1]).toBe("default");
    }
  });
});
