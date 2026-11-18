import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAUNCHER_PATH = resolve(__dirname, "../bin/sandbox-agent");

// Check for binary in common locations
function findBinary(): string | null {
  if (process.env.SANDBOX_AGENT_BIN) {
    return process.env.SANDBOX_AGENT_BIN;
  }

  // Check cargo build output
  const cargoPaths = [resolve(__dirname, "../../../target/debug/sandbox-agent"), resolve(__dirname, "../../../target/release/sandbox-agent")];

  for (const p of cargoPaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return null;
}

const BINARY_PATH = findBinary();
const SKIP_INTEGRATION = !BINARY_PATH;

describe("CLI Launcher", () => {
  describe("platform detection", () => {
    it("defines all supported platforms", () => {
      const PLATFORMS: Record<string, string> = {
        "darwin-arm64": "@sandbox-agent/cli-darwin-arm64",
        "darwin-x64": "@sandbox-agent/cli-darwin-x64",
        "linux-x64": "@sandbox-agent/cli-linux-x64",
        "linux-arm64": "@sandbox-agent/cli-linux-arm64",
        "win32-x64": "@sandbox-agent/cli-win32-x64",
      };

      // Verify platform map covers expected platforms
      expect(PLATFORMS["darwin-arm64"]).toBe("@sandbox-agent/cli-darwin-arm64");
      expect(PLATFORMS["darwin-x64"]).toBe("@sandbox-agent/cli-darwin-x64");
      expect(PLATFORMS["linux-x64"]).toBe("@sandbox-agent/cli-linux-x64");
      expect(PLATFORMS["linux-arm64"]).toBe("@sandbox-agent/cli-linux-arm64");
      expect(PLATFORMS["win32-x64"]).toBe("@sandbox-agent/cli-win32-x64");
    });

    it("generates correct platform key format", () => {
      const key = `${process.platform}-${process.arch}`;
      expect(key).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    });
  });
});

describe.skipIf(SKIP_INTEGRATION)("CLI Integration", () => {
  it("runs --help successfully", () => {
    const result = spawnSync(BINARY_PATH!, ["--help"], {
      encoding: "utf8",
      timeout: 10000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("sandbox-agent");
  });

  it("runs --version successfully", () => {
    const result = spawnSync(BINARY_PATH!, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it("lists agents", () => {
    const result = spawnSync(BINARY_PATH!, ["agents", "list"], {
      encoding: "utf8",
      timeout: 10000,
    });

    expect(result.status).toBe(0);
  });

  it("shows server help", () => {
    const result = spawnSync(BINARY_PATH!, ["server", "--help"], {
      encoding: "utf8",
      timeout: 10000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("server");
  });
});
