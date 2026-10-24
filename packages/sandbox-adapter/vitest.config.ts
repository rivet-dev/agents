import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Containers start slowly the first time an image is pulled.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
