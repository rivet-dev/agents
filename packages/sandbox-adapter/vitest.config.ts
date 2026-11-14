import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Live tests create real cloud resources, so they run only through
		// `pnpm test:live`.
		exclude: [...configDefaults.exclude, "tests/**/*.live.test.ts"],
		// Containers start slowly the first time an image is pulled.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
