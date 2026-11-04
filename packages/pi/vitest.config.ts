import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Each file boots its own engine through setupTest. Running files in
		// parallel makes those engines contend for ports and CPU.
		fileParallelism: false,
		globalSetup: ["./tests/helpers/engine-root.ts"],
		setupFiles: ["./tests/helpers/isolated-engine.ts"],
		sequence: { concurrent: false },
		testTimeout: 60_000,
		hookTimeout: 60_000,
		pool: "forks",
		env: {
			// RivetKit 3.0.1 starts Services on a fixed port, which a test file that
			// exits abruptly leaves held. The next file then fails to start.
			RIVET_RUN_SERVICES: "0",
			RIVET_LOG_LEVEL: "DEBUG",
			RIVET_LOG_TARGET: "1",
			RIVET_LOG_TIMESTAMP: "1",
			RIVET_LOG_ERROR_STACK: "1",
			RIVET_LOG_MESSAGE: "1",
		},
	},
});
