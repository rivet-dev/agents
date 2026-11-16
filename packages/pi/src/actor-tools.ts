import type { Context, JsonValue } from "@earendil-works/chord";
import { createContextKey } from "@earendil-works/chord/context";
import {
	type AnyTask,
	type CompactionHooks,
	CompactionTask,
	defineExtension,
	type Extension,
	type GenerationHooks,
	GenerationTask,
	type HookRegistration,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolHooks,
	type ToolRegistration,
	ToolTask,
} from "@earendil-works/pi-durable";
import type { PiContext } from "./runtime.js";

/** The extension that holds the app's `tools` and `hooks`. Conversations that use the default selection get it. */
export const ACTOR_EXTENSION = "rivet-pi-actor";

/**
 * The actor's context, carried by the context the harness opens with. Pi
 * derives the context of every task from it, so a tool or hook finds the
 * actor it runs in, also after a wake and in conversations a tool creates.
 */
export const PI_ACTOR_CONTEXT = createContextKey<PiContext>(
	"@rivet-dev/pi/actor-context",
);

/** The arguments a tool with parameter schema `TParameters` gets. */
type ToolArgs<TParameters extends object> = Parameters<
	ToolRegistration<TParameters>["execute"]
>[0];

/**
 * A tool defined like an action: Pi Durable's `ToolRegistration` without
 * `name`, which is its key in `tools`, and with the actor's context as the
 * first argument of `execute`. `args` are typed from `parameters`.
 */
export type PiTool<
	TContext,
	TParameters extends object = any,
	TDetails extends JsonValue = JsonValue,
> = Omit<ToolRegistration<TParameters, TDetails>, "name" | "execute"> & {
	execute(
		c: TContext,
		args: ToolArgs<TParameters>,
		api: ToolExecutionApi<TDetails>,
		context: Context,
	): ToolExecutionResult<TDetails> | Promise<ToolExecutionResult<TDetails>>;
};

type AllHooks = GenerationHooks & ToolHooks & CompactionHooks;

/** Pi Durable's hooks, each with the actor's context as its first argument, such as `beforeTool(c, call, api, context)`. */
export type PiHooks<TContext> = {
	[K in keyof AllHooks]?: (
		c: TContext,
		...args: Parameters<AllHooks[K]>
	) => ReturnType<AllHooks[K]>;
};

/** The task each hook belongs to. Hook names are unique across Pi Durable's built-in tasks. */
const HOOK_TASKS: Record<keyof AllHooks, AnyTask> = {
	beforeRequest: GenerationTask,
	beforeProviderRequest: GenerationTask,
	afterResponse: GenerationTask,
	onYield: GenerationTask,
	afterTools: GenerationTask,
	afterRun: GenerationTask,
	beforeTool: ToolTask,
	afterTool: ToolTask,
	beforeCompact: CompactionTask,
};

/** The extension that runs the app's `tools` and `hooks` with the actor's context, or none when there are neither. */
export function actorExtension(
	tools: Record<string, PiTool<PiContext>> = {},
	hooks: PiHooks<PiContext> = {},
): Extension | undefined {
	const toolNames = Object.keys(tools);
	const hookNames = Object.keys(hooks) as (keyof AllHooks)[];
	if (toolNames.length === 0 && hookNames.length === 0) return undefined;

	// By task name, as `hook()` registers them.
	const handlers = new Map<string, Record<string, unknown>>();
	for (const name of hookNames) {
		const handler = hooks[name] as
			| ((c: PiContext, ...args: unknown[]) => unknown)
			| undefined;
		if (!handler) continue;
		const task = HOOK_TASKS[name]?.definition.name;
		if (!task) throw new Error(`pi() hooks: ${name} is not a Pi Durable hook`);
		const forTask = handlers.get(task) ?? {};
		// Every hook takes the context last.
		forTask[name] = (...args: unknown[]) =>
			handler(actorOf(args.at(-1) as Context), ...args);
		handlers.set(task, forTask);
	}

	return defineExtension({
		name: ACTOR_EXTENSION,
		tools: toolNames.map((name) => {
			const { execute, ...tool } = tools[name] as PiTool<PiContext>;
			return {
				...tool,
				name,
				execute: async (args, api, context) =>
					execute(actorOf(context), args, api, context),
			};
		}),
		hooks: [...handlers].map(
			([task, forTask]): HookRegistration => ({ task, handlers: forTask }),
		),
	});
}

function actorOf(context: Context): PiContext {
	const c = context.value(PI_ACTOR_CONTEXT);
	if (!c) {
		throw new Error(
			"pi() tools and hooks run only in the harness of the pi() actor that defines them",
		);
	}
	return c;
}
