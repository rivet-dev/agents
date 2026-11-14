import { defineConfig } from "vitest/config";

/**
 * Tests against real cloud sandboxes. They are never run in CI. Run them with
 * `pnpm test:live`, or `pnpm test:live <provider>` for one provider.
 */
export default defineConfig({
	test: {
		include: ["tests/**/*.live.test.ts"],
		testTimeout: 120_000,
		// Setup can build an image or a template first, which takes minutes.
		hookTimeout: 1_200_000,
	},
});
