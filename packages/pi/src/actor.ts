import { createRegistry, type Harness } from "@earendil-works/pi-durable";
import {
	type ActionContext,
	type ActorContext,
	type ActorDefinition,
	actor,
	type EventSchemaConfig,
	event,
	type QueueSchemaConfig,
	type Type,
} from "rivetkit";
import { db } from "rivetkit/db";
import { createPiActions, type PiActions } from "./actions.js";
import {
	assertNoReservedNames,
	sharedActorConfig,
	splitConfig,
	wrapActions,
} from "./actor-config.js";
import { actorExtension, type PiHooks, type PiTool } from "./actor-tools.js";
import type {
	PiActorDefinition,
	UserActions,
	UserActorConfig,
} from "./actor-types.js";
import type { PiAnswer } from "./answers.js";
import { withExtension } from "./registry.js";
import {
	closeHarness,
	createPiRuntime,
	exposePi,
	openOnWake,
	PI_RUNTIME,
	type PiContext,
	type PiDatabaseProvider,
	type PiOptions,
	piRuntime,
	piStopping,
	type ResolvedPiOptions,
	withPiAccess,
} from "./runtime.js";
import { migratePiTables } from "./storage.js";
import {
	type PiDocFrame,
	type PiTaskGraphFrame,
	type PiViewFrame,
	unwatchConnection,
} from "./watches.js";

/** Watch frames, sent only to the connection that asked. See `PiWatchEvents`. */
export type PiEvents = {
	"pi.view": Type<PiViewFrame>;
	"pi.taskGraph": Type<PiTaskGraphFrame>;
	"pi.doc": Type<PiDocFrame>;
};

const piEvents: PiEvents = {
	"pi.view": event<PiViewFrame>(),
	"pi.taskGraph": event<PiTaskGraphFrame>(),
	"pi.doc": event<PiDocFrame>(),
};

/**
 * `c.pi`: the actor's Pi Durable harness, in the app's own actions and hooks,
 * `run`, `onRequest`, `onWebSocket`, `onBeforeActionResponse`, and `onAnswer`.
 * Reading it throws when Pi Durable cannot open, such as after a rollback to
 * an older schema. In `onSleep` and `onDestroy` it is set only when Pi
 * Durable is already open in this actor generation.
 */
export interface PiAccess {
	readonly pi: Harness;
}

/**
 * The `c` of an actor's actions, for typing a helper function:
 * `function helper(c: PiActionContext<typeof agent>)`. Keeps the actor's types,
 * such as `c.conn.state`, and adds `c.pi`.
 */
export type PiActionContext<TActor> =
	TActor extends ActorDefinition<
		infer TState,
		infer TConnParams,
		infer TConnState,
		infer TVars,
		infer TInput,
		infer TDatabase,
		infer TEvents,
		infer TQueues,
		any
	>
		? ActionContext<
				TState,
				TConnParams,
				TConnState,
				TVars,
				TInput,
				TDatabase,
				TEvents,
				TQueues
			> &
				PiAccess
		: never;

/** The app's own actions, which get `c.pi`. Nested objects become dotted action names. */
export type PiUserActions<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig,
	TQueues extends QueueSchemaConfig,
> = UserActions<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents,
	TQueues,
	PiAccess
>;

/**
 * The `c` of the app's Pi `tools`, `hooks`, and `onAnswer`: the actor's
 * context with `c.pi`. They run in the background, with no connection.
 */
export type PiToolContext<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig,
	TQueues extends QueueSchemaConfig,
> = ActorContext<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	PiDatabaseProvider,
	TEvents,
	TQueues
> &
	PiAccess;

/** The Pi options with `tools`, `hooks`, and `onAnswer` typed to get the actor's context. */
type PiConfigOptions<TContext, TTools> = Omit<
	PiOptions,
	"tools" | "hooks" | "onAnswer"
> & {
	/**
	 * Tools defined like actions, by name. `execute(c, args, api, context)`
	 * gets the actor's context first, and `args` typed from `parameters`.
	 */
	tools?: { [K in keyof TTools]: PiTool<TContext, TTools[K] & object> };
	/** Pi Durable's hooks with the actor's context first, such as `beforeTool(c, call, api, context)`. */
	hooks?: PiHooks<TContext>;
	/**
	 * Called with the actor's context for every final answer, such as to text
	 * it to the user. A run that resumes after a crash can call it again for
	 * the same answer if it didn't return. A throw goes to `onReport` and
	 * leaves the run as it is.
	 */
	onAnswer?: (c: TContext, answer: PiAnswer) => void | Promise<void>;
};

/** Ordinary actor config plus the Pi Durable options. The app's actions, lifecycle hooks, Pi tools, and Pi hooks get `c.pi`. */
export type PiActorConfigInput<
	TState = undefined,
	TConnParams = undefined,
	TConnState = undefined,
	TVars = undefined,
	TInput = undefined,
	TEvents extends EventSchemaConfig = Record<never, never>,
	TQueues extends QueueSchemaConfig = Record<never, never>,
	TUserActions extends Record<string, unknown> = Record<never, never>,
	TTools = Record<never, never>,
> = UserActorConfig<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents,
	TQueues,
	TUserActions,
	PiConfigOptions<
		PiToolContext<
			TState,
			TConnParams,
			TConnState,
			TVars,
			TInput,
			TEvents,
			TQueues
		>,
		TTools
	>,
	PiAccess
>;

const piOptionKeys = [
	"registry",
	"tools",
	"hooks",
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
	"onAnswer",
] as const satisfies readonly (keyof PiOptions)[];

/**
 * Defines a Rivet Actor that owns one Pi Durable harness.
 *
 * Pi Durable stores conversations, tasks, and documents in the actor's SQLite
 * database. Runs survive sleep, upgrades, and crashes, and resume when the
 * actor wakes. The actions match Pi Durable's API one to one. The app's own
 * actions and lifecycle hooks get the harness as `c.pi`. Its `tools` and
 * `hooks` are defined like actions and get the actor's context first.
 */
export function pi<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig = Record<never, never>,
	TQueues extends QueueSchemaConfig = Record<never, never>,
	TUserActions extends Record<string, unknown> = Record<never, never>,
	TTools = Record<never, never>,
>(
	config: PiActorConfigInput<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		TEvents,
		TQueues,
		TUserActions,
		TTools
	>,
): PiActorDefinition<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents,
	TQueues,
	TUserActions,
	PiEvents,
	PiActions
> {
	const { actorConfig, options } = splitConfig<PiOptions>(config, piOptionKeys);
	const registry = options.registry ?? createRegistry();
	const extension = actorExtension(options.tools, options.hooks);
	const piOptions: ResolvedPiOptions = {
		...options,
		registry,
		...(extension &&
			withExtension({ registry, settings: options.settings }, extension)),
	};
	if (actorConfig.db !== undefined) {
		throw new Error("pi() owns the actor database; remove the db option");
	}
	const actions = createPiActions(piOptions);
	assertNoReservedNames("pi()", actorConfig, {
		action: actions,
		event: piEvents,
	});

	const withPi = <TArgs extends unknown[]>(
		hook: ((c: PiContext, ...args: TArgs) => unknown) | undefined,
		opensHarness = true,
	) =>
		hook &&
		((c: PiContext, ...args: TArgs) =>
			withPiAccess(c, piOptions, () => hook(c, ...args), {
				opensHarness,
			}));
	// `onWake` opens Pi Durable before `run` starts, so `run` only needs the
	// getter. It is not a counted call: one that lasts for the whole generation
	// would hold every sleep's drain until its deadline.
	const exposingPi = (run: (c: PiContext) => unknown) => (c: PiContext) => {
		exposePi(c);
		return run(c);
	};
	// A workflow's run function carries its config on symbol keys, so the wrapper keeps them.
	const withPiRun = (run: unknown) => {
		if (typeof run === "function") {
			const wrapped = exposingPi(run as (c: PiContext) => unknown);
			for (const key of Object.getOwnPropertySymbols(run)) {
				Object.defineProperty(
					wrapped,
					key,
					Object.getOwnPropertyDescriptor(run, key) as PropertyDescriptor,
				);
			}
			return wrapped;
		}
		const config = run as { run?: (c: PiContext) => unknown } | undefined;
		return config?.run ? { ...config, run: exposingPi(config.run) } : run;
	};
	const userOnWake = actorConfig.onWake;
	const userOnDisconnect = withPi(actorConfig.onDisconnect);

	// The config is built from untyped parts, so `actor()` cannot check it
	// against the generics. The declared return type is the public contract.
	return actor({
		...sharedActorConfig(
			"pi()",
			actorConfig,
			{ slot: PI_RUNTIME, create: createPiRuntime },
			(c, stop) => closeHarness(c, piOptions, stop),
			{
				onSleep: withPi(actorConfig.onSleep, false),
				onDestroy: withPi(actorConfig.onDestroy, false),
			},
		),
		db: db({ onMigrate: migratePiTables }),
		events: { ...(actorConfig.events ?? {}), ...piEvents },
		actions: {
			...wrapActions(actorConfig.actions ?? {}, (c: PiContext, action) =>
				withPiAccess(c, piOptions, action),
			),
			...actions,
		},
		// Opening on wake resumes interrupted work, after the app's own onWake.
		onWake: async (c: PiContext) => {
			let harness: Harness;
			try {
				harness = await openOnWake(c, piOptions);
			} catch (error) {
				// The actor stays up so actions can report the cause, such as a
				// schema newer than the code. Using c.pi throws it.
				c.log.error({
					msg: "pi durable could not open on wake; actions will retry",
					error,
				});
				exposePi(c);
				return userOnWake?.(c);
			}
			try {
				await userOnWake?.(c);
			} finally {
				harness.resume();
			}
		},
		run: withPiRun(actorConfig.run),
		onBeforeActionResponse: withPi(actorConfig.onBeforeActionResponse),
		onRequest: withPi(actorConfig.onRequest),
		onWebSocket: withPi(actorConfig.onWebSocket),
		onConnect: withPi(actorConfig.onConnect),
		onDisconnect: async (c: PiContext, conn: { id: string }) => {
			// Shutdown runs onDisconnect in the same window as onSleep and
			// onDestroy, in no set order, and those close Pi Durable. So a
			// disconnect during shutdown never uses Pi, and its watches end when
			// the harness closes.
			if (c.abortSignal.aborted || piRuntime(c).status !== "open") {
				exposePi(c, piStopping());
				await actorConfig.onDisconnect?.(c, conn);
				return;
			}
			try {
				await userOnDisconnect?.(c, conn);
			} finally {
				const runtime = piRuntime(c);
				await unwatchConnection(runtime.actor ?? c, runtime.watches, conn.id);
			}
		},
	} as any);
}
