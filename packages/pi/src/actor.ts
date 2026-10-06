import type {
	AgentSession,
	AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
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
import type {
	PiActorDefinition,
	UserActions,
	UserActorConfig,
} from "./actor-types.js";
import {
	closePiSession,
	createPiRuntime,
	PI_RUNTIME,
	type PiContext,
	type PiSessionOptions,
	resumeInterruptedRun,
	stopRunWhenLost,
	withPiSession,
} from "./runtime.js";
import { migratePiTables } from "./storage.js";

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

/** Ordinary actor config plus Pi's session options. The app's actions and lifecycle hooks get `c.pi`. */
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
> = UserActorConfig<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents,
	TQueues,
	TUserActions,
	PiSessionOptions,
	PiAccess
>;

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
	const { actorConfig, options: sessionOptions } =
		splitConfig<PiSessionOptions>(config, piOptionKeys);
	if (actorConfig.db !== undefined) {
		throw new Error("pi() owns the actor database; remove the db option");
	}
	const actions = createPiActions(sessionOptions);
	assertNoReservedNames("pi()", actorConfig, {
		action: actions,
		event: piEvents,
	});

	const withPi = <TArgs extends unknown[]>(
		hook: ((c: PiContext, ...args: TArgs) => unknown) | undefined,
		opensSession = true,
	) =>
		hook &&
		((c: PiContext, ...args: TArgs) =>
			withPiSession(c, sessionOptions, () => hook(c, ...args), {
				opensSession,
			}));
	const userOnWake = withPi(actorConfig.onWake);

	// The config is built from untyped parts, so `actor()` cannot check it
	// against the generics. The declared return type is the public contract.
	return actor({
		...sharedActorConfig(
			"pi()",
			actorConfig,
			{ slot: PI_RUNTIME, create: createPiRuntime },
			(c, stop) => closePiSession(c, sessionOptions, stop),
			{
				onSleep: withPi(actorConfig.onSleep, false),
				onDestroy: withPi(actorConfig.onDestroy, false),
			},
		),
		db: db({ onMigrate: migratePiTables }),
		events: { ...(actorConfig.events ?? {}), ...piEvents },
		actions: {
			...wrapActions(actorConfig.actions ?? {}, (c: PiContext, action) =>
				withPiSession(c, sessionOptions, action),
			),
			...actions,
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
	} as any);
}
