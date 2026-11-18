import type { EventSchemaConfig, QueueSchemaConfig } from "rivetkit";
import type { PiActions, PiPromptOptions, PiPromptResult } from "./actions.js";
import {
	type PiAccess,
	type PiActorConfigInput,
	type PiEvents,
	type PiUserActions,
	pi,
} from "./actor.js";
import type { PiOptions } from "./runtime.js";

export * from "./index.js";

/** @deprecated Use `pi()` from `@rivet-dev/pi`. `piDurable()` is the same actor under its old name. */
export const piDurable = pi;

/** @deprecated Use `PiActions` from `@rivet-dev/pi`. */
export type PiDurableActions = PiActions;
/** @deprecated Use `PiPromptOptions` from `@rivet-dev/pi`. */
export type PiDurablePromptOptions = PiPromptOptions;
/** @deprecated Use `PiPromptResult` from `@rivet-dev/pi`. */
export type PiDurablePromptResult = PiPromptResult;
/** @deprecated Use `PiAccess` from `@rivet-dev/pi`. */
export type PiDurableAccess = PiAccess;
/** @deprecated Use `PiActorConfigInput` from `@rivet-dev/pi`. */
export type PiDurableActorConfigInput<
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
> = PiActorConfigInput<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents,
	TQueues,
	TUserActions
>;
/** @deprecated Use `PiEvents` from `@rivet-dev/pi`. */
export type PiDurableEvents = PiEvents;
/** @deprecated Use `PiUserActions` from `@rivet-dev/pi`. */
export type PiDurableUserActions<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents extends EventSchemaConfig,
	TQueues extends QueueSchemaConfig,
> = PiUserActions<
	TState,
	TConnParams,
	TConnState,
	TVars,
	TInput,
	TEvents,
	TQueues
>;
/** @deprecated Use `PiOptions` from `@rivet-dev/pi`. */
export type PiDurableOptions = PiOptions;
