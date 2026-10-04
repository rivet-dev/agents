import { describe, expect, it } from "vitest";
import { deriveFallbackTitle, resolveCreateFlowDecision, sanitizeBranchName } from "../src/services/create-flow.js";
import { BRANCH_NAME_PREFIXES } from "../src/services/branch-name-prefixes.js";

describe("create flow decision", () => {
  it("derives a conventional-style fallback title from task text", () => {
    const title = deriveFallbackTitle("Fix OAuth callback bug in handler");
    expect(title).toBe("fix: Fix OAuth callback bug in handler");
  });

  it("preserves an explicit conventional prefix without duplicating it", () => {
    const title = deriveFallbackTitle("Reply with exactly: READY", "feat: Browser UI Flow");
    expect(title).toBe("feat: Browser UI Flow");
  });

  it("sanitizes generated branch names", () => {
    expect(sanitizeBranchName("feat: Add @mentions & #hashtags")).toBe("feat-add-mentions-hashtags");
    expect(sanitizeBranchName("  spaces  everywhere  ")).toBe("spaces-everywhere");
  });

  it("generates a McMaster-Carr-style branch name with random suffix", () => {
    const resolved = resolveCreateFlowDecision({
      task: "Add auth",
      localBranches: [],
      taskBranches: [],
    });

    expect(resolved.title).toBe("feat: Add auth");
    // Branch name should be "<prefix>-<4-char-suffix>" where prefix is from BRANCH_NAME_PREFIXES
    const lastDash = resolved.branchName.lastIndexOf("-");
    const prefix = resolved.branchName.slice(0, lastDash);
    const suffix = resolved.branchName.slice(lastDash + 1);
    expect(BRANCH_NAME_PREFIXES).toContain(prefix);
    expect(suffix).toMatch(/^[a-z0-9]{4}$/);
  });

  it("avoids conflicts by generating a different random name", () => {
    // Even with a conflicting branch, it should produce something different
    const resolved = resolveCreateFlowDecision({
      task: "Add auth",
      localBranches: [],
      taskBranches: [],
    });

    // Running again with the first result as a conflict should produce a different name
    const resolved2 = resolveCreateFlowDecision({
      task: "Add auth",
      localBranches: [resolved.branchName],
      taskBranches: [],
    });

    expect(resolved2.branchName).not.toBe(resolved.branchName);
  });

  it("uses explicit branch name when provided", () => {
    const resolved = resolveCreateFlowDecision({
      task: "new task",
      explicitBranchName: "my-branch",
      localBranches: [],
      taskBranches: [],
    });

    expect(resolved.branchName).toBe("my-branch");
  });

  it("fails when explicit branch already exists", () => {
    expect(() =>
      resolveCreateFlowDecision({
        task: "new task",
        explicitBranchName: "existing-branch",
        localBranches: ["existing-branch"],
        taskBranches: [],
      }),
    ).toThrow("already exists");
  });
});
