import type {
	ActionContext,
	ActorConfigInput,
	ActorDefinition,
	BeforeActionResponseContext,
	Conn,
	ConnectContext,
	DestroyContext,
	DisconnectContext,
	EventSchemaConfig,
	QueueSchemaConfig,
	RequestContext,
	RunConfig,
	RunContext,
	SleepContext,
	StateChangeContext,
	UniversalWebSocket,
	WakeContext,
	WebSocketContext,
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

/** The run handler, which gets `c.pi` through `TAccess`. */
type UserRunHandler<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig,
	TQueues extends QueueSchemaConfig,
	TAccess,
> = (
	c: RunContext<
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

type UserRun<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig,
	TQueues extends QueueSchemaConfig,
	TAccess,
> =
	| UserRunHandler<
			TState,
			TConnParams,
			TConnState,
			TVars,
			TInput,
			TEvents,
			TQueues,
			TAccess
	  >
	| (Omit<
			RunConfig<
				TState,
				TConnParams,
				TConnState,
				TVars,
				TInput,
				PiDatabaseProvider,
				TEvents,
				TQueues
			>,
			"run"
	  > & {
			run: UserRunHandler<
				TState,
				TConnParams,
				TConnState,
				TVars,
				TInput,
				TEvents,
				TQueues,
				TAccess
			>;
	  });

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
	/** A function, or a `RunConfig` whose `run` gets `c.pi`. */
	run?: UserRun<
		TState,
		TConnParams,
		TConnState,
		TVars,
		TInput,
		TEvents,
		TQueues,
		TAccess
	>;
	/** `c.pi` is set when Pi Durable is open; it is synchronous, so it never opens Pi Durable. */
	onStateChange?: (
		c: StateChangeContext<
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
		newState: TState,
	) => void;
	onBeforeActionResponse?: <Out>(
		c: BeforeActionResponseContext<
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
		name: string,
		args: unknown[],
		output: Out,
	) => Out | Promise<Out>;
	onRequest?: (
		c: RequestContext<
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
		request: Request,
	) => Response | Promise<Response>;
	onWebSocket?: (
		c: WebSocketContext<
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
		websocket: UniversalWebSocket,
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
	TOptions & {
		// Typing `c` here rather than through a constraint on `TUserActions`
		// lets `c.conn.state` take the type `createConnState` returns.
		actions?: TUserActions &
			UserActions<
				TState,
				TConnParams,
				TConnState,
				TVars,
				TInput,
				TEvents,
				TQueues,
				TAccess
			>;
	};

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
