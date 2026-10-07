import { DEFAULT_SLEEP_GRACE_PERIOD_MS, drainDeadline } from "./drain.js";
import type { PiContext, PiStop } from "./runtime.js";

/** Ten minutes. Pi waits such as `waitForIdle`, `prompt`, and `submission.wait` outlive RivetKit's one-minute default. */
const DEFAULT_ACTION_TIMEOUT_MS = 10 * 60_000;

type ActorConfig = Record<string, any>;

/** Moves the Pi options named in `keys` out of the actor config. */
export function splitConfig<TOptions>(
	config: object,
	keys: readonly (keyof TOptions & string)[],
): { actorConfig: ActorConfig; options: TOptions } {
	const actorConfig: ActorConfig = { ...config };
	const options: ActorConfig = {};
	for (const key of keys) {
		if (key in actorConfig) {
			options[key] = actorConfig[key];
			delete actorConfig[key];
		}
	}
	// Only the keys of `TOptions` were copied, with the values the caller passed.
	return { actorConfig, options: options as TOptions };
}

/** Throws when the app's actions or events reuse a built-in name. */
export function assertNoReservedNames(
	owner: string,
	actorConfig: ActorConfig,
	builtIns: { action: object; event: object },
): void {
	for (const [kind, custom] of [
		["action", actorConfig.actions],
		["event", actorConfig.events],
	] as const) {
		for (const key of Object.keys(custom ?? {})) {
			if (key in builtIns[kind]) {
				throw new Error(`${owner} ${kind} name is reserved: ${key}`);
			}
		}
	}
}

/**
 * The app's actor config with what `pi()` adds: longer action and sleep grace defaults, the runtime slot on the app's vars,
 * and shutdown hooks that run the app's hook and then close Pi.
 */
export function sharedActorConfig(
	owner: string,
	actorConfig: ActorConfig,
	runtime: { slot: symbol; create: () => object },
	close: (c: PiContext, stop: PiStop) => Promise<void>,
	userHooks: {
		onSleep?: (c: PiContext) => unknown;
		onDestroy?: (c: PiContext) => unknown;
	},
) {
	// The runtime slot rides on the app's vars, so `createVars` replaces `vars`.
	const { vars: userVars, createVars: userCreateVars, ...config } = actorConfig;
	const sleepGracePeriod: number =
		config.options?.sleepGracePeriod ?? DEFAULT_SLEEP_GRACE_PERIOD_MS;
	return {
		...config,
		options: {
			actionTimeout: DEFAULT_ACTION_TIMEOUT_MS,
			sleepGracePeriod: DEFAULT_SLEEP_GRACE_PERIOD_MS,
			...config.options,
		},
		createVars: async (c: unknown, driverCtx: unknown) => {
			const vars = userCreateVars
				? await userCreateVars(c, driverCtx)
				: userVars === undefined
					? undefined
					: structuredClone(userVars);
			if (vars === undefined) return { [runtime.slot]: runtime.create() };
			if (typeof vars !== "object" || vars === null) {
				throw new Error(`${owner} requires actor vars to be an object`);
			}
			return Object.assign(vars, { [runtime.slot]: runtime.create() });
		},
		onSleep: async (c: PiContext) => {
			const drainUntil = drainDeadline(sleepGracePeriod);
			try {
				await userHooks.onSleep?.(c);
			} finally {
				await close(c, { reason: "sleep", drainUntil });
			}
		},
		onDestroy: async (c: PiContext) => {
			try {
				await userHooks.onDestroy?.(c);
			} finally {
				await close(c, { reason: "destroy" });
			}
		},
	};
}

/** Wraps each of the app's actions, including nested ones, so it runs inside `run`. */
export function wrapActions(
	actions: Record<string, unknown>,
	run: (c: any, action: () => unknown) => Promise<unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(actions).map(([name, action]) => [
			name,
			typeof action === "function"
				? (c: unknown, ...args: unknown[]) => run(c, () => action(c, ...args))
				: wrapActions(action as Record<string, unknown>, run),
		]),
	);
}
