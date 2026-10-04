import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_EDITOR_TEMPLATE = ["# Enter task task details below.", "# Lines starting with # are ignored.", ""].join("\n");

export function sanitizeEditorTask(input: string): string {
  return input
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .trim();
}

export function openEditorForTask(): string {
  const editor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || "vi";
  const tempDir = mkdtempSync(join(tmpdir(), "hf-task-"));
  const taskPath = join(tempDir, "task.md");

  try {
    writeFileSync(taskPath, DEFAULT_EDITOR_TEMPLATE, "utf8");
    const result = spawnSync(editor, [taskPath], { stdio: "inherit" });

    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(`Editor exited with status ${result.status ?? "unknown"}`);
    }

    const raw = readFileSync(taskPath, "utf8");
    const task = sanitizeEditorTask(raw);
    if (!task) {
      throw new Error("Missing task task text");
    }
    return task;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
