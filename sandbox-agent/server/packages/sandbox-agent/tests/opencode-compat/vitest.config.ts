import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";

// Resolve the actual SDK path through pnpm's symlink structure
function resolveSdkPath(): string {
  try {
    // Try to resolve through the local node_modules symlink
    const localPath = resolve(__dirname, "node_modules/@opencode-ai/sdk");
    const realPath = realpathSync(localPath);
    return resolve(realPath, "dist");
  } catch {
    // Fallback to root node_modules
    return resolve(__dirname, "../../../../../node_modules/@opencode-ai/sdk/dist");
  }
}

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      // Work around SDK publishing issue where exports point to src/ instead of dist/
      "@opencode-ai/sdk": resolveSdkPath(),
    },
  },
});
