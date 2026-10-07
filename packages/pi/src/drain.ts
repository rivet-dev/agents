/**
 * Fifteen minutes, so a running model call or tool call can finish before a
 * an upgrade restarts the actor. The engine's stop threshold still bounds it.
 */
export const DEFAULT_SLEEP_GRACE_PERIOD_MS = 15 * 60_000;

/**
 * Time kept back from the grace period for closing Pi and suspending the
 * sandbox after a drain, so both finish before RivetKit's grace deadline.
 */
const MAX_CLOSE_RESERVE_MS = 30_000;

/**
 * The time a drain must end by. RivetKit's grace deadline starts when the
 * stop starts, just before `onSleep` runs, so the caller takes this before the
 * app's own `onSleep`.
 */
export function drainDeadline(gracePeriodMs: number): number {
	const closeReserve = Math.min(MAX_CLOSE_RESERVE_MS, gracePeriodMs / 4);
	return Date.now() + gracePeriodMs - closeReserve;
}
