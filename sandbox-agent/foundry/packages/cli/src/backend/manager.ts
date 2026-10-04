import * as childProcess from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBackendHealth } from "@sandbox-agent/foundry-client";
import type { AppConfig } from "@sandbox-agent/foundry-shared";
import { CLI_BUILD_ID } from "../build-id.js";
import { logger } from "../logging.js";

const HEALTH_TIMEOUT_MS = 1_500;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function sanitizeHost(host: string): string {
  return host
    .split("")
    .map((ch) => (/[a-zA-Z0-9]/.test(ch) ? ch : "-"))
    .join("");
}

function backendStateDir(): string {
  const override = process.env.HF_BACKEND_STATE_DIR?.trim();
  if (override) {
    return override;
  }

  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return join(xdgDataHome, "foundry", "backend");
  }

  return join(homedir(), ".local", "share", "foundry", "backend");
}

function backendPidPath(host: string, port: number): string {
  return join(backendStateDir(), `backend-${sanitizeHost(host)}-${port}.pid`);
}

function backendVersionPath(host: string, port: number): string {
  return join(backendStateDir(), `backend-${sanitizeHost(host)}-${port}.version`);
}

function backendLogPath(host: string, port: number): string {
  return join(backendStateDir(), `backend-${sanitizeHost(host)}-${port}.log`);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function readPid(host: string, port: number): number | null {
  const raw = readText(backendPidPath(host, port));
  if (!raw) {
    return null;
  }

  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return pid;
}

function writePid(host: string, port: number, pid: number): void {
  const path = backendPidPath(host, port);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(pid), "utf8");
}

function removePid(host: string, port: number): void {
  const path = backendPidPath(host, port);
  if (existsSync(path)) {
    rmSync(path);
  }
}

function readBackendVersion(host: string, port: number): string | null {
  return readText(backendVersionPath(host, port));
}

function writeBackendVersion(host: string, port: number, buildId: string): void {
  const path = backendVersionPath(host, port);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildId, "utf8");
}

function removeBackendVersion(host: string, port: number): void {
  const path = backendVersionPath(host, port);
  if (existsSync(path)) {
    rmSync(path);
  }
}

function readCliBuildId(): string {
  const override = process.env.HF_BUILD_ID?.trim();
  if (override) {
    return override;
  }

  return CLI_BUILD_ID;
}

function isVersionCurrent(host: string, port: number): boolean {
  return readBackendVersion(host, port) === readCliBuildId();
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function removeStateFiles(host: string, port: number): void {
  removePid(host, port);
  removeBackendVersion(host, port);
}

async function checkHealth(host: string, port: number): Promise<boolean> {
  return await checkBackendHealth({
    endpoint: `http://${host}:${port}/v1/rivet`,
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
}

async function waitForHealth(host: string, port: number, timeoutMs: number, pid?: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (pid && !isProcessRunning(pid)) {
      throw new Error(`backend process ${pid} exited before becoming healthy`);
    }

    if (await checkHealth(host, port)) {
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`backend did not become healthy within ${timeoutMs}ms`);
}

async function waitForChildPid(child: childProcess.ChildProcess): Promise<number | null> {
  if (child.pid && child.pid > 0) {
    return child.pid;
  }

  for (let i = 0; i < 20; i += 1) {
    await sleep(50);
    if (child.pid && child.pid > 0) {
      return child.pid;
    }
  }

  return null;
}

interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
}

function resolveBunCommand(): string {
  const override = process.env.HF_BUN?.trim();
  if (override && (override === "bun" || existsSync(override))) {
    return override;
  }

  const homeBun = join(homedir(), ".bun", "bin", "bun");
  if (existsSync(homeBun)) {
    return homeBun;
  }

  return "bun";
}

function resolveLaunchSpec(host: string, port: number): LaunchSpec {
  const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const backendEntry = resolve(fileURLToPath(new URL("../../backend/dist/index.js", import.meta.url)));

  if (existsSync(backendEntry)) {
    return {
      command: resolveBunCommand(),
      args: [backendEntry, "start", "--host", host, "--port", String(port)],
      cwd: repoRoot,
    };
  }

  return {
    command: "pnpm",
    args: ["--filter", "@sandbox-agent/foundry-backend", "exec", "bun", "src/index.ts", "start", "--host", host, "--port", String(port)],
    cwd: repoRoot,
  };
}

async function startBackend(host: string, port: number): Promise<void> {
  if (await checkHealth(host, port)) {
    return;
  }

  const existingPid = readPid(host, port);
  if (existingPid && isProcessRunning(existingPid)) {
    await waitForHealth(host, port, START_TIMEOUT_MS, existingPid);
    return;
  }

  if (existingPid) {
    removeStateFiles(host, port);
  }

  const logPath = backendLogPath(host, port);
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");

  const launch = resolveLaunchSpec(host, port);
  const child = childProcess.spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });

  child.on("error", (error) => {
    logger.error(
      {
        host,
        port,
        command: launch.command,
        args: launch.args,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      "failed_to_launch_backend",
    );
  });

  child.unref();
  closeSync(fd);

  const pid = await waitForChildPid(child);

  writeBackendVersion(host, port, readCliBuildId());
  if (pid) {
    writePid(host, port, pid);
  }

  try {
    await waitForHealth(host, port, START_TIMEOUT_MS, pid ?? undefined);
  } catch (error) {
    if (pid) {
      removeStateFiles(host, port);
    } else {
      removeBackendVersion(host, port);
    }
    throw error;
  }
}

function trySignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function findProcessOnPort(port: number): number | null {
  try {
    const out = childProcess
      .execFileSync("lsof", ["-i", `:${port}`, "-t", "-sTCP:LISTEN"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();

    const pidRaw = out.split("\n")[0]?.trim();
    if (!pidRaw) {
      return null;
    }

    const pid = Number.parseInt(pidRaw, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }

    return pid;
  } catch {
    return null;
  }
}

export async function stopBackend(host: string, port: number): Promise<void> {
  let pid = readPid(host, port);

  if (!pid) {
    if (!(await checkHealth(host, port))) {
      removeStateFiles(host, port);
      return;
    }

    pid = findProcessOnPort(port);
    if (!pid) {
      throw new Error(`backend is healthy at ${host}:${port} but no PID could be resolved`);
    }
  }

  if (!isProcessRunning(pid)) {
    removeStateFiles(host, port);
    return;
  }

  trySignal(pid, "SIGTERM");

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      removeStateFiles(host, port);
      return;
    }
    await sleep(100);
  }

  trySignal(pid, "SIGKILL");
  removeStateFiles(host, port);
}

export interface BackendStatus {
  running: boolean;
  pid: number | null;
  version: string | null;
  versionCurrent: boolean;
  logPath: string;
}

export async function getBackendStatus(host: string, port: number): Promise<BackendStatus> {
  const logPath = backendLogPath(host, port);
  const pid = readPid(host, port);

  if (pid) {
    if (isProcessRunning(pid)) {
      return {
        running: true,
        pid,
        version: readBackendVersion(host, port),
        versionCurrent: isVersionCurrent(host, port),
        logPath,
      };
    }
    removeStateFiles(host, port);
  }

  if (await checkHealth(host, port)) {
    return {
      running: true,
      pid: null,
      version: readBackendVersion(host, port),
      versionCurrent: isVersionCurrent(host, port),
      logPath,
    };
  }

  return {
    running: false,
    pid: null,
    version: readBackendVersion(host, port),
    versionCurrent: false,
    logPath,
  };
}

export async function ensureBackendRunning(config: AppConfig): Promise<void> {
  const host = config.backend.host;
  const port = config.backend.port;

  if (await checkHealth(host, port)) {
    if (!isVersionCurrent(host, port)) {
      await stopBackend(host, port);
      await startBackend(host, port);
    }
    return;
  }

  const pid = readPid(host, port);
  if (pid && isProcessRunning(pid)) {
    try {
      await waitForHealth(host, port, START_TIMEOUT_MS, pid);
      if (!isVersionCurrent(host, port)) {
        await stopBackend(host, port);
        await startBackend(host, port);
      }
      return;
    } catch {
      await stopBackend(host, port);
      await startBackend(host, port);
      return;
    }
  }

  if (pid) {
    removeStateFiles(host, port);
  }

  await startBackend(host, port);
}

export function parseBackendPort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid backend port: ${value}`);
  }

  return port;
}
