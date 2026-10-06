import { expect, vi } from "vitest";

/** Counts each actor's sleeps by key, in this process where the actors run. */
export function createSleepCounter() {
	const sleeps = new Map<string, number>();
	const count = (key: unknown[]) => sleeps.get(JSON.stringify(key)) ?? 0;
	return {
		/** Call from the actor's `onSleep`. */
		record: (c: { key: unknown[] }) => {
			sleeps.set(JSON.stringify(c.key), count(c.key) + 1);
		},
		count,
		async waitFor(key: unknown[], atLeast: number) {
			// Sleep completes after the action that asked for it returns, and onSleep records it in this process.
			await vi.waitFor(
				() => expect(count(key)).toBeGreaterThanOrEqual(atLeast),
				{
					timeout: 20_000,
				},
			);
		},
	};
}
