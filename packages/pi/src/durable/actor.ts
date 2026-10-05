import type { Harness } from "@earendil-works/pi-durable";
import {
	type ActionContext,
	type ActorConfigInput,
	type ActorDefinition,
	actor,
	type Conn,
	type ConnectContext,
	type DestroyContext,
	type DisconnectContext,
	type EventSchemaConfig,
	type QueueSchemaConfig,
	type SleepContext,
	type WakeContext,
} from "rivetkit";
import { db } from "rivetkit/db";
import type { PiContext, PiDatabaseProvider } from "../runtime.js";
import { createPiDurableActions, type PiDurableActions } from "./actions.js";
import {
	closeHarness,
	createPiDurableRuntime,
	openOnWake,
	PI_DURABLE_RUNTIME,
	type PiDurableOptions,
	withPiAccess,
} from "./runtime.js";
import { migratePiDurableTables } from "./storage.js";

/** Ten minutes. `submission.wait` and `prompt` wait for a whole run. */
const DEFAULT_ACTION_TIMEOUT_MS = 10 * 60_000;

/** `c.pi`: the actor's Pi Durable harness, in the app's own actions and hooks. */
export interface PiDurableAccess {
	readonly pi: Harness;
}

/** The app's own actions, which get `c.pi`. Nested objects become dotted action names. */
export interface PiDurableUserActions<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig,
	TQueues extends QueueSchemaConfig,
> {
	[action: string]:
		| ((
				c: ActionContext<
					TState,
					TConnParams,
					TConnState,
					TVars,
					TInput,
					PiDatabaseProvider,
					TEvents,
					TQueues
				> &
					PiDurableAccess,
				...args: any[]
		  ) => any)
		| PiDurableUserActions<
				TState,
				TConnParams,
				TConnState,
				TVars,
				TInput,
				TEvents,
				TQueues
		  >;
}

/** Lifecycle hooks that get `c.pi`. Other hooks run before Pi Durable opens or outside it. */
interface PiDurableHooks<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig,
	TQueues extends QueueSchemaConfig,
> {
	onWake?: (
		c: WakeContext<
			TState,
			TConnParams,
			TConnState,
			TVars,
			TInput,
			PiDatabaseProvider,
			TEvents,
			TQueues
		> &
			PiDurableAccess,
	) => void | Promise<void>;
	onSleep?: (
		c: SleepContext<
			TState,
			TConnParams,
			TConnState,
			TVars,
			TInput,
			PiDatabaseProvider,
			TEvents,
			TQueues
		> &
			PiDurableAccess,
	) => void | Promise<void>;
	onDestroy?: (
		c: DestroyContext<
			TState,
			TConnParams,
			TConnState,
			TVars,
			TInput,
			PiDatabaseProvider,
			TEvents,
			TQueues
		> &
			PiDurableAccess,
	) => void | Promise<void>;
	onConnect?: (
		c: ConnectContext<
			TState,
			TConnParams,
			TConnState,
			TVars,
			TInput,
			PiDatabaseProvider,
			TEvents,
			TQueues
		> &
			PiDurableAccess,
		conn: Conn<
			TState,
			TConnParams,
			TConnState,
			TVars,
			TInput,
			PiDatabaseProvider,
			TEvents,
			TQueues
		>,
	) => void | Promise<void>;
	onDisconnect?: (
		c: DisconnectContext<
			TState,
			TConnParams,
			TConnState,
			TVars,
			TInput,
			PiDatabaseProvider,
			TEvents,
			TQueues
		> &
			PiDurableAccess,
		conn: Conn<
			TState,
			TConnParams,
			TConnState,
			TVars,
			TInput,
			PiDatabaseProvider,
			TEvents,
			TQueues
		>,
	) => void | Promise<void>;
}

type WrappedKey =
	| "actions"
	| keyof PiDurableHooks<any, any, any, any, any, any, any>;

/** `Omit` that keeps each member of a union, so `state` and `createState` stay alternatives. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

export type PiDurableActorConfigInput<
	TState = undefined,
	TConnParams = undefined,
	TConnState = undefined,
	TVars = undefined,
	TInput = undefined,
	TEvents extends EventSchemaConfig = Record<never, never>,
	TQueues extends QueueSchemaConfig = Record<never, never>,
	TUserActions extends PiDurableUserActions<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		TEvents,
		TQueues
	> = Record<never, never>,
> = DistributiveOmit<
	ActorConfigInput<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		PiDatabaseProvider,
		TEvents,
		TQueues
	>,
	WrappedKey
> &
	PiDurableHooks<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		TEvents,
		TQueues
	> &
	PiDurableOptions & { actions?: TUserActions };

/** The app's actions as clients see them: the same arguments, without `c.pi`. */
type ClientActions<T, TContext> = string extends keyof T
	? Record<never, never>
	: {
			[K in keyof T]: T[K] extends (
				c: any,
				...args: infer TArgs
			) => infer TResult
				? (c: TContext, ...args: TArgs) => TResult
				: ClientActions<T[K], TContext>;
		};

const piDurableOptionKeys = [
	"registry",
	"models",
	"settings",
	"env",
	"conversationCreated",
	"now",
	"onReport",
	"model",
	"thinkingLevel",
	"scopedModels",
	"providers",
	"apiKeys",
	"credentials",
	"sandbox",
	"documents",
] as const satisfies readonly (keyof PiDurableOptions)[];

/**
 * Defines a Rivet Actor that owns one Pi Durable harness.
 *
 * Pi Durable stores conversations, tasks, and documents in the actor's SQLite
 * database. Runs survive sleep, deploys, and crashes, and resume when the
 * actor wakes. The actions match Pi Durable's API one to one. The app's own
 * actions and lifecycle hooks get the harness as `c.pi`.
 */
export function piDurable<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig = Record<never, never>,
	TQueues extends QueueSchemaConfig = Record<never, never>,
	TUserActions extends PiDurableUserActions<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		TEvents,
		TQueues
	> = PiDurableUserActions<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		TEvents,
		TQueues
	>,
>(
	config: PiDurableActorConfigInput<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		TEvents,
		TQueues,
		TUserActions
	>,
): ActorDefinition<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	PiDatabaseProvider,
	TEvents,
	TQueues,
	ClientActions<
		TUserActions,
		ActionContext<
			TState,
			TConnParams,
			TConnState,
			TVars,
			TInput,
			PiDatabaseProvider,
			TEvents,
			TQueues
		>
	> &
		PiDurableActions
> {
	const actorConfig: Record<string, any> = { ...config };
	const options: Record<string, unknown> = {};
	for (const key of piDurableOptionKeys) {
		if (key in actorConfig) {
			options[key] = actorConfig[key];
			delete actorConfig[key];
		}
	}
	const durableOptions = options as unknown as PiDurableOptions;
	if (!durableOptions.registry) {
		throw new Error(
			"piDurable() needs a registry; pass createRegistry() from @earendil-works/pi-durable",
		);
	}
	if (actorConfig.db !== undefined) {
		throw new Error(
			"piDurable() owns the actor database; remove the db option",
		);
	}
	const actions = createPiDurableActions(durableOptions);
	for (const key of Object.keys(actorConfig.actions ?? {})) {
		if (key in actions)
			throw new Error(`piDurable() action name is reserved: ${key}`);
	}

	const withPi = <TArgs extends unknown[]>(
		hook: ((c: PiContext, ...args: TArgs) => unknown) | undefined,
	) =>
		hook &&
		((c: PiContext, ...args: TArgs) =>
			withPiAccess(c, durableOptions, () => hook(c, ...args)));
	const userVars = actorConfig.vars;
	const userCreateVars = actorConfig.createVars;
	const userOnWake = actorConfig.onWake;
	const userOnSleep = withPi(actorConfig.onSleep);
	const userOnDestroy = withPi(actorConfig.onDestroy);
	delete actorConfig.vars;

	return actor({
		...actorConfig,
		options: {
			actionTimeout: DEFAULT_ACTION_TIMEOUT_MS,
			...actorConfig.options,
		},
		db: db({ onMigrate: migratePiDurableTables }),
		actions: {
			...wrapActions(actorConfig.actions ?? {}, durableOptions),
			...actions,
		},
		createVars: async (c: unknown, driverCtx: unknown) => {
			const vars = userCreateVars
				? await userCreateVars(c, driverCtx)
				: userVars === undefined
					? undefined
					: structuredClone(userVars);
			return attachRuntime(vars);
		},
		// Opening on wake resumes interrupted work, after the app's own onWake.
		onWake: async (c: PiContext) => {
			const opened = openOnWake(c, durableOptions);
			if (userOnWake) {
				const harness = await opened;
				try {
					await withPiAccess(c, durableOptions, () => userOnWake(c));
				} finally {
					harness.resume();
				}
				return;
			}
			await opened.then(
				(harness) => harness.resume(),
				(error: unknown) => {
					c.log.error({
						msg: "pi durable could not open on wake; actions will retry",
						error,
					});
				},
			);
		},
		onConnect: withPi(actorConfig.onConnect),
		onDisconnect: withPi(actorConfig.onDisconnect),
		onSleep: async (c: PiContext) => {
			try {
				await userOnSleep?.(c);
			} finally {
				await closeHarness(c, durableOptions, "sleep");
			}
		},
		onDestroy: async (c: PiContext) => {
			try {
				await userOnDestroy?.(c);
			} finally {
				await closeHarness(c, durableOptions, "destroy");
			}
		},
	} as any) as any;
}

/** Wraps each of the app's actions so it runs with `c.pi`. */
function wrapActions(
	actions: Record<string, unknown>,
	options: PiDurableOptions,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(actions).map(([name, action]) => [
			name,
			typeof action === "function"
				? (c: PiContext, ...args: unknown[]) =>
						withPiAccess(c, options, () => action(c, ...args))
				: wrapActions(action as Record<string, unknown>, options),
		]),
	);
}

/** Adds the runtime slot to the user's vars without changing their shape. */
function attachRuntime(vars: unknown): object {
	const runtime = createPiDurableRuntime();
	if (vars === undefined) {
		return { [PI_DURABLE_RUNTIME]: runtime };
	}
	if (typeof vars !== "object" || vars === null) {
		throw new Error("piDurable() requires actor vars to be an object");
	}
	return Object.assign(vars, { [PI_DURABLE_RUNTIME]: runtime });
}
