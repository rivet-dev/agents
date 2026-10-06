import type {
	ActionContext,
	ActorConfigInput,
	ActorDefinition,
	Conn,
	ConnectContext,
	DestroyContext,
	DisconnectContext,
	EventSchemaConfig,
	QueueSchemaConfig,
	SleepContext,
	WakeContext,
} from "rivetkit";
import type { PiDatabaseProvider } from "./runtime.js";

/** `Omit` that keeps each member of a union, so `state` and `createState` stay alternatives. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

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

/**
 * The app's own actions, which get `c.pi` through `TAccess`. Nested objects
 * become dotted action names.
 */
export interface UserActions<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig,
	TQueues extends QueueSchemaConfig,
	TAccess,
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
					TAccess,
				...args: any[]
		  ) => any)
		| UserActions<
				TState,
				TConnParams,
				TConnState,
				TVars,
				TInput,
				TEvents,
				TQueues,
				TAccess
		  >;
}

/** Lifecycle hooks that get `c.pi` through `TAccess`. */
interface UserHooks<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig,
	TQueues extends QueueSchemaConfig,
	TAccess,
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
			TAccess,
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
			TAccess,
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
			TAccess,
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
			TAccess,
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
			TAccess,
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

/**
 * Ordinary actor config with the app's actions and hooks typed to get `c.pi`,
 * plus the Pi options in `TOptions`.
 */
export type UserActorConfig<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig,
	TQueues extends QueueSchemaConfig,
	TUserActions,
	TOptions,
	TAccess,
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
	"actions" | keyof UserHooks<any, any, any, any, any, any, any, unknown>
> &
	UserHooks<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		TEvents,
		TQueues,
		TAccess
	> &
	TOptions & { actions?: TUserActions };

/** The actor definition clients see: the app's actions and events plus the built-in ones. */
export type PiActorDefinition<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig,
	TQueues extends QueueSchemaConfig,
	TUserActions,
	TBuiltInEvents extends EventSchemaConfig,
	TBuiltInActions,
> = ActorDefinition<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	PiDatabaseProvider,
	TEvents & TBuiltInEvents,
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
		TBuiltInActions
>;
