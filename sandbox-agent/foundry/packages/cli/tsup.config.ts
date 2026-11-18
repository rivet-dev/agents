import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

function packageVersion(): string {
  try {
    const packageJsonPath = resolve(process.cwd(), "package.json");
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // Fall through.
  }
  return "dev";
}

function sourceId(): string {
  try {
    const raw = execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (raw.length > 0) {
      return raw;
    }
  } catch {
    // Fall through.
  }
  return packageVersion();
}

function resolveBuildId(): string {
  const override = process.env.HF_BUILD_ID?.trim();
  if (override) {
    return override;
  }

  // Match sandbox-agent semantics: source id + unique build timestamp.
  return `${sourceId()}-${Date.now().toString()}`;
}

const buildId = resolveBuildId();

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  define: {
    __HF_BUILD_ID__: JSON.stringify(buildId),
  },
});
