import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@sandbox-agent/foundry-shared";
import { filterTasks, formatRelativeAge, fuzzyMatch, summarizeTasks } from "../src/view-model.js";

const sample: TaskRecord = {
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
};

describe("search helpers", () => {
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
    expect(filterTasks(rows, "intro")).toHaveLength(1);
    expect(filterTasks(rows, "test")).toHaveLength(2);
  });
});

describe("summary helpers", () => {
  it("formats relative age", () => {
    expect(formatRelativeAge(9_000, 10_000)).toBe("1s");
    expect(formatRelativeAge(0, 120_000)).toBe("2m");
  });

  it("summarizes by status and provider", () => {
    const rows: TaskRecord[] = [
      sample,
      { ...sample, taskId: "task-2", status: "idle", sandboxProviderId: "local" },
      { ...sample, taskId: "task-3", status: "error", sandboxProviderId: "local" },
    ];

    const summary = summarizeTasks(rows);
    expect(summary.total).toBe(3);
    expect(summary.byStatus.running).toBe(1);
    expect(summary.byStatus.idle).toBe(1);
    expect(summary.byStatus.error).toBe(1);
    expect(summary.byProvider.local).toBe(3);
  });
});
