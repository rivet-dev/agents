import { describe, expect, it } from "vitest";
import { TaskStatusSchema } from "@sandbox-agent/foundry-shared";
import { defaultTaskStatusMessage, deriveHeaderStatus, describeTaskState, isProvisioningTaskStatus, resolveTaskStateDetail } from "./status";

describe("defaultTaskStatusMessage", () => {
  it("covers every backend task status", () => {
    for (const status of TaskStatusSchema.options) {
      expect(defaultTaskStatusMessage(status)).toMatch(/\S/);
    }
  });

  it("returns the expected copy for init_ensure_name", () => {
    expect(defaultTaskStatusMessage("init_ensure_name")).toBe("Determining title and branch.");
  });
});

describe("resolveTaskStateDetail", () => {
  it("returns the default copy for the current task status", () => {
    expect(resolveTaskStateDetail("init_complete")).toBe("Finalizing task initialization.");
  });
});

describe("describeTaskState", () => {
  it("includes the raw backend status code in the title", () => {
    expect(describeTaskState("kill_destroy_sandbox")).toEqual({
      title: "Task state: kill_destroy_sandbox",
      detail: "Destroying sandbox resources.",
    });
  });
});

describe("isProvisioningTaskStatus", () => {
  it("treats in-progress init states as provisioning", () => {
    expect(isProvisioningTaskStatus("init_bootstrap_db")).toBe(true);
    expect(isProvisioningTaskStatus("init_ensure_name")).toBe(true);
  });

  it("does not treat init_complete as provisioning (task is ready)", () => {
    expect(isProvisioningTaskStatus("init_complete")).toBe(false);
  });

  it("does not treat steady-state or terminal states as provisioning", () => {
    expect(isProvisioningTaskStatus("running")).toBe(false);
    expect(isProvisioningTaskStatus("archived")).toBe(false);
    expect(isProvisioningTaskStatus("killed")).toBe(false);
  });
});

describe("deriveHeaderStatus", () => {
  it("returns error variant when session has error", () => {
    const result = deriveHeaderStatus("running", "error", "Sandbox crashed");
    expect(result.variant).toBe("error");
    expect(result.label).toBe("Session error");
    expect(result.tooltip).toBe("Sandbox crashed");
    expect(result.spinning).toBe(false);
  });

  it("returns error variant when task has error", () => {
    const result = deriveHeaderStatus("error", null, null);
    expect(result.variant).toBe("error");
    expect(result.label).toBe("Error");
    expect(result.spinning).toBe(false);
  });

  it("returns warning variant with spinner for provisioning task", () => {
    const result = deriveHeaderStatus("init_enqueue_provision", null, null);
    expect(result.variant).toBe("warning");
    expect(result.label).toBe("Provisioning");
    expect(result.spinning).toBe(true);
  });

  it("returns warning variant for pending_provision session", () => {
    const result = deriveHeaderStatus("running", "pending_provision", null);
    expect(result.variant).toBe("warning");
    expect(result.label).toBe("Provisioning");
    expect(result.spinning).toBe(true);
  });

  it("returns warning variant for pending_session_create session", () => {
    const result = deriveHeaderStatus("running", "pending_session_create", null);
    expect(result.variant).toBe("warning");
    expect(result.label).toBe("Creating session");
    expect(result.spinning).toBe(true);
  });

  it("returns success variant with spinner for running session", () => {
    const result = deriveHeaderStatus("running", "running", null);
    expect(result.variant).toBe("success");
    expect(result.label).toBe("Running");
    expect(result.spinning).toBe(true);
  });

  it("returns success variant for idle/ready state", () => {
    const result = deriveHeaderStatus("idle", "idle", null);
    expect(result.variant).toBe("success");
    expect(result.label).toBe("Ready");
    expect(result.spinning).toBe(false);
  });

  it("returns neutral variant for archived task", () => {
    const result = deriveHeaderStatus("archived", null, null);
    expect(result.variant).toBe("neutral");
    expect(result.label).toBe("Archived");
  });

  it("session error takes priority over task error", () => {
    const result = deriveHeaderStatus("error", "error", "Sandbox OOM");
    expect(result.variant).toBe("error");
    expect(result.label).toBe("Session error");
    expect(result.tooltip).toBe("Sandbox OOM");
  });

  it("returns warning when no sandbox is available", () => {
    const result = deriveHeaderStatus("idle", "idle", null, false);
    expect(result.variant).toBe("warning");
    expect(result.label).toBe("No sandbox");
    expect(result.spinning).toBe(false);
  });

  it("still shows provisioning when no sandbox but task is provisioning", () => {
    const result = deriveHeaderStatus("init_enqueue_provision", null, null, false);
    expect(result.variant).toBe("warning");
    expect(result.label).toBe("Provisioning");
    expect(result.spinning).toBe(true);
  });

  it("shows error over no-sandbox when session has error", () => {
    const result = deriveHeaderStatus("idle", "error", "Connection lost", false);
    expect(result.variant).toBe("error");
    expect(result.label).toBe("Session error");
  });
});
