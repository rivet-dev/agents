import { spawnSync } from "node:child_process";
import { expect, vi } from "vitest";

/**
 * Kills the child and the engine it started, and waits until the engine is
 * gone. The engine runs in its own process group, and if it is still up,
 * `setupTest` reuses it while it shuts down.
 */
export async function killWithEngine(pid: number): Promise<void> {
	const children = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
		.stdout.split("\n")
		.filter(Boolean)
		.map(Number);
	for (const target of [-pid, ...children]) {
		try {
			process.kill(target, "SIGKILL");
		} catch {
			// It already exited.
		}
	}
	await vi.waitFor(
		() => {
			for (const engine of children) {
				expect(() => process.kill(engine, 0)).toThrow();
			}
		},
		{ timeout: 10_000, interval: 50 },
	);
}
