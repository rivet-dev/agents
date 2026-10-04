import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const SYMBOL_RUNNING = "▶";
const SYMBOL_IDLE = "✓";
const DEFAULT_OPENCODE_ENDPOINT = "http://127.0.0.1:4097/opencode";

export interface TmuxWindowMatch {
  target: string;
  windowName: string;
}

export interface SpawnCreateTmuxWindowInput {
  branchName: string;
  targetPath: string;
  sessionId?: string | null;
  opencodeEndpoint?: string;
}

export interface SpawnCreateTmuxWindowResult {
  created: boolean;
  reason: "created" | "not-in-tmux" | "not-local-path" | "window-exists" | "tmux-new-window-failed";
}

function isTmuxSession(): boolean {
  return Boolean(process.env.TMUX);
}

function isAbsoluteLocalPath(path: string): boolean {
  return path.startsWith("/");
}

function runTmux(args: string[]): boolean {
  const result = spawnSync("tmux", args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function shellEscape(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function opencodeExistsOnPath(): boolean {
  const probe = spawnSync("which", ["opencode"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

function resolveOpencodeBinary(): string {
  const envOverride = process.env.HF_OPENCODE_BIN?.trim();
  if (envOverride) {
    return envOverride;
  }

  if (opencodeExistsOnPath()) {
    return "opencode";
  }

  const bundledCandidates = [`${homedir()}/.local/share/sandbox-agent/bin/opencode`, `${homedir()}/.opencode/bin/opencode`];

  for (const candidate of bundledCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return "opencode";
}

function attachCommand(sessionId: string, targetPath: string, endpoint: string): string {
  const opencode = resolveOpencodeBinary();
  return [shellEscape(opencode), "attach", shellEscape(endpoint), "--session", shellEscape(sessionId), "--dir", shellEscape(targetPath)].join(" ");
}

export function stripStatusPrefix(windowName: string): string {
  return windowName
    .trimStart()
    .replace(new RegExp(`^${SYMBOL_RUNNING}\\s+`), "")
    .replace(new RegExp(`^${SYMBOL_IDLE}\\s+`), "")
    .trim();
}

export function findTmuxWindowsByBranch(branchName: string): TmuxWindowMatch[] {
  const output = spawnSync("tmux", ["list-windows", "-a", "-F", "#{session_name}:#{window_id}:#{window_name}"], { encoding: "utf8" });

  if (output.error || output.status !== 0 || !output.stdout) {
    return [];
  }

  const lines = output.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const matches: TmuxWindowMatch[] = [];

  for (const line of lines) {
    const parts = line.split(":", 3);
    if (parts.length !== 3) {
      continue;
    }

    const sessionName = parts[0] ?? "";
    const windowId = parts[1] ?? "";
    const windowName = parts[2] ?? "";
    const clean = stripStatusPrefix(windowName);
    if (clean !== branchName) {
      continue;
    }

    matches.push({
      target: `${sessionName}:${windowId}`,
      windowName,
    });
  }

  return matches;
}

export function spawnCreateTmuxWindow(input: SpawnCreateTmuxWindowInput): SpawnCreateTmuxWindowResult {
  if (!isTmuxSession()) {
    return { created: false, reason: "not-in-tmux" };
  }

  if (!isAbsoluteLocalPath(input.targetPath)) {
    return { created: false, reason: "not-local-path" };
  }

  if (findTmuxWindowsByBranch(input.branchName).length > 0) {
    return { created: false, reason: "window-exists" };
  }

  const windowName = input.sessionId ? `${SYMBOL_RUNNING} ${input.branchName}` : input.branchName;
  const endpoint = input.opencodeEndpoint ?? DEFAULT_OPENCODE_ENDPOINT;
  let output = "";
  try {
    output = execFileSync("tmux", ["new-window", "-d", "-P", "-F", "#{window_id}", "-n", windowName, "-c", input.targetPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return { created: false, reason: "tmux-new-window-failed" };
  }

  const windowId = output.trim();
  if (!windowId) {
    return { created: false, reason: "tmux-new-window-failed" };
  }

  if (input.sessionId) {
    const leftPane = `${windowId}.0`;

    // Split left pane horizontally → creates right pane; capture its pane ID
    let rightPane: string;
    try {
      rightPane = execFileSync("tmux", ["split-window", "-h", "-P", "-F", "#{pane_id}", "-t", leftPane, "-c", input.targetPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      return { created: true, reason: "created" };
    }

    if (!rightPane) {
      return { created: true, reason: "created" };
    }

    // Split right pane vertically → top-right (rightPane) + bottom-right (new)
    runTmux(["split-window", "-v", "-t", rightPane, "-c", input.targetPath]);

    // Left pane 60% width, top-right pane 70% height
    runTmux(["resize-pane", "-t", leftPane, "-x", "60%"]);
    runTmux(["resize-pane", "-t", rightPane, "-y", "70%"]);

    // Editor in left pane, agent attach in top-right pane
    runTmux(["send-keys", "-t", leftPane, "nvim .", "Enter"]);
    runTmux(["send-keys", "-t", rightPane, attachCommand(input.sessionId, input.targetPath, endpoint), "Enter"]);
    runTmux(["select-pane", "-t", rightPane]);
  }

  return { created: true, reason: "created" };
}
