import type { Harness } from "@earendil-works/pi-durable";
import {
	actor,
	type EventSchemaConfig,
	event,
	type QueueSchemaConfig,
	type Type,
} from "rivetkit";
import { db } from "rivetkit/db";
import {
	assertNoReservedNames,
	sharedActorConfig,
	splitConfig,
	wrapActions,
} from "../actor-config.js";
import type {
	PiActorDefinition,
	UserActions,
	UserActorConfig,
} from "../actor-types.js";
import { type PiContext, withUnavailablePi } from "../runtime.js";
import { createPiDurableActions, type PiDurableActions } from "./actions.js";
import {
	closeHarness,
	createPiDurableRuntime,
	openOnWake,
	PI_DURABLE_RUNTIME,
	type PiDurableOptions,
	piDurableRuntime,
	withPiAccess,
} from "./runtime.js";
import { migratePiDurableTables } from "./storage.js";
import {
	type PiDocFrame,
	type PiEventsFrame,
	type PiTaskGraphFrame,
	type PiViewFrame,
	unwatchConnection,
} from "./watches.js";

/** Watch frames, sent only to the connection that asked. See `PiWatchEvents`. */
export type PiDurableEvents = {
	"pi.events": Type<PiEventsFrame>;
	"pi.view": Type<PiViewFrame>;
	"pi.taskGraph": Type<PiTaskGraphFrame>;
	"pi.doc": Type<PiDocFrame>;
};

const piDurableEvents: PiDurableEvents = {
	"pi.events": event<PiEventsFrame>(),
	"pi.view": event<PiViewFrame>(),
	"pi.taskGraph": event<PiTaskGraphFrame>(),
	"pi.doc": event<PiDocFrame>(),
};

/**
 * `c.pi`: the actor's Pi Durable harness, in the app's own actions and hooks.
 * Reading it throws when Pi Durable cannot open, such as after a rollback to
 * an older schema. In `onSleep` and `onDestroy` it is set only when Pi Durable
 * is already open in this actor generation.
 */
export interface PiDurableAccess {
	readonly pi: Harness;
}

/** The app's own actions, which get `c.pi`. Nested objects become dotted action names. */
export type PiDurableUserActions<
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
	PiDurableAccess
>;

/** Ordinary actor config plus the Pi Durable options. The app's actions and lifecycle hooks get `c.pi`. */
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
> = UserActorConfig<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents,
	TQueues,
	TUserActions,
	PiDurableOptions,
	PiDurableAccess
>;

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
): PiActorDefinition<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents,
	TQueues,
	TUserActions,
	PiDurableEvents,
	PiDurableActions
> {
	const { actorConfig, options: durableOptions } =
		splitConfig<PiDurableOptions>(config, piDurableOptionKeys);
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
	assertNoReservedNames("piDurable()", actorConfig, {
		action: actions,
		event: piDurableEvents,
	});

	const withPi = <TArgs extends unknown[]>(
		hook: ((c: PiContext, ...args: TArgs) => unknown) | undefined,
		opensHarness = true,
	) =>
		hook &&
		((c: PiContext, ...args: TArgs) =>
			withPiAccess(c, durableOptions, () => hook(c, ...args), {
				opensHarness,
			}));
	const userOnWake = actorConfig.onWake;
	const userOnDisconnect = withPi(actorConfig.onDisconnect);

	// The config is built from untyped parts, so `actor()` cannot check it
	// against the generics. The declared return type is the public contract.
	return actor({
		...sharedActorConfig(
			"piDurable()",
			actorConfig,
			{ slot: PI_DURABLE_RUNTIME, create: createPiDurableRuntime },
			(c, stop) => closeHarness(c, durableOptions, stop),
			{
				onSleep: withPi(actorConfig.onSleep, false),
				onDestroy: withPi(actorConfig.onDestroy, false),
			},
		),
		db: db({ onMigrate: migratePiDurableTables }),
		events: { ...(actorConfig.events ?? {}), ...piDurableEvents },
		actions: {
			...wrapActions(actorConfig.actions ?? {}, (c: PiContext, action) =>
				withPiAccess(c, durableOptions, action),
			),
			...actions,
		},
		// Opening on wake resumes interrupted work, after the app's own onWake.
		onWake: async (c: PiContext) => {
			let harness: Harness;
			try {
				harness = await openOnWake(c, durableOptions);
			} catch (error) {
				// The actor stays up so actions can report the cause, such as a
				// schema newer than the code. Using c.pi throws it.
				c.log.error({
					msg: "pi durable could not open on wake; actions will retry",
					error,
				});
				return withUnavailablePi(c, error, () => userOnWake?.(c));
			}
			Object.defineProperty(c, "pi", { value: harness, configurable: true });
			try {
				await userOnWake?.(c);
			} finally {
				harness.resume();
			}
		},
		onConnect: withPi(actorConfig.onConnect),
		onDisconnect: async (c: PiContext, conn: { id: string }) => {
			try {
				await userOnDisconnect?.(c, conn);
			} finally {
				const runtime = piDurableRuntime(c);
				await unwatchConnection(runtime.actor ?? c, runtime.watches, conn.id);
			}
		},
	} as any);
}
