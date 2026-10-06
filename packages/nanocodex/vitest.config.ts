import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Each file boots its own engine through setupTest. Running files in
		// parallel makes those engines contend for ports and CPU.
		fileParallelism: false,
		sequence: { concurrent: false },
		testTimeout: 60_000,
		hookTimeout: 60_000,
		pool: "forks",
		env: {
			RIVET_LOG_LEVEL: "DEBUG",
			RIVET_LOG_TARGET: "1",
			RIVET_LOG_TIMESTAMP: "1",
			RIVET_LOG_ERROR_STACK: "1",
			RIVET_LOG_MESSAGE: "1",
		},
	},
});
