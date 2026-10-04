import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigSchema, type AppConfig } from "@sandbox-agent/foundry-shared";
import { resolveTuiTheme } from "../src/theme.js";

function withEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

describe("resolveTuiTheme", () => {
  let tempDir: string | null = null;
  const originalState = process.env.XDG_STATE_HOME;
  const originalConfig = process.env.XDG_CONFIG_HOME;

  const baseConfig: AppConfig = ConfigSchema.parse({
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

  afterEach(() => {
    withEnv("XDG_STATE_HOME", originalState);
    withEnv("XDG_CONFIG_HOME", originalConfig);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("falls back to default theme when no theme sources are present", () => {
    tempDir = mkdtempSync(join(tmpdir(), "hf-theme-test-"));
    withEnv("XDG_STATE_HOME", join(tempDir, "state"));
    withEnv("XDG_CONFIG_HOME", join(tempDir, "config"));

    const resolution = resolveTuiTheme(baseConfig, tempDir);

    expect(resolution.name).toBe("opencode-default");
    expect(resolution.source).toBe("default");
    expect(resolution.theme.text).toBe("#ffffff");
  });

  it("loads theme from opencode state when configured", () => {
    tempDir = mkdtempSync(join(tmpdir(), "hf-theme-test-"));
    const stateHome = join(tempDir, "state");
    const configHome = join(tempDir, "config");
    withEnv("XDG_STATE_HOME", stateHome);
    withEnv("XDG_CONFIG_HOME", configHome);
    mkdirSync(join(stateHome, "opencode"), { recursive: true });
    writeFileSync(join(stateHome, "opencode", "kv.json"), JSON.stringify({ theme: "gruvbox", theme_mode: "dark" }), "utf8");

    const resolution = resolveTuiTheme(baseConfig, tempDir);

    expect(resolution.name).toBe("gruvbox");
    expect(resolution.source).toContain("opencode state");
    expect(resolution.mode).toBe("dark");
    expect(resolution.theme.selectionBorder.toLowerCase()).not.toContain("dark");
  });

  it("resolves OpenCode token references in theme defs", () => {
    tempDir = mkdtempSync(join(tmpdir(), "hf-theme-test-"));
    const stateHome = join(tempDir, "state");
    const configHome = join(tempDir, "config");
    withEnv("XDG_STATE_HOME", stateHome);
    withEnv("XDG_CONFIG_HOME", configHome);
    mkdirSync(join(stateHome, "opencode"), { recursive: true });
    writeFileSync(join(stateHome, "opencode", "kv.json"), JSON.stringify({ theme: "orng", theme_mode: "dark" }), "utf8");

    const resolution = resolveTuiTheme(baseConfig, tempDir);

    expect(resolution.name).toBe("orng");
    expect(resolution.theme.selectionBorder).toBe("#EE7948");
    expect(resolution.theme.background).toBe("#0a0a0a");
  });

  it("prefers explicit foundry theme override from config", () => {
    tempDir = mkdtempSync(join(tmpdir(), "hf-theme-test-"));
    withEnv("XDG_STATE_HOME", join(tempDir, "state"));
    withEnv("XDG_CONFIG_HOME", join(tempDir, "config"));

    const config = { ...baseConfig, theme: "default" } as AppConfig & { theme: string };
    const resolution = resolveTuiTheme(config, tempDir);

    expect(resolution.name).toBe("opencode-default");
    expect(resolution.source).toBe("foundry config");
  });
});
