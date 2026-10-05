/** `Omit` that keeps each member of a union, so `state` and `createState` stay alternatives. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

/** The app's actions as clients see them: the same arguments, without `c.pi`. */
export type ClientActions<T, TContext> = string extends keyof T
	? Record<never, never>
	: {
			[K in keyof T]: T[K] extends (
				c: any,
				...args: infer TArgs
			) => infer TResult
				? (c: TContext, ...args: TArgs) => TResult
				: ClientActions<T[K], TContext>;
		};

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
