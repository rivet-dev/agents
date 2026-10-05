import type {
	AgentSession,
	AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
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
	event,
	type QueueSchemaConfig,
	type SleepContext,
	type Type,
	type WakeContext,
} from "rivetkit";
import { db } from "rivetkit/db";
import { drainDeadline } from "./drain.js";
import { createPiActions, type PiActions } from "./actions.js";
import {
	type ClientActions,
	type DistributiveOmit,
	wrapActions,
} from "./actor-types.js";
import {
	closePiSession,
	createPiRuntime,
	PI_RUNTIME,
	type PiContext,
	type PiDatabaseProvider,
	type PiSessionOptions,
	resumeInterruptedRun,
	stopRunWhenLost,
	withPiSession,
} from "./runtime.js";
import { migratePiTables } from "./storage.js";

/** Ten minutes. Pi actions such as `waitForIdle` and `compact` outlive RivetKit's one-minute default. */
const DEFAULT_ACTION_TIMEOUT_MS = 10 * 60_000;

/**
 * Fifteen minutes, so a running model call or tool call can finish before a
 * deploy moves the actor. The engine's stop threshold still bounds it.
 */
const DEFAULT_SLEEP_GRACE_PERIOD_MS = 15 * 60_000;

/** Every Pi `AgentSessionEvent`, in order, for connected clients. */
export type PiEvents = {
	event: Type<AgentSessionEvent>;
};

const piEvents: PiEvents = {
	event: event<AgentSessionEvent>(),
};

const piOptionKeys = [
	"cwd",
	"agentDir",
	"providers",
	"apiKeys",
	"credentials",
	"model",
	"thinkingLevel",
	"scopedModels",
	"noTools",
	"tools",
	"excludeTools",
	"customTools",
	"resourceLoader",
	"sessionStartEvent",
	"settings",
	"sandbox",
] as const satisfies readonly (keyof PiSessionOptions)[];

/**
 * `c.pi`: the actor's Pi session, in the app's own actions and hooks. Reading
 * it throws when the session cannot open, such as while the sandbox provider
 * is down. In `onSleep` and `onDestroy` it is set only when the session is
 * already open in this actor generation.
 */
export interface PiAccess {
	readonly pi: AgentSession;
}

/** The app's own actions, which get `c.pi`. Nested objects become dotted action names. */
export interface PiUserActions<
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
					PiAccess,
				...args: any[]
		  ) => any)
		| PiUserActions<
				TState,
				TConnParams,
				TConnState,
				TVars,
				TInput,
				TEvents,
				TQueues
		  >;
}

/** Lifecycle hooks that get `c.pi`. */
interface PiHooks<
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
			PiAccess,
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
			PiAccess,
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
			PiAccess,
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
			PiAccess,
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
			PiAccess,
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

type WrappedKey = "actions" | keyof PiHooks<any, any, any, any, any, any, any>;

export type PiActorConfigInput<
	TState = undefined,
	TConnParams = undefined,
	TConnState = undefined,
	TVars = undefined,
	TInput = undefined,
	TEvents extends EventSchemaConfig = Record<never, never>,
	TQueues extends QueueSchemaConfig = Record<never, never>,
	TUserActions extends PiUserActions<
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
	PiHooks<TState, TConnParams, TConnState, TVars, TInput, TEvents, TQueues> &
	PiSessionOptions & { actions?: TUserActions };

/**
 * Defines a Rivet Actor that owns one Pi coding-agent session.
 *
 * The session transcript and settings live in the actor's SQLite database and
 * are restored when the actor wakes. Pi events are broadcast on `event`.
 * Ordinary actor config (state, vars, actions, events, hooks) is passed through.
 * The app's own actions and lifecycle hooks get the session as `c.pi`.
 */
export function pi<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig = Record<never, never>,
	TQueues extends QueueSchemaConfig = Record<never, never>,
	TUserActions extends PiUserActions<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		TEvents,
		TQueues
	> = PiUserActions<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		TEvents,
		TQueues
	>,
>(
	config: PiActorConfigInput<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		TEvents,
		TQueues,
		TUserActions
	> = {} as PiActorConfigInput<
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
	TEvents & PiEvents,
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
		PiActions
> {
	const { actorConfig, sessionOptions } = splitConfig(config);
	if (actorConfig.db !== undefined) {
		throw new Error("pi() owns the actor database; remove the db option");
	}
	const actions = createPiActions(sessionOptions);
	assertNoReservedKeys("action", actorConfig.actions, actions);
	assertNoReservedKeys("event", actorConfig.events, piEvents);

	const withPi = <TArgs extends unknown[]>(
		hook: ((c: PiContext, ...args: TArgs) => unknown) | undefined,
		opensSession = true,
	) =>
		hook &&
		((c: PiContext, ...args: TArgs) =>
			withPiSession(c, sessionOptions, () => hook(c, ...args), {
				opensSession,
			}));
	const userVars = actorConfig.vars;
	const userCreateVars = actorConfig.createVars;
	const userOnWake = withPi(actorConfig.onWake);
	const userOnSleep = withPi(actorConfig.onSleep, false);
	const userOnDestroy = withPi(actorConfig.onDestroy, false);
	delete actorConfig.vars;
	const sleepGracePeriod: number =
		actorConfig.options?.sleepGracePeriod ?? DEFAULT_SLEEP_GRACE_PERIOD_MS;

	return actor({
		...actorConfig,
		options: {
			actionTimeout: DEFAULT_ACTION_TIMEOUT_MS,
			sleepGracePeriod: DEFAULT_SLEEP_GRACE_PERIOD_MS,
			...actorConfig.options,
		},
		db: db({ onMigrate: migratePiTables }),
		events: { ...(actorConfig.events ?? {}), ...piEvents },
		actions: {
			...wrapActions(actorConfig.actions ?? {}, (c: PiContext, action) =>
				withPiSession(c, sessionOptions, action),
			),
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
		onWake: async (c: PiContext) => {
			stopRunWhenLost(c);
			await userOnWake?.(c);
			await resumeInterruptedRun(c, sessionOptions).catch((error: unknown) => {
				c.log.error({
					msg: "pi could not resume the run that was active when the actor stopped",
					error,
				});
			});
		},
		onConnect: withPi(actorConfig.onConnect),
		onDisconnect: withPi(actorConfig.onDisconnect),
		onSleep: async (c: PiContext) => {
			const drainUntil = drainDeadline(sleepGracePeriod);
			try {
				await userOnSleep?.(c);
			} finally {
				await closePiSession(c, sessionOptions, {
					reason: "sleep",
					drainUntil,
				});
			}
		},
		onDestroy: async (c: PiContext) => {
			try {
				await userOnDestroy?.(c);
			} finally {
				await closePiSession(c, sessionOptions, { reason: "destroy" });
			}
		},
	} as any) as any;
}

function splitConfig(config: object): {
	actorConfig: Record<string, any>;
	sessionOptions: PiSessionOptions;
} {
	const actorConfig: Record<string, any> = { ...config };
	const sessionOptions: Record<string, unknown> = {};
	for (const key of piOptionKeys) {
		if (key in actorConfig) {
			sessionOptions[key] = actorConfig[key];
			delete actorConfig[key];
		}
	}
	return { actorConfig, sessionOptions: sessionOptions as PiSessionOptions };
}

/** Adds the Pi runtime slot to the user's vars without changing their shape. */
function attachRuntime(vars: unknown): object {
	const runtime = createPiRuntime();
	if (vars === undefined) {
		return { [PI_RUNTIME]: runtime };
	}
	if (typeof vars !== "object" || vars === null) {
		throw new Error("pi() requires actor vars to be an object");
	}
	return Object.assign(vars, { [PI_RUNTIME]: runtime });
}

function assertNoReservedKeys(
	kind: string,
	custom: object | undefined,
	builtIns: object,
): void {
	for (const key of Object.keys(custom ?? {})) {
		if (key in builtIns) {
			throw new Error(`pi() ${kind} name is reserved: ${key}`);
		}
	}
}
