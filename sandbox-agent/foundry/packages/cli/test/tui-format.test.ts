import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@sandbox-agent/foundry-shared";
import { filterTasks, fuzzyMatch } from "@sandbox-agent/foundry-client";
import { formatRows } from "../src/tui.js";

const sample = {
  organizationId: "default",
  repoId: "repo-a",
  repoRemote: "https://example.com/repo-a.git",
  taskId: "task-1",
  branchName: "feature/test",
  title: "Test Title",
  task: "Do test",
  sandboxProviderId: "local",
  status: "running",
  activeSandboxId: "sandbox-1",
  pullRequest: null,
  sandboxes: [
    {
      sandboxId: "sandbox-1",
      sandboxProviderId: "local",
      sandboxActorId: null,
      switchTarget: "sandbox://local/sandbox-1",
      cwd: null,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  createdAt: 1,
  updatedAt: 1,
} satisfies TaskRecord & { pullRequest: null; activeSessionId?: null };

describe("formatRows", () => {
  it("renders rust-style table header and empty state", () => {
    const output = formatRows([], 0, "default", "ok");
    expect(output).toContain("Branch/PR (type to filter)");
    expect(output).toContain("No branches found.");
    expect(output).toContain("Ctrl-H:cheatsheet");
    expect(output).toContain("ok");
  });

  it("marks selected row with highlight", () => {
    const output = formatRows([sample], 0, "default", "ready");
    expect(output).toContain("┃ ");
    expect(output).toContain("Test Title");
    expect(output).toContain("Ctrl-H:cheatsheet");
  });

  it("pins footer to the last terminal row", () => {
    const output = formatRows([sample], 0, "default", "ready", "", false, {
      width: 80,
      height: 12,
    });
    const lines = output.split("\n");
    expect(lines).toHaveLength(12);
    expect(lines[11]).toContain("Ctrl-H:cheatsheet");
    expect(lines[11]).toContain("v");
  });
});

describe("search", () => {
  it("supports ordered fuzzy matching", () => {
    expect(fuzzyMatch("feature/test-branch", "ftb")).toBe(true);
    expect(fuzzyMatch("feature/test-branch", "fbt")).toBe(false);
  });

  it("filters rows across branch and title", () => {
    const rows: TaskRecord[] = [
      sample,
      {
        ...sample,
        taskId: "task-2",
        branchName: "docs/update-intro",
        title: "Docs Intro Refresh",
        status: "idle",
      },
    ];
    expect(filterTasks(rows, "doc")).toHaveLength(1);
    expect(filterTasks(rows, "h2")).toHaveLength(1);
    expect(filterTasks(rows, "test")).toHaveLength(2);
  });
});
