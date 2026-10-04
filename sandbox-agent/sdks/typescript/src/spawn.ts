import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { assertExecutable, formatNonExecutableBinaryMessage } from "@sandbox-agent/cli-shared";

export type SandboxAgentSpawnLogMode = "inherit" | "pipe" | "silent";

export type SandboxAgentSpawnOptions = {
  enabled?: boolean;
  host?: string;
  port?: number;
  token?: string;
  binaryPath?: string;
  timeoutMs?: number;
  log?: SandboxAgentSpawnLogMode;
  env?: Record<string, string>;
};

export type SandboxAgentSpawnHandle = {
  baseUrl: string;
  token: string;
  child: ChildProcess;
  dispose: () => Promise<void>;
};

const PLATFORM_PACKAGES: Record<string, string> = {
  "darwin-arm64": "@sandbox-agent/cli-darwin-arm64",
  "darwin-x64": "@sandbox-agent/cli-darwin-x64",
  "linux-x64": "@sandbox-agent/cli-linux-x64",
  "linux-arm64": "@sandbox-agent/cli-linux-arm64",
  "win32-x64": "@sandbox-agent/cli-win32-x64",
};

const TRUST_PACKAGES =
  "@sandbox-agent/cli-linux-x64 @sandbox-agent/cli-linux-arm64 @sandbox-agent/cli-darwin-arm64 @sandbox-agent/cli-darwin-x64 @sandbox-agent/cli-win32-x64";

export function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

export async function spawnSandboxAgent(options: SandboxAgentSpawnOptions, fetcher?: typeof fetch): Promise<SandboxAgentSpawnHandle> {
  if (!isNodeRuntime()) {
    throw new Error("Autospawn requires a Node.js runtime.");
  }

  const { spawn } = await import("node:child_process");
  const crypto = await import("node:crypto");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const net = await import("node:net");
  const { createRequire } = await import("node:module");

  const bindHost = options.host ?? "127.0.0.1";
  const port = options.port ?? (await getFreePort(net, bindHost));
  const connectHost = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
  const token = options.token ?? crypto.randomBytes(24).toString("hex");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const logMode: SandboxAgentSpawnLogMode = options.log ?? "inherit";

  const binaryPath =
    options.binaryPath ??
    resolveBinaryFromEnv(fs, path) ??
    resolveBinaryFromCliPackage(createRequire(import.meta.url), path, fs) ??
    resolveBinaryFromPath(fs, path);

  if (!binaryPath) {
    throw new Error("sandbox-agent binary not found. Install @sandbox-agent/cli or set SANDBOX_AGENT_BIN.");
  }

  if (!assertExecutable(binaryPath, fs)) {
    throw new Error(
      formatNonExecutableBinaryMessage({
        binPath: binaryPath,
        trustPackages: TRUST_PACKAGES,
        bunInstallBlocks: [
          {
            label: "Project install",
            commands: [`bun pm trust ${TRUST_PACKAGES}`, "bun add sandbox-agent"],
          },
          {
            label: "Global install",
            commands: [`bun pm -g trust ${TRUST_PACKAGES}`, "bun add -g sandbox-agent"],
          },
        ],
      }),
    );
  }

  const stdio = logMode === "inherit" ? "inherit" : logMode === "silent" ? "ignore" : "pipe";
  const args = ["server", "--host", bindHost, "--port", String(port), "--token", token];
  const child = spawn(binaryPath, args, {
    stdio,
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
  });
  const cleanup = registerProcessCleanup(child);

  const baseUrl = `http://${connectHost}:${port}`;
  const ready = waitForHealth(baseUrl, fetcher ?? globalThis.fetch, timeoutMs, child, token);

  await ready;

  const dispose = async () => {
    if (child.exitCode !== null) {
      cleanup.dispose();
      return;
    }
    child.kill("SIGTERM");
    const exited = await waitForExit(child, 5_000);
    if (!exited) {
      child.kill("SIGKILL");
    }
    cleanup.dispose();
  };

  return { baseUrl, token, child, dispose };
}

function resolveBinaryFromEnv(fs: typeof import("node:fs"), path: typeof import("node:path")): string | null {
  const value = process.env.SANDBOX_AGENT_BIN;
  if (!value) {
    return null;
  }
  const resolved = path.resolve(value);
  if (fs.existsSync(resolved)) {
    return resolved;
  }
  return null;
}

function resolveBinaryFromCliPackage(
  require: ReturnType<typeof import("node:module").createRequire>,
  path: typeof import("node:path"),
  fs: typeof import("node:fs"),
): string | null {
  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  if (!pkg) {
    return null;
  }
  try {
    const pkgPath = require.resolve(`${pkg}/package.json`);
    const bin = process.platform === "win32" ? "sandbox-agent.exe" : "sandbox-agent";
    const resolved = path.join(path.dirname(pkgPath), "bin", bin);
    return fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function resolveBinaryFromPath(fs: typeof import("node:fs"), path: typeof import("node:path")): string | null {
  const pathEnv = process.env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const candidates = pathEnv.split(separator).filter(Boolean);
  const bin = process.platform === "win32" ? "sandbox-agent.exe" : "sandbox-agent";
  for (const dir of candidates) {
    const resolved = path.join(dir, bin);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

async function getFreePort(net: typeof import("node:net"), host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl: string, fetcher: typeof fetch | undefined, timeoutMs: number, child: ChildProcess, token: string): Promise<void> {
  if (!fetcher) {
    throw new Error("Fetch API is not available; provide a fetch implementation.");
  }
  const start = Date.now();
  let lastError: string | undefined;

  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error("sandbox-agent exited before becoming healthy.");
    }
    try {
      const response = await fetcher(`${baseUrl}/v1/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for sandbox-agent health (${lastError ?? "unknown error"}).`);
}

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

function registerProcessCleanup(child: ChildProcess): { dispose: () => void } {
  const handler = () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  };

  process.once("exit", handler);
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);

  return {
    dispose: () => {
      process.off("exit", handler);
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    },
  };
}
