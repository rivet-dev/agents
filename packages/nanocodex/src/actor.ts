import type { AgentEvent, DefaultAgent } from "nanocodex";
import {
	type ActionContext,
	type ActorConfigInput,
	type ActorDefinition,
	actor,
	type EventSchemaConfig,
	event,
	type QueueSchemaConfig,
	type Type,
} from "rivetkit";
import { db } from "rivetkit/db";
import { createNanocodexActions, type NanocodexActions } from "./actions.js";
import {
	closeNanocodex,
	createNanocodexRuntime,
	type DistributiveOmit,
	ensureAgent,
	NANOCODEX_RUNTIME,
	type NanocodexContext,
	type NanocodexDatabaseProvider,
	type NanocodexOptions,
	nanocodexRuntime,
} from "./runtime.js";
import { migrateNanocodexTables } from "./storage.js";

/** Ten minutes. A turn often outlives RivetKit's one-minute default. */
const DEFAULT_ACTION_TIMEOUT_MS = 10 * 60_000;

/**
 * Fifteen minutes, so a running turn can finish before a deploy moves the
 * actor. The engine's stop threshold still bounds it.
 */
const DEFAULT_SLEEP_GRACE_PERIOD_MS = 15 * 60_000;

/** Time kept back from the grace period to close the agent and suspend the sandbox. */
const MAX_CLOSE_RESERVE_MS = 30_000;

/** Every nanocodex `AgentEvent`, in order, for connected clients. */
export type NanocodexEvents = {
	event: Type<AgentEvent>;
};

const nanocodexEvents: NanocodexEvents = {
	event: event<AgentEvent>(),
};

/** `c.nanocodex`: the actor's nanocodex agent, in the app's own actions. */
export interface NanocodexAccess {
	readonly nanocodex: DefaultAgent;
}

/** The app's own actions, which get `c.nanocodex`. Nested objects become dotted action names. */
export interface NanocodexUserActions<
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
					NanocodexDatabaseProvider,
					TEvents,
					TQueues
				> &
					NanocodexAccess,
				// RivetKit infers each action's arguments and result from the app's own signature.
				...args: any[]
		  ) => any)
		| NanocodexUserActions<
				TState,
				TConnParams,
				TConnState,
				TVars,
				TInput,
				TEvents,
				TQueues
		  >;
}

/** The app's actions as clients see them: the same arguments, without `c.nanocodex`. */
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

/** Ordinary actor config plus the nanocodex options. The app's actions get `c.nanocodex`. */
export type NanocodexActorConfigInput<
	TState = undefined,
	TConnParams = undefined,
	TConnState = undefined,
	TVars = undefined,
	TInput = undefined,
	TEvents extends EventSchemaConfig = Record<never, never>,
	TQueues extends QueueSchemaConfig = Record<never, never>,
	TUserActions extends NanocodexUserActions<
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
		NanocodexDatabaseProvider,
		TEvents,
		TQueues
	>,
	"actions" | "db"
> &
	NanocodexOptions & { actions?: TUserActions };

/** An app action or a group of them, as RivetKit calls them. */
type ActionTree = {
	[name: string]:
		| ((c: NanocodexContext, ...args: unknown[]) => unknown)
		| ActionTree;
};

/**
 * The app's actor config as RivetKit calls it: the parts `nanocodex()` wraps,
 * and the rest, which passes through unchanged.
 */
interface WrappedActorConfig {
	[key: string]: unknown;
	vars?: unknown;
	createVars?: (c: unknown, driverCtx: unknown) => unknown;
	onWake?: (c: NanocodexContext) => unknown;
	onSleep?: (c: NanocodexContext) => unknown;
	onDestroy?: (c: NanocodexContext) => unknown;
	actions?: ActionTree;
	events?: object;
	options?: { sleepGracePeriod?: number };
	db?: unknown;
}

/**
 * Defines a Rivet Actor that owns one nanocodex agent.
 *
 * The conversation lives in nanocodex's durable journal in the actor's SQLite
 * database. Prompting a turn id that already finished returns its result
 * without a model call, and a turn that a stop cut off resumes when the same
 * id is prompted after the actor wakes. The actions match nanocodex's `turn`
 * and `session` methods; agent events are broadcast on `event`. Ordinary
 * actor config passes through, and the app's own actions get `c.nanocodex`.
 *
 * @throws When the config sets `db` or reuses a built-in action or event name.
 */
export function nanocodex<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig = Record<never, never>,
	TQueues extends QueueSchemaConfig = Record<never, never>,
	TUserActions extends NanocodexUserActions<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		TEvents,
		TQueues
	> = NanocodexUserActions<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		TEvents,
		TQueues
	>,
>(
	config: NanocodexActorConfigInput<
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
	NanocodexDatabaseProvider,
	TEvents & NanocodexEvents,
	TQueues,
	ClientActions<
		TUserActions,
		ActionContext<
			TState,
			TConnParams,
			TConnState,
			TVars,
			TInput,
			NanocodexDatabaseProvider,
			TEvents,
			TQueues
		>
	> &
		NanocodexActions
> {
	const { transport, agent, ...appConfig } = config;
	const options: NanocodexOptions = { transport, agent };
	// SAFETY: NanocodexActorConfigInput checked the app's config at the call
	// site. TypeScript cannot relate RivetKit's generic hook and action types
	// to the concrete shapes nanocodex() calls them with; they differ only in
	// the state and vars type parameters, which this function never reads.
	const {
		vars: appVars,
		createVars: appCreateVars,
		onWake: appOnWake,
		onSleep: appOnSleep,
		onDestroy: appOnDestroy,
		actions: appActions = {},
		events: appEvents = {},
		options: appOptions,
		db: appDb,
		...passThrough
	} = appConfig as WrappedActorConfig;
	if (appDb !== undefined) {
		throw new Error(
			"nanocodex() owns the actor database; remove the db option",
		);
	}
	const builtInActions = createNanocodexActions(options);
	for (const [kind, custom, builtIn] of [
		["action", appActions, builtInActions],
		["event", appEvents, nanocodexEvents],
	] as const) {
		for (const key of Object.keys(custom)) {
			if (key in builtIn) {
				throw new Error(`nanocodex() ${kind} name is reserved: ${key}`);
			}
		}
	}

	const sleepGracePeriod =
		appOptions?.sleepGracePeriod ?? DEFAULT_SLEEP_GRACE_PERIOD_MS;
	// SAFETY: the config is the app's own plus the built-in actions and
	// events, which is exactly the declared definition. RivetKit's `actor()`
	// cannot infer that definition from the wrapped hooks.
	return actor({
		...passThrough,
		options: {
			actionTimeout: DEFAULT_ACTION_TIMEOUT_MS,
			sleepGracePeriod: DEFAULT_SLEEP_GRACE_PERIOD_MS,
			...appOptions,
		},
		db: db({ onMigrate: migrateNanocodexTables }),
		events: { ...appEvents, ...nanocodexEvents },
		// The runtime slot rides on the app's vars, so `createVars` replaces `vars`.
		createVars: async (c: unknown, driverCtx: unknown) => {
			const vars = appCreateVars
				? await appCreateVars(c, driverCtx)
				: structuredClone(appVars);
			if (vars === undefined) {
				return { [NANOCODEX_RUNTIME]: createNanocodexRuntime() };
			}
			if (typeof vars !== "object" || vars === null) {
				throw new Error("nanocodex() requires actor vars to be an object");
			}
			return Object.assign(vars, {
				[NANOCODEX_RUNTIME]: createNanocodexRuntime(),
			});
		},
		onWake: async (c: NanocodexContext) => {
			nanocodexRuntime(c).actor = c;
			await appOnWake?.(c);
		},
		onSleep: async (c: NanocodexContext) => {
			// RivetKit's grace deadline starts just before onSleep runs.
			const drainUntil =
				Date.now() +
				sleepGracePeriod -
				Math.min(MAX_CLOSE_RESERVE_MS, sleepGracePeriod / 4);
			try {
				await appOnSleep?.(c);
			} finally {
				await closeNanocodex(c, { reason: "sleep", drainUntil });
			}
		},
		onDestroy: async (c: NanocodexContext) => {
			try {
				await appOnDestroy?.(c);
			} finally {
				await closeNanocodex(c, { reason: "destroy" });
			}
		},
		actions: {
			...withNanocodexAccess(appActions, options),
			...builtInActions,
		},
	} as never) as never;
}

/**
 * Wraps each of the app's actions, including nested ones, so `c.nanocodex`
 * is the open agent. Code that never reads `c.nanocodex` runs even when the
 * agent cannot open; reading it throws the open error.
 */
function withNanocodexAccess(
	actions: ActionTree,
	options: NanocodexOptions,
): ActionTree {
	return Object.fromEntries(
		Object.entries(actions).map(([name, action]) => [
			name,
			typeof action === "function"
				? async (c: NanocodexContext, ...args: unknown[]) => {
						try {
							const { agent } = await ensureAgent(c, options);
							Object.defineProperty(c, "nanocodex", {
								value: agent,
								configurable: true,
							});
						} catch (error) {
							c.log.warn({
								msg: "nanocodex agent could not open; reading c.nanocodex throws this error",
								error,
							});
							Object.defineProperty(c, "nanocodex", {
								get: () => {
									throw error;
								},
								configurable: true,
							});
						}
						return action(c, ...args);
					}
				: withNanocodexAccess(action, options),
		]),
	);
}
