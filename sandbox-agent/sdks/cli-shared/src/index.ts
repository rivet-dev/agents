export type InstallCommandBlock = {
  label: string;
  commands: string[];
};

export type NonExecutableBinaryMessageOptions = {
  binPath: string;
  trustPackages: string;
  bunInstallBlocks: InstallCommandBlock[];
  genericInstallCommands?: string[];
  binaryName?: string;
};

export type FsSubset = {
  accessSync: (path: string, mode?: number) => void;
  chmodSync: (path: string, mode: number) => void;
  constants: { X_OK: number };
};

export function isBunRuntime(): boolean {
  if (typeof process?.versions?.bun === "string") return true;
  const userAgent = process?.env?.npm_config_user_agent || "";
  return userAgent.includes("bun/");
}

const PERMISSION_ERRORS = new Set(["EACCES", "EPERM", "ENOEXEC"]);

function isPermissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && PERMISSION_ERRORS.has(code);
}

/**
 * Checks if a binary is executable and attempts to make it executable if not.
 * Returns true if the binary is (or was made) executable, false if it couldn't
 * be made executable due to permission errors. Throws for other errors.
 *
 * Requires fs to be passed in to avoid static imports that break browser builds.
 */
export function assertExecutable(binPath: string, fs: FsSubset): boolean {
  if (process.platform === "win32") {
    return true;
  }

  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return true;
  } catch {
    // Not executable, try to fix
  }

  try {
    fs.chmodSync(binPath, 0o755);
    return true;
  } catch (error) {
    if (isPermissionError(error)) {
      return false;
    }
    throw error;
  }
}

export function formatNonExecutableBinaryMessage(options: NonExecutableBinaryMessageOptions): string {
  const { binPath, trustPackages, bunInstallBlocks, genericInstallCommands, binaryName } = options;

  const label = binaryName ?? "sandbox-agent";
  const lines = [`${label} binary is not executable: ${binPath}`];

  if (isBunRuntime()) {
    lines.push("Allow Bun to run postinstall scripts for native binaries and reinstall:");
    for (const block of bunInstallBlocks) {
      lines.push(`${block.label}:`);
      for (const command of block.commands) {
        lines.push(`  ${command}`);
      }
    }
    lines.push(`Or run: chmod +x "${binPath}"`);
    return lines.join("\n");
  }

  lines.push("Postinstall scripts for native packages did not run, so the binary was left non-executable.");
  if (genericInstallCommands && genericInstallCommands.length > 0) {
    lines.push("Reinstall with scripts enabled:");
    for (const command of genericInstallCommands) {
      lines.push(`  ${command}`);
    }
  } else {
    lines.push("Reinstall with scripts enabled for:");
    lines.push(`  ${trustPackages}`);
  }
  lines.push(`Or run: chmod +x "${binPath}"`);
  return lines.join("\n");
}
