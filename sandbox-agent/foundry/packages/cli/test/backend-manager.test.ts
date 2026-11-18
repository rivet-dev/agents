import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

const { spawnMock, execFileSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
    execFileSync: execFileSyncMock,
  };
});

import { ensureBackendRunning, parseBackendPort } from "../src/backend/manager.js";
import { ConfigSchema, type AppConfig } from "@sandbox-agent/foundry-shared";

function backendStateFile(baseDir: string, host: string, port: number, suffix: string): string {
  const sanitized = host
    .split("")
    .map((ch) => (/[a-zA-Z0-9]/.test(ch) ? ch : "-"))
    .join("");

  return join(baseDir, `backend-${sanitized}-${port}.${suffix}`);
}

function healthyMetadataResponse(): { ok: boolean; json: () => Promise<unknown> } {
  return {
    ok: true,
    json: async () => ({
      runtime: "rivetkit",
      actorNames: {
        organization: {},
      },
    }),
  };
}

function unhealthyMetadataResponse(): { ok: boolean; json: () => Promise<unknown> } {
  return {
    ok: false,
    json: async () => ({}),
  };
}

describe("backend manager", () => {
  const originalFetch = globalThis.fetch;
  const originalStateDir = process.env.HF_BACKEND_STATE_DIR;
  const originalBuildId = process.env.HF_BUILD_ID;

  const config: AppConfig = ConfigSchema.parse({
    auto_submit: true,
    notify: ["terminal"],
    organization: { default: "default" },
    backend: {
      host: "127.0.0.1",
      port: 7741,
      dbPath: "~/.local/share/foundry/task.db",
      opencode_poll_interval: 2,
      github_poll_interval: 30,
      backup_interval_secs: 3600,
      backup_retention_days: 7,
    },
    sandboxProviders: {
      local: {},
      e2b: {},
    },
  });

  beforeEach(() => {
    process.env.HF_BUILD_ID = "test-build";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
    execFileSyncMock.mockReset();
    globalThis.fetch = originalFetch;

    if (originalStateDir === undefined) {
      delete process.env.HF_BACKEND_STATE_DIR;
    } else {
      process.env.HF_BACKEND_STATE_DIR = originalStateDir;
    }

    if (originalBuildId === undefined) {
      delete process.env.HF_BUILD_ID;
    } else {
      process.env.HF_BUILD_ID = originalBuildId;
    }
  });

  it("restarts backend when healthy but build is outdated", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hf-backend-test-"));
    process.env.HF_BACKEND_STATE_DIR = stateDir;

    const pidPath = backendStateFile(stateDir, config.backend.host, config.backend.port, "pid");
    const versionPath = backendStateFile(stateDir, config.backend.host, config.backend.port, "version");

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(pidPath, "999999", "utf8");
    writeFileSync(versionPath, "old-build", "utf8");

    const fetchMock = vi
      .fn<() => Promise<{ ok: boolean; json: () => Promise<unknown> }>>()
      .mockResolvedValueOnce(healthyMetadataResponse())
      .mockResolvedValueOnce(unhealthyMetadataResponse())
      .mockResolvedValue(healthyMetadataResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const fakeChild = Object.assign(new EventEmitter(), {
      pid: process.pid,
      unref: vi.fn(),
    }) as unknown as ChildProcess;
    spawnMock.mockReturnValue(fakeChild);

    await ensureBackendRunning(config);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const launchCommand = spawnMock.mock.calls[0]?.[0];
    const launchArgs = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(launchCommand === "pnpm" || launchCommand === "bun" || (typeof launchCommand === "string" && launchCommand.endsWith("/bun"))).toBe(true);
    expect(launchArgs).toEqual(expect.arrayContaining(["start", "--host", config.backend.host, "--port", String(config.backend.port)]));
    if (launchCommand === "pnpm") {
      expect(launchArgs).toEqual(expect.arrayContaining(["exec", "bun", "src/index.ts"]));
    }
    expect(readFileSync(pidPath, "utf8").trim()).toBe(String(process.pid));
    expect(readFileSync(versionPath, "utf8").trim()).toBe("test-build");
  });

  it("does not restart when backend is healthy and build is current", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hf-backend-test-"));
    process.env.HF_BACKEND_STATE_DIR = stateDir;

    const versionPath = backendStateFile(stateDir, config.backend.host, config.backend.port, "version");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(versionPath, "test-build", "utf8");

    const fetchMock = vi.fn<() => Promise<{ ok: boolean; json: () => Promise<unknown> }>>().mockResolvedValue(healthyMetadataResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await ensureBackendRunning(config);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("validates backend port parsing", () => {
    expect(parseBackendPort(undefined, 7741)).toBe(7741);
    expect(parseBackendPort("8080", 7741)).toBe(8080);
    expect(() => parseBackendPort("0", 7741)).toThrow("Invalid backend port");
    expect(() => parseBackendPort("abc", 7741)).toThrow("Invalid backend port");
  });
});
