import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 20_000,
    setupFiles: ["./test/setup.ts"],
  },
});
