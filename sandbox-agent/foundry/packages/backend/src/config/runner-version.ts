import { readFileSync } from "node:fs";

function parseRunnerVersion(rawValue: string | undefined): number | undefined {
  const value = rawValue?.trim();
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return parsed;
}

export function resolveRunnerVersion(): number | undefined {
  const envVersion = parseRunnerVersion(process.env.RIVET_RUNNER_VERSION);
  if (envVersion !== undefined) {
    return envVersion;
  }

  const versionFilePath = process.env.RIVET_RUNNER_VERSION_FILE;
  if (!versionFilePath) {
    return undefined;
  }

  try {
    return parseRunnerVersion(readFileSync(versionFilePath, "utf8"));
  } catch {
    return undefined;
  }
}
