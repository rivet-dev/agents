/**
 * Utilities for spawning sandbox-agent for OpenCode compatibility testing.
 * Mirrors the patterns from sdks/typescript/src/spawn.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo, type Server } from "node:net";
import { existsSync, mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SandboxAgentHandle {
  baseUrl: string;
  token: string;
  child: ChildProcess;
  dispose: () => Promise<void>;
}

/**
 * Find the sandbox-agent binary in common locations
 */
function findBinary(): string | null {
  // Check environment variable first
  if (process.env.SANDBOX_AGENT_BIN) {
    const path = process.env.SANDBOX_AGENT_BIN;
    if (existsSync(path)) {
      return path;
    }
  }

  // Check cargo build outputs (relative to tests/opencode-compat/helpers)
  const cargoPaths = [resolve(__dirname, "../../../../../../target/debug/sandbox-agent"), resolve(__dirname, "../../../../../../target/release/sandbox-agent")];

  for (const p of cargoPaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Get a free port on the given host
 */
async function getFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

/**
 * Wait for the server to become healthy
 */
async function waitForHealth(baseUrl: string, token: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const start = Date.now();
  let lastError: string | undefined;

  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error("sandbox-agent exited before becoming healthy");
    }

    try {
      const response = await fetch(`${baseUrl}/v1/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`Timed out waiting for sandbox-agent health (${lastError ?? "unknown"})`);
}

/**
 * Wait for child process to exit
 */
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) {
    return true;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export interface SpawnOptions {
  host?: string;
  port?: number;
  token?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Enable OpenCode compatibility mode */
  opencodeCompat?: boolean;
}

/**
 * Spawn a sandbox-agent instance for testing.
 * Each test should spawn its own instance on a unique port.
 */
export async function spawnSandboxAgent(options: SpawnOptions = {}): Promise<SandboxAgentHandle> {
  const binaryPath = findBinary();
  if (!binaryPath) {
    throw new Error("sandbox-agent binary not found. Run 'cargo build -p sandbox-agent' first or set SANDBOX_AGENT_BIN.");
  }

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? (await getFreePort(host));
  const token = options.token ?? randomBytes(24).toString("hex");
  const timeoutMs = options.timeoutMs ?? 30_000;

  const args = ["server", "--host", host, "--port", String(port), "--token", token];
  const tempStateDir = mkdtempSync(join(tmpdir(), "sandbox-agent-opencode-"));
  const sqlitePath = join(tempStateDir, "opencode-sessions.db");

  const compatEnv = {
    OPENCODE_COMPAT_FIXED_TIME_MS: "1700000000000",
    OPENCODE_COMPAT_DIRECTORY: "/workspace",
    OPENCODE_COMPAT_WORKTREE: "/workspace",
    OPENCODE_COMPAT_HOME: "/home/opencode",
    OPENCODE_COMPAT_STATE: "/state/opencode",
    OPENCODE_COMPAT_CONFIG: "/config/opencode",
    OPENCODE_COMPAT_BRANCH: "main",
    OPENCODE_COMPAT_DB_PATH: sqlitePath,
  };

  const child = spawn(binaryPath, args, {
    stdio: "pipe",
    env: {
      ...process.env,
      ...compatEnv,
      ...(options.env ?? {}),
    },
  });

  // Collect stderr for debugging
  let stderr = "";
  const logFile = process.env.SANDBOX_AGENT_TEST_LOG_FILE;
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    if (logFile) appendFileSync(logFile, `[stderr] ${text}`);
    if (process.env.SANDBOX_AGENT_TEST_LOGS) {
      process.stderr.write(text);
    }
  });
  child.stdout?.on("data", (chunk) => {
    if (logFile) appendFileSync(logFile, `[stdout] ${chunk.toString()}`);
    if (process.env.SANDBOX_AGENT_TEST_LOGS) {
      process.stderr.write(chunk.toString());
    }
  });

  const baseUrl = `http://${host}:${port}`;

  try {
    await waitForHealth(baseUrl, token, timeoutMs, child);
  } catch (err) {
    child.kill("SIGKILL");
    if (stderr) {
      throw new Error(`${err}. Stderr: ${stderr}`);
    }
    throw err;
  }

  const dispose = async () => {
    if (child.exitCode !== null) {
      rmSync(tempStateDir, { recursive: true, force: true });
      return;
    }
    child.kill("SIGTERM");
    const exited = await waitForExit(child, 5_000);
    if (!exited) {
      child.kill("SIGKILL");
    }
    rmSync(tempStateDir, { recursive: true, force: true });
  };

  return { baseUrl, token, child, dispose };
}

/**
 * Build the sandbox-agent binary if it doesn't exist
 */
export async function buildSandboxAgent(): Promise<void> {
  const binaryPath = findBinary();
  if (binaryPath) {
    console.log(`sandbox-agent binary found at: ${binaryPath}`);
    return;
  }

  console.log("Building sandbox-agent...");
  const projectRoot = resolve(__dirname, "../../../../../..");

  return new Promise((resolve, reject) => {
    const proc = spawn("cargo", ["build", "-p", "sandbox-agent"], {
      cwd: projectRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        SANDBOX_AGENT_SKIP_INSPECTOR: "1",
      },
    });

    proc.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`cargo build failed with code ${code}`));
      }
    });

    proc.on("error", reject);
  });
}
