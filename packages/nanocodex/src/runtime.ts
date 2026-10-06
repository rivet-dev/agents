import { createHash, randomUUID } from "node:crypto";
import type { SandboxProvider } from "@rivet-dev/sandbox-adapter";
import type {
	AgentEvent,
	DefaultAgent,
	EventWatcher,
	PromptInput,
	Turn,
	TurnUsage,
} from "nanocodex";
import { Agent, type Transport } from "nanocodex/node";
import { type ActorContext, UserError } from "rivetkit";
import type { DatabaseProvider, RawAccess } from "rivetkit/db";
import {
	type ConnectedSandbox,
	closeSandbox,
	connectSandbox,
	execCommandTool,
	sandboxWorkspace,
} from "./sandbox.js";
import { durabilityStore } from "./storage.js";

/** `Omit` that keeps each member of a union, such as nanocodex's `mcp` and `toolMode` alternatives. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

/** The database every nanocodex actor uses: RivetKit's raw SQLite access. */
export type NanocodexDatabaseProvider = DatabaseProvider<RawAccess>;

/**
 * nanocodex's own `Agent.create` options, without the ones the actor owns:
 * the transport, the durable journal, the session id, and the sandbox
 * workspace.
 */
export type NanocodexAgentOptions = DistributiveOmit<
	Agent.create.Options,
	| "transport"
	| "durability"
	| "durabilityId"
	| "sessionId"
	| "workspace"
	| "filesystem"
	| "resume"
	| "module"
>;

/**
 * Returns nanocodex's model transport, such as
 * `Transport.openAi({ apiKey })` from `nanocodex/node` or
 * `chatGptSubscription(...)`. Called once per actor generation, when the agent
 * opens. `closed` aborts when the agent closes, so the transport can release
 * what it opened.
 */
export type NanocodexTransport = (
	c: NanocodexContext,
	closed: AbortSignal,
) => Transport.ResponsesTransport | Promise<Transport.ResponsesTransport>;

/** The nanocodex options of `nanocodex()`, beside the ordinary actor config. */
export interface NanocodexOptions {
	/** How the agent reaches the model. */
	transport: NanocodexTransport;
	/**
	 * Runs the agent's file tools and `exec_command` in a sandbox. Without one,
	 * the agent has only the `tools` in `agent`.
	 */
	sandbox?: SandboxProvider;
	/**
	 * Passed to nanocodex's `Agent.create`, such as `instructions`, `model`,
	 * `tools`, and `mcp`. With a `sandbox`, `tools` must be a tool map or an
	 * array, and `exec_command` is reserved.
	 */
	agent?: NanocodexAgentOptions;
}

/** How an actor generation stops. A sleep drains until `drainUntil`; a destroy stops at once. */
export type NanocodexStop =
	| { readonly reason: "sleep"; readonly drainUntil: number }
	| { readonly reason: "destroy" };

/** What `turn.prompt` returns once the turn finishes. */
export interface NanocodexTurnResult {
	/** The turn's id. Prompting it again returns this result from the journal. */
	id: string;
	/** The agent's last message in the turn. */
	finalMessage: string;
	/** Tokens and estimated cost of the turn's model calls. */
	usage: TurnUsage;
}

interface OpenAgent {
	agent: DefaultAgent;
	events: EventWatcher;
	/** Aborts when the agent closes, which releases what the transport opened. */
	closed: AbortController;
}

interface RunningTurn {
	inputKey: string;
	turn: Promise<Turn>;
	result: Promise<NanocodexTurnResult>;
}

/** Per-actor-generation state. */
export interface NanocodexRuntime {
	/**
	 * The `onWake` context. The agent's journal, events, and sandbox use it,
	 * because an action's context ends with the action.
	 */
	actor: NanocodexContext | undefined;
	agent: Promise<OpenAgent> | undefined;
	sandbox: Promise<ConnectedSandbox> | undefined;
	/** Turns started in this generation, by id, until they settle. */
	turns: Map<string, RunningTurn>;
	/** Set when the actor starts to sleep or is destroyed. */
	closing: boolean;
}

/** The key of the runtime slot that `nanocodex()` adds to the app's vars. */
export const NANOCODEX_RUNTIME: unique symbol = Symbol.for(
	"@rivet-dev/nanocodex/runtime",
);

/** The vars every nanocodex actor has, beside the app's own. */
export interface NanocodexVars {
	readonly [NANOCODEX_RUNTIME]: NanocodexRuntime;
}

/** The actor context shape every nanocodex helper works against. */
export type NanocodexContext = ActorContext<
	unknown,
	unknown,
	unknown,
	NanocodexVars,
	unknown,
	NanocodexDatabaseProvider,
	Record<never, never>,
	Record<never, never>
>;

/** A fresh runtime slot for an actor generation. */
export function createNanocodexRuntime(): NanocodexRuntime {
	return {
		actor: undefined,
		agent: undefined,
		sandbox: undefined,
		turns: new Map(),
		closing: false,
	};
}

/** The runtime slot of this actor generation. */
export function nanocodexRuntime(c: NanocodexContext): NanocodexRuntime {
	return c.vars[NANOCODEX_RUNTIME];
}

/** Opens the agent on first use in this actor generation. */
export function ensureAgent(
	c: NanocodexContext,
	options: NanocodexOptions,
): Promise<OpenAgent> {
	const runtime = nanocodexRuntime(c);
	if (runtime.closing) {
		return Promise.reject(
			new UserError(
				"The nanocodex agent is closed because the actor is stopping.",
			),
		);
	}
	if (runtime.agent !== undefined) return runtime.agent;
	const opening: Promise<OpenAgent> = openAgent(
		runtime.actor ?? c,
		runtime,
		options,
	).catch((error: unknown) => {
		if (runtime.agent === opening) runtime.agent = undefined;
		throw error;
	});
	runtime.agent = opening;
	return opening;
}

async function openAgent(
	c: NanocodexContext,
	runtime: NanocodexRuntime,
	options: NanocodexOptions,
): Promise<OpenAgent> {
	const sessionId = sessionUuid(c.actorId);
	const sandbox = options.sandbox
		? await connectRuntimeSandbox(c, runtime, options.sandbox)
		: undefined;
	const closed = new AbortController();
	let agent: DefaultAgent;
	try {
		agent = await Agent.create({
			...options.agent,
			transport: await options.transport(c, closed.signal),
			durability: durabilityStore(c.db),
			durabilityId: sessionId,
			sessionId,
			...(sandbox
				? {
						workspace: sandbox.sandbox.cwd,
						filesystem: sandboxWorkspace(sandbox.sandbox),
						tools: withExecCommand(options.agent?.tools, sandbox),
					}
				: {}),
		});
	} catch (error) {
		closed.abort();
		throw error;
	}
	const events = agent.events.watch();
	events.onEvent((event) => broadcastAgentEvent(c, event));
	return { agent, events, closed };
}

function connectRuntimeSandbox(
	c: NanocodexContext,
	runtime: NanocodexRuntime,
	provider: SandboxProvider,
): Promise<ConnectedSandbox> {
	if (runtime.sandbox !== undefined) return runtime.sandbox;
	const connecting: Promise<ConnectedSandbox> = connectSandbox(
		c,
		provider,
	).catch((error: unknown) => {
		if (runtime.sandbox === connecting) runtime.sandbox = undefined;
		throw error;
	});
	runtime.sandbox = connecting;
	return connecting;
}

/** nanocodex's own tool configuration: a tool map, an array, or a `Tools` set. */
type AgentTools = NonNullable<NanocodexAgentOptions["tools"]>;

/** Adds `exec_command` for the sandbox to the app's own tools. */
function withExecCommand(
	tools: AgentTools | undefined,
	connected: ConnectedSandbox,
): AgentTools {
	const execCommand = execCommandTool(connected.sandbox);
	if (tools === undefined) return { exec_command: execCommand };
	if (Array.isArray(tools)) {
		if (tools.some((tool) => "name" in tool && tool.name === "exec_command")) {
			throw new Error(
				"nanocodex() reserves the exec_command tool for the sandbox",
			);
		}
		return [...tools, { ...execCommand, name: "exec_command" }];
	}
	if (Object.getPrototypeOf(tools) !== Object.prototype) {
		throw new Error(
			"nanocodex() with a sandbox takes tools as a tool map or an array",
		);
	}
	if ("exec_command" in tools) {
		throw new Error(
			"nanocodex() reserves the exec_command tool for the sandbox",
		);
	}
	return { ...tools, exec_command: execCommand };
}

/**
 * Starts a turn, or joins the turn with the same id that is already running.
 * nanocodex replays a finished turn from its journal, but two prompts with
 * the same id at once cancel the first one, so this generation keeps one
 * result per running id.
 */
export function promptTurn(
	c: NanocodexContext,
	options: NanocodexOptions,
	request: { input: PromptInput; id?: string | undefined },
): Promise<NanocodexTurnResult> {
	const runtime = nanocodexRuntime(c);
	const id = request.id ?? randomUUID();
	const inputKey = JSON.stringify(request.input);
	const running = runtime.turns.get(id);
	if (running) {
		if (running.inputKey !== inputKey) {
			return Promise.reject(
				new UserError(`turn ${id} is already running with different input`, {
					code: "conflict",
				}),
			);
		}
		return running.result;
	}
	const opened = ensureAgent(c, options);
	const turn = opened.then(({ agent }) =>
		agent.turn.prompt({ id, input: request.input }),
	);
	const result = runTurn(runtime, opened, turn, id).finally(() => {
		if (runtime.turns.get(id) === entry) runtime.turns.delete(id);
	});
	const entry: RunningTurn = { inputKey, turn, result };
	runtime.turns.set(id, entry);
	return (runtime.actor ?? c).keepAwake(result);
}

/** The running turn with this id. */
export async function runningTurn(
	c: NanocodexContext,
	id: string,
): Promise<Turn> {
	const running = nanocodexRuntime(c).turns.get(id);
	if (!running) {
		throw new UserError(`turn ${id} is not running in this actor`);
	}
	return running.turn;
}

async function runTurn(
	runtime: NanocodexRuntime,
	opened: Promise<OpenAgent>,
	started: Promise<Turn>,
	id: string,
): Promise<NanocodexTurnResult> {
	const open = await opened;
	const turn = await started;
	try {
		const result = await turn.result();
		try {
			return {
				id,
				finalMessage: result.finalMessage,
				usage: await result.usage(),
			};
		} finally {
			result.dispose();
		}
	} catch (error) {
		// A stopped agent runs no more turns, so the next call opens a new one.
		if (isNanocodexError(error) && error.code === "reopen_required") {
			if (runtime.agent === opened) runtime.agent = undefined;
			releaseAgent(open);
		}
		throw error;
	} finally {
		turn.dispose();
	}
}

/**
 * Closes the agent when the actor stops. A sleep first waits for running
 * turns until `drainUntil`; a turn still running then stays in nanocodex's
 * journal, and prompting the same id after the actor wakes resumes it. A
 * destroy cancels running turns. Then the sandbox is suspended or destroyed.
 */
export async function closeNanocodex(
	c: NanocodexContext,
	options: NanocodexOptions,
	stop: NanocodexStop,
): Promise<void> {
	const runtime = nanocodexRuntime(c);
	runtime.closing = true;
	const running = [...runtime.turns.values()];
	if (stop.reason === "sleep") {
		await untilDeadline(
			Promise.allSettled(running.map((turn) => turn.result)),
			stop.drainUntil,
		);
	} else {
		await Promise.allSettled(
			running.map(async (turn) => (await turn.turn).cancel()),
		);
	}
	try {
		// An agent that failed to open has nothing to close.
		const opened = await runtime.agent?.catch(() => undefined);
		runtime.agent = undefined;
		if (opened && stop.reason === "sleep" && runtime.turns.size > 0) {
			// A clean shutdown cancels unfinished turns. Releasing the agent
			// instead leaves them in the journal, as a crash would, so they resume.
			releaseAgent(opened);
		} else if (opened) {
			try {
				await opened.agent.session.shutdown();
			} finally {
				releaseAgent(opened);
			}
		}
	} finally {
		if (options.sandbox) {
			const connected = await runtime.sandbox?.catch(() => undefined);
			runtime.sandbox = undefined;
			await closeSandbox(c, options.sandbox, connected, stop.reason);
		}
	}
}

function releaseAgent(opened: OpenAgent): void {
	opened.events.off();
	opened.agent.dispose();
	opened.closed.abort();
}

async function untilDeadline(
	work: Promise<unknown>,
	deadline: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		work,
		new Promise((resolve) => {
			timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
		}),
	]);
	clearTimeout(timer);
}

/**
 * An error nanocodex rejects with. Its `code` is one of nanocodex's turn
 * outcomes, such as `conflict`, `cancelled`, or `reopen_required`.
 */
export function isNanocodexError(
	error: unknown,
): error is Error & { code: string } {
	return (
		error instanceof Error &&
		!(error instanceof UserError) &&
		"code" in error &&
		typeof error.code === "string"
	);
}

function broadcastAgentEvent(c: NanocodexContext, event: AgentEvent): void {
	try {
		c.broadcast("event", event);
	} catch (error) {
		if (isActorStoppingError(error)) return;
		c.log.error({ msg: "failed to broadcast nanocodex event", error });
	}
}

function isActorStoppingError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"group" in error &&
		error.group === "actor" &&
		"code" in error &&
		error.code === "stopping"
	);
}

/**
 * nanocodex session ids must be UUIDv7. Rivet actor ids are not UUIDs, so
 * the id is a stable hash of the actor id with the v7 version and variant bits.
 */
function sessionUuid(actorId: string): string {
	const hex = createHash("sha256").update(`nanocodex:${actorId}`).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
