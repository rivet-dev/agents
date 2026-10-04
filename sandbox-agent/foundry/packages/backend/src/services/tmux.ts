import { execFileSync, spawnSync } from "node:child_process";

const SYMBOL_RUNNING = "▶";
const SYMBOL_IDLE = "✓";

function stripStatusPrefix(windowName: string): string {
  return windowName
    .trimStart()
    .replace(new RegExp(`^${SYMBOL_RUNNING}\\s+`), "")
    .replace(new RegExp(`^${SYMBOL_IDLE}\\s+`), "")
    .trim();
}

export function setWindowStatus(branchName: string, status: string): number {
  let symbol: string;
  if (status === "running") {
    symbol = SYMBOL_RUNNING;
  } else if (status === "idle") {
    symbol = SYMBOL_IDLE;
  } else {
    return 0;
  }

  let stdout: string;
  try {
    stdout = execFileSync("tmux", ["list-windows", "-a", "-F", "#{session_name}:#{window_id}:#{window_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return 0;
  }

  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let count = 0;

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

    const newName = `${symbol} ${branchName}`;
    spawnSync("tmux", ["rename-window", "-t", `${sessionName}:${windowId}`, newName], {
      stdio: "ignore",
    });
    count += 1;
  }

  return count;
}
