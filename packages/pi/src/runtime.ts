import {
	BACKGROUND_CONTEXT,
	type Context,
	withContextValue,
} from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type ConversationDocToken,
	configure,
	Harness,
	type HarnessInspection,
	type HarnessOptions,
	type HarnessSettings,
	type ModelRef,
	type Wake,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { Sandbox, SandboxProvider } from "@rivet-dev/sandbox-adapter";
import { sandboxEnv } from "@rivet-dev/sandbox-adapter/pi";
import { type ActorContext, UserError } from "rivetkit";
import type { DatabaseProvider, RawAccess } from "rivetkit/db";
import type { PiAccess } from "./actor.js";
import { actorSqlite } from "./actor-sqlite.js";
import { PI_ACTOR_CONTEXT, type PiHooks, type PiTool } from "./actor-tools.js";
import {
	ANSWER_EXTENSION,
	type PiOnAnswer,
	withAnswerHook,
} from "./answers.js";
import { SourceCredentialStore } from "./credentials.js";
import { databaseEnv } from "./database-env.js";
import { toClientError } from "./errors.js";
import {
	createActorModelRuntime,
	emptyCredentialStore,
	type PiModelOptions,
} from "./models.js";
import { loadPiSandbox, savePiSandbox } from "./storage.js";
import { createPiTelemetry, withCallerSpan } from "./tracing.js";
import {
	type ConnectionWatches,
	createConnectionWatches,
	reattachWatches,
	stopAllWatches,
} from "./watches.js";

export type PiDatabaseProvider = DatabaseProvider<RawAccess>;

/** The actor context shape every Pi helper works against. */
export type PiContext = ActorContext<
	any,
	any,
	any,
	any,
	any,
	PiDatabaseProvider,
	any,
	any
>;

/** Whether Pi Durable is open in this actor generation, or why it closed. */
export type PiStatus = "open" | "sleeping" | "destroyed";

/** How an actor generation stops. A sleep drains until `drainUntil`; a destroy stops at once. */
export type PiStop =
	| { reason: "sleep"; drainUntil: number }
	| { reason: "destroy" };

/** The sandbox Pi's tools run in for this actor generation. */
export interface ConnectedSandbox {
	provider: SandboxProvider;
	id: string;
	sandbox: Sandbox;
}

/**
 * Options accepted by `pi()` on top of ordinary actor config. The Pi
 * Durable options keep the names and types of `HarnessOptions`.
 */
export interface PiOptions extends PiModelOptions {
	/**
	 * Pi Durable's extension registry: tools, hooks, sections, tasks, and
	 * documents. Optional when `tools` and `hooks` are all the actor needs.
	 */
	registry?: HarnessOptions["registry"];
	/**
	 * Tools defined like actions, by name. `execute(c, args, api, context)`
	 * gets the actor's context first. They are installed as the extension
	 * `rivet-pi-actor`, which conversations that use the default selection get.
	 */
	tools?: Record<string, PiTool<any>>;
	/**
	 * Pi Durable's hooks with the actor's context first, such as
	 * `beforeTool(c, call, api, context)`. Installed with `tools`.
	 */
	hooks?: PiHooks<any>;
	/** pi-ai model access. Without it, the actor builds it from `model`, `providers`, `apiKeys`, and `credentials`. */
	models?: Models;
	settings?: HarnessSettings;
	/**
	 * Builds a conversation's environment. Without it, the actor builds one from
	 * `sandbox`, or stores files in its own database when there is no sandbox.
	 */
	env?: HarnessOptions["env"];
	conversationCreated?: HarnessOptions["conversationCreated"];
	now?: HarnessOptions["now"];
	onReport?: HarnessOptions["onReport"];
	/** The starting thinking level of every new conversation. */
	thinkingLevel?: ModelThinkingLevel;
	/** The starting instructions of every new conversation, rendered after the extension sections. */
	instructions?: string;
	/** The starting working directory of every new conversation. */
	cwd?: string;
	/** The most tool rounds one run of a new conversation takes. */
	maxTurns?: number;
	/** Automatic compaction, the same as `settings.compaction`. */
	compaction?: HarnessSettings["compaction"];
	/**
	 * Runs the tools of Pi's `CodingTools` extension in a sandbox. Used only
	 * when `env` is omitted. Without a sandbox, files live in the actor's
	 * database and there is no shell.
	 */
	sandbox?: SandboxProvider;
	/**
	 * Pi's file and shell tools: `read`, `write`, `edit`, and `bash`. On by
	 * default with a `sandbox`, off without one. A list installs only those
	 * tools, such as `["read", "bash"]`. Not installed again when `registry`
	 * already has them.
	 */
	codingTools?: boolean | readonly CodingToolName[];
	/** Installs Pi's tool search, which lets the model find deferred tools by name. */
	toolSearch?: boolean;
	/** App documents that clients may read by `kind` with `harness.snapshot`. */
	documents?: readonly ConversationDocToken<any>[];
	/**
	 * Called with the actor's context for every final answer, such as to text
	 * it to the user. A run that resumes after a crash can call it again for
	 * the same answer if it didn't return. A throw goes to `onReport` and
	 * leaves the run as it is.
	 */
	onAnswer?: PiOnAnswer;
}

/** A tool of Pi's `CodingTools` extension. */
export type CodingToolName = "read" | "write" | "edit" | "bash";

/** `PiOptions` as `pi()` resolved them: the registry includes the app's `tools` and `hooks`. */
export type ResolvedPiOptions = PiOptions & {
	registry: HarnessOptions["registry"];
};

/** The internal action a scheduled wake calls. */
const WAKE_ACTION = "pi.wake";

/**
 * How far ahead the recovery wake is scheduled while Pi work is active. An
 * actor whose process dies during a run resumes within about this long, plus
 * the time the engine takes to find the process gone.
 */
const RECOVERY_WAKE_MS = 15_000;

interface OpenHarness {
	harness: Harness;
	/** Calls `listener` whenever Pi's wake value changes. Returns a function that stops it. */
	onWakeChange: (listener: () => void) => () => void;
	/** Resumes Pi's due sleeps, for the scheduled `pi.wake`. */
	resumeDue: () => void;
	/** Resolves once the wake for the work a call started is written. */
	settleWake: () => Promise<void>;
	/** Arms a recovery wake for a call that can start work. Returns the function that ends the hold. */
	holdWake: () => Promise<() => void>;
	stopWake: () => void;
}

/** Per-actor-generation state, stored on `c.vars` under `PI_RUNTIME`. */
export interface PiRuntime {
	/** The open harness, or the open in progress. */
	harness?: Promise<OpenHarness>;
	sandbox?: Promise<ConnectedSandbox>;
	/** Pi Durable is open until the actor starts to sleep or is destroyed. */
	status: PiStatus;
	/** The open harness that every context's `c.pi` reads. */
	pi?: Harness;
	/** Why the last open failed. Reading `c.pi` throws it until an open succeeds. */
	piError?: unknown;
	/**
	 * The `onWake` context. Background work (keep-awake, scheduled wakes, the
	 * sandbox, reopening) uses it, because an action's context is cancelled
	 * with the action.
	 */
	actor?: PiContext;
	/** Open Pi watches of connections, for this generation. */
	watches: ConnectionWatches;
	/**
	 * Calls that are using the harness and are not waiting on a run. A sleep
	 * drains them, so it never closes the harness under a call it admitted.
	 */
	calls: number;
	/** Called when a counted call ends. A drain sets it. */
	callEnded?: () => void;
}

export const PI_RUNTIME: unique symbol = Symbol.for("@rivet-dev/pi/runtime");

export function createPiRuntime(): PiRuntime {
	return { status: "open", watches: createConnectionWatches(), calls: 0 };
}

export function piRuntime(c: PiContext): PiRuntime {
	const runtime = (
		c.vars as Record<symbol, PiRuntime | undefined> | undefined
	)?.[PI_RUNTIME];
	if (!runtime) {
		throw new Error(
			"pi() runtime state is missing from actor vars; this actor was not created with pi()",
		);
	}
	return runtime;
}

/**
 * Opens the harness on wake without resuming interrupted work, so the app's
 * `onWake` runs first. The caller calls `harness.resume()` after it. The wake
 * context becomes the context of all background work.
 */
export async function openOnWake(
	c: PiContext,
	options: ResolvedPiOptions,
): Promise<Harness> {
	piRuntime(c).actor = c;
	return ensureHarness(c, options, { resume: false });
}

/** Returns the actor's Pi Durable harness, opening it from SQLite on first use. */
async function ensureHarness(
	c: PiContext,
	options: ResolvedPiOptions,
	open: { resume: boolean } = { resume: true },
): Promise<Harness> {
	const runtime = piRuntime(c);
	// Callers check the status first, so a closed generation never reopens Pi Durable.
	if (runtime.status !== "open") {
		throw new Error(
			`pi durable cannot open after it closed (${runtime.status})`,
		);
	}
	runtime.harness ??= openHarness(
		runtime.actor ?? c,
		runtime,
		options,
		open,
	).catch((error: unknown) => {
		runtime.harness = undefined;
		runtime.piError = toClientError(error);
		throw runtime.piError;
	});
	return (await runtime.harness).harness;
}

/**
 * Runs an action against the harness. A failed call that left Pi Durable
 * unusable reopens it before the error reaches the client, so the next call
 * works. Calls use `BACKGROUND_CONTEXT`, so a wait such as `prompt` lasts
 * until the run settles or the action times out, including while a stopping
 * actor drains the run. RivetKit's action signal also fires when the actor
 * starts to stop, so it cannot cancel a wait.
 */
export async function withHarness<T>(
	c: PiContext,
	options: ResolvedPiOptions,
	run: (harness: Harness, context: Context, waiting: Waiting) => Promise<T>,
	{ startsWork = false }: { startsWork?: boolean } = {},
): Promise<T> {
	const runtime = piRuntime(c);
	if (runtime.status !== "open") throw piClosed(runtime.status);
	const harness = await ensureHarness(c, options);
	const release = countCall(runtime);
	const unhold = startsWork ? await holdWake(runtime) : () => {};
	try {
		const context = withCallerSpan(c.actorId, BACKGROUND_CONTEXT);
		const result = await run(harness, context, (wait) => {
			unhold();
			release();
			return wait();
		});
		unhold();
		await settleWake(runtime);
		return result;
	} catch (error) {
		await recoverHarness(runtime.actor ?? c, runtime, options);
		throw toClientError(error);
	} finally {
		unhold();
		release();
	}
}

/**
 * Waits until the wake for the work a call started is written, so a crash
 * right after the reply still resumes that work.
 */
async function settleWake(runtime: PiRuntime): Promise<void> {
	const open = await runtime.harness?.catch(() => undefined);
	await open?.settleWake();
}

/**
 * Arms a recovery wake before a call that can start work, as Pi Durable's
 * host contract asks. RivetKit resolves `c.schedule.at` before the alarm
 * reaches the control plane, so a wake armed only after the call can be lost
 * with the process. Armed first, it has the call's whole duration to arrive.
 */
async function holdWake(runtime: PiRuntime): Promise<() => void> {
	const open = await runtime.harness?.catch(() => undefined);
	return open ? open.holdWake() : () => {};
}

/**
 * Runs a wait on a run, such as `submission.wait`, without holding a sleep.
 * While the run is busy, the run itself holds the sleep.
 */
export type Waiting = <W>(wait: () => Promise<W>) => Promise<W>;

/** Counts a call until the returned function runs. Calling it again does nothing. */
function countCall(runtime: PiRuntime): () => void {
	runtime.calls += 1;
	let counted = true;
	return () => {
		if (!counted) return;
		counted = false;
		runtime.calls -= 1;
		runtime.callEnded?.();
	};
}

/**
 * Runs one of the app's own actions or hooks with the harness on `c.pi`. A
 * failure that left Pi Durable unusable reopens it. The error reaches the
 * client as from a built-in action. Code that never reads `c.pi` runs even
 * when Pi Durable is closed or cannot open; reading `c.pi` throws the cause.
 * Shutdown hooks pass `opensHarness: false`, so they use a harness that is
 * already open and never open and resume one only to close it.
 */
export async function withPiAccess<T>(
	c: PiContext,
	options: ResolvedPiOptions,
	body: () => T | Promise<T>,
	{ opensHarness = true }: { opensHarness?: boolean } = {},
): Promise<T> {
	const runtime = piRuntime(c);
	exposePi(c);
	// Hooks such as onDisconnect still run after Pi Durable closed; only using c.pi fails.
	if (runtime.status !== "open" || (!opensHarness && !runtime.harness)) {
		return body();
	}
	try {
		await ensureHarness(c, options);
	} catch (error) {
		c.log.warn({
			msg: "pi durable could not open; reading c.pi throws this error",
			error,
		});
		return body();
	}
	const release = countCall(runtime);
	// The body may start work through `c.pi`, such as a signal.
	const unhold = await holdWake(runtime);
	try {
		const result = await body();
		unhold();
		await settleWake(runtime);
		return result;
	} catch (error) {
		await recoverHarness(runtime.actor ?? c, runtime, options);
		throw toClientError(error);
	} finally {
		unhold();
		release();
	}
}

function harnessNotOpen() {
	return new UserError(
		"Pi Durable is not open in this actor generation, so this hook cannot use c.pi.",
	);
}

/** What a call gets once Pi Durable is closed for this generation. */
function piClosed(status: Exclude<PiStatus, "open">) {
	return new UserError(
		status === "sleeping"
			? "Pi Durable is closed because the actor is going to sleep."
			: "Pi Durable is closed because the actor was destroyed.",
	);
}

async function openHarness(
	c: PiContext,
	runtime: PiRuntime,
	options: ResolvedPiOptions,
	open: { resume: boolean } = { resume: true },
): Promise<OpenHarness> {
	const storage = await SqliteStorage.open(
		actorSqlite(c.db, (body) =>
			// An older RivetKit has no such call, so it traces Pi's storage.
			c.run?.runOutsideWorkflowSpan
				? c.run.runOutsideWorkflowSpan(body)
				: body(),
		),
	);
	const now = options.now ?? Date.now;
	const { registry, settings } = options.onAnswer
		? // `c.pi` is set once the harness opens, before any answer.
			withAnswerHook(
				options,
				c as PiContext & PiAccess,
				options.onAnswer,
				(error) => {
					c.log.error({ msg: "pi onAnswer failed", error: String(error) });
					options.onReport?.({
						kind: "extension_error",
						extension: ANSWER_EXTENSION,
						error,
					});
				},
			)
		: options;
	const wake = wakeActor(c, now);
	const harness = await Harness.open(
		storage,
		{
			models: options.models ?? (await createModels(c, options)),
			registry,
			settings,
			env:
				options.env ??
				(options.sandbox
					? sandboxEnvBuilder(c, runtime, options.sandbox)
					: (target) =>
							databaseEnv(c.db, {
								id: `pi-files:${c.actorId}`,
								cwd: target.cwd,
							})),
			conversationCreated: startingAgent(options),
			now: options.now,
			onWake: wake.onWake,
			telemetry: createPiTelemetry(c.actorId),
			onReport: (report) => {
				// A failed storage call closes the Session. Background work reports it
				// here, with no action to catch it.
				if (report.kind === "storage_failed") {
					queueMicrotask(() => void recoverHarness(c, runtime, options));
				}
				options.onReport?.(report);
			},
		},
		// Pi derives the context of every task, tool, and hook from this one, so
		// the app's `tools` and `hooks` read the actor's context from it.
		withContextValue(PI_ACTOR_CONTEXT, c, BACKGROUND_CONTEXT),
	);
	runtime.pi = harness;
	runtime.piError = undefined;
	// Tools, hooks, and `onAnswer` get this context.
	exposePi(c);
	wake.attach(harness);
	reportBlockedTasks(c, await harness.inspect(BACKGROUND_CONTEXT));
	if (open.resume) harness.resume();
	await reattachWatches(c, runtime.watches, harness, documentsByKind(options));
	return {
		harness,
		onWakeChange: wake.subscribe,
		resumeDue: wake.resumeDue,
		settleWake: wake.settle,
		holdWake: wake.hold,
		stopWake: wake.stop,
	};
}

/** App documents by `kind`, for clients that name a document. */
export function documentsByKind(
	options: ResolvedPiOptions,
): ReadonlyMap<string, ConversationDocToken<any>> {
	return new Map(
		(options.documents ?? []).map((doc) => [doc.definition.kind, doc]),
	);
}

/** Pi Durable refuses every call once a commit failed after storage admitted it. */
function isUsable(harness: Harness): boolean {
	try {
		harness.subscribeClose(() => {})();
		return true;
	} catch {
		return false;
	}
}

/** Closes and reopens a harness that Pi Durable refuses to use. The reopened harness resumes from storage. */
async function recoverHarness(
	c: PiContext,
	runtime: PiRuntime,
	options: ResolvedPiOptions,
): Promise<void> {
	const current = runtime.harness;
	if (!current || runtime.status !== "open") return;
	let open: OpenHarness;
	try {
		open = await current;
	} catch {
		return;
	}
	if (
		runtime.harness !== current ||
		runtime.status !== "open" ||
		isUsable(open.harness)
	)
		return;

	c.log.warn({
		msg: "pi durable stopped after a failed commit, reopening it from storage",
	});
	const reopened = (async () => {
		await closeOpenHarness(open, runtime.watches);
		return openHarness(c, runtime, options);
	})().catch((error: unknown) => {
		if (runtime.harness === reopened) {
			runtime.harness = undefined;
			runtime.pi = undefined;
			runtime.piError = toClientError(error);
		}
		c.log.error({
			msg: "pi durable could not reopen after a failed commit",
			error,
		});
		throw toClientError(error);
	});
	runtime.harness = reopened;
	await reopened.catch(() => {});
}

async function closeOpenHarness(
	open: OpenHarness,
	watches: ConnectionWatches,
): Promise<void> {
	open.stopWake();
	await stopAllWatches(watches);
	await open.harness.close(BACKGROUND_CONTEXT);
}

async function createModels(
	c: PiContext,
	options: ResolvedPiOptions,
): Promise<Models> {
	const credentials = options.credentials
		? new SourceCredentialStore(options.credentials(c))
		: emptyCredentialStore;
	return createActorModelRuntime(
		{ providers: options.providers, apiKeys: options.apiKeys },
		credentials,
	);
}

/** Parses `provider/modelId`. */
export function parseModelRef(name: string): ModelRef {
	const slash = name.indexOf("/");
	if (slash <= 0 || slash === name.length - 1) {
		throw new Error(`pi() model must be provider/modelId, received ${name}`);
	}
	return { provider: name.slice(0, slash), modelId: name.slice(slash + 1) };
}

/**
 * `model`, `thinkingLevel`, `instructions`, `cwd`, and `maxTurns` start every
 * new conversation: root, created, and forked. A fork already has its parent's
 * agent, so it keeps each one its parent set. The app's own
 * `conversationCreated` runs after this.
 */
function startingAgent(
	options: ResolvedPiOptions,
): HarnessOptions["conversationCreated"] {
	const model =
		options.model === undefined ? undefined : parseModelRef(options.model);
	const { thinkingLevel, instructions, cwd, maxTurns } = options;
	const created = options.conversationCreated;
	if (
		[model, thinkingLevel, instructions, cwd, maxTurns].every(
			(value) => value === undefined,
		)
	) {
		return created;
	}
	return async (tx, conversation) => {
		const agent = await tx.doc(AgentDoc, conversation.id);
		await configure(tx, conversation.id, {
			model: agent.model === undefined ? model : undefined,
			thinkingLevel:
				agent.thinkingLevel === undefined ? thinkingLevel : undefined,
			instructions: agent.instructions === undefined ? instructions : undefined,
			cwd: agent.cwd === undefined ? cwd : undefined,
			maxTurns: agent.maxTurns === undefined ? maxTurns : undefined,
		});
		await created?.(tx, conversation);
	};
}

/**
 * Builds the sandbox env without connecting, so a model request or a custom
 * tool call never creates a sandbox. The sandbox connects on the first file
 * or shell operation. A provider that does not report its working directory
 * connects first, because the env needs that directory.
 */
function sandboxEnvBuilder(
	c: PiContext,
	runtime: PiRuntime,
	provider: SandboxProvider,
): NonNullable<HarnessOptions["env"]> {
	const connect = async () => {
		runtime.sandbox ??= connectSandbox(c, provider).catch((error: unknown) => {
			runtime.sandbox = undefined;
			throw error;
		});
		return (await runtime.sandbox).sandbox;
	};
	return async (target): Promise<ExecutionEnv> => {
		const root = provider.cwd ?? (await connect()).cwd;
		return sandboxEnv(connect, {
			id: `${provider.name}:${c.actorId}`,
			root,
			cwd: target.cwd,
		});
	};
}

function reportBlockedTasks(c: PiContext, inspection: HarnessInspection): void {
	for (const task of inspection.tasks) {
		if (task.state.kind !== "blocked") continue;
		c.log.warn({
			msg: "pi durable task is blocked and does not keep the actor awake; inspect it with harness.inspect",
			taskId: task.record.id,
			kind: task.record.kind,
			reason: task.state.reason,
			error: task.state.error,
		});
	}
}

/**
 * Keeps the actor awake while Pi Durable can run work, and keeps one `pi.wake`
 * scheduled, as Pi Durable's host contract asks (`HarnessOptions.onWake`). Pi
 * calls `onWake` after open and whenever `harness.wake()` changes: `active`
 * while some task can run now or is running, and `at`, the earliest sleep.
 *
 * The wake is at the earliest sleep, and while work is active no later than
 * `RECOVERY_WAKE_MS` ahead. Keep-awake only lasts while the process does, so
 * that recovery wake is what resumes work a crash cut off. While work runs,
 * the wake fires on the live actor and `resumeDue` arms the next one. A stop
 * keeps the wake, so a sleep that cut work off resumes it too.
 *
 * Pi runs a sleep only once its time has passed, and reports a wake only when
 * the value changes. So a wake that fires early, even by a millisecond,
 * re-reads the value and schedules again.
 *
 * A call that can start work holds the wake as if work were active, from
 * before it runs until it returns, so the recovery wake is already armed when
 * its work starts. An idle actor pays one arm and one clear per such call.
 */
function wakeActor(
	c: PiContext,
	now: () => number,
): {
	onWake: (wake: Wake) => void;
	attach: (harness: Harness) => void;
	subscribe: (listener: () => void) => () => void;
	resumeDue: () => void;
	settle: () => Promise<void>;
	hold: () => Promise<() => void>;
	stop: () => void;
} {
	const listeners = new Set<() => void>();
	let harness: Harness | undefined;
	let latest: Wake = { active: false };
	let release: (() => void) | undefined;
	/** The one `pi.wake` this generation keeps. `id` resolves once it is written, or to `undefined` if it failed. */
	let armed: { at: number; id: Promise<string | undefined> } | undefined;
	/** When a schedule write last failed. Until `RECOVERY_WAKE_MS` later, a timer stands in for the wake. */
	let failedAt: number | undefined;
	let timer: { at: number; handle: ReturnType<typeof setTimeout> } | undefined;
	let stopped = false;
	/** Calls between `hold` and its release. */
	let holds = 0;

	const stayAwake = () => {
		if (release) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		release = resolve;
		void c.keepAwake(promise);
	};
	const letGo = () => {
		release?.();
		release = undefined;
	};
	const clearTimer = () => {
		if (timer) clearTimeout(timer.handle);
		timer = undefined;
	};
	const armTimer = (at: number) => {
		if (timer?.at === at) return;
		clearTimer();
		// setTimeout fires at once past 2^31 - 1 ms, so a far sleep re-arms from here.
		const delay = Math.min(Math.max(0, at - now()), 2 ** 31 - 1);
		timer = { at, handle: setTimeout(resumeDue, delay) };
	};
	/** Replaces the kept wake. The new one is written before the old one is cancelled, so work never goes without one. */
	const rearm = (at: number | undefined) => {
		const previous = armed?.id;
		const next =
			at === undefined
				? undefined
				: c.schedule.at(at, WAKE_ACTION).then(
						(id) => {
							failedAt = undefined;
							return id;
						},
						(error: unknown) => {
							c.log.warn({
								msg: "pi durable could not schedule its wake, so the actor stays awake and a timer resumes its work",
								error,
							});
							failedAt = Date.now();
							if (armed?.id === next) armed = undefined;
							apply();
							return undefined;
						},
					);
		armed = next && at !== undefined ? { at, id: next } : undefined;
		void (async () => {
			await next;
			const old = await previous;
			if (old !== undefined) await c.schedule.cancel(old).catch(() => false);
		})();
	};
	const apply = () => {
		if (stopped) return;
		const { active, at } = latest;
		const busy = active || holds > 0;
		const heartbeat = busy ? Date.now() + RECOVERY_WAKE_MS : undefined;
		const target =
			heartbeat === undefined || at === undefined
				? (heartbeat ?? at)
				: Math.min(heartbeat, at);
		if (active) stayAwake();
		if (target === undefined) {
			clearTimer();
			if (armed) rearm(undefined);
			return letGo();
		}
		if (failedAt !== undefined && Date.now() - failedAt < RECOVERY_WAKE_MS) {
			stayAwake();
			if (at !== undefined) armTimer(at);
			return;
		}
		clearTimer();
		// While work runs, an earlier wake still ahead is enough: it fires, and `resumeDue` arms the next one.
		const kept = busy
			? armed && armed.at <= target && armed.at > Date.now()
			: armed?.at === target;
		if (!kept) rearm(target);
		if (busy) return;
		// The actor may sleep only once its wake is written.
		stayAwake();
		const written = armed;
		void written?.id.then((id) => {
			if (id !== undefined && armed === written && !latest.active && !stopped)
				letGo();
		});
	};
	const resumeDue = () => {
		if (stopped || !harness) return;
		clearTimer();
		// RivetKit removes a wake before it runs it, so one that came due is gone.
		if (armed && armed.at <= Date.now()) armed = undefined;
		harness.resume();
		latest = harness.wake();
		apply();
	};
	const stop = () => {
		stopped = true;
		clearTimer();
		// The wake stays, so work a stop cut off resumes.
		letGo();
	};
	// Keep-awake only blocks idle sleep. Once shutdown starts it would only delay it.
	// A reopen during a drain gets a signal that is already aborted.
	if (c.abortSignal.aborted) stop();
	else c.abortSignal.addEventListener("abort", stop, { once: true });
	return {
		onWake: (wake) => {
			latest = wake;
			apply();
			for (const listener of listeners) listener();
		},
		attach: (opened) => {
			harness = opened;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		resumeDue,
		settle: async () => {
			// Pi reports a change in a microtask after its commit, so read the value now.
			if (stopped || !harness || !isUsable(harness)) return;
			latest = harness.wake();
			apply();
			await armed?.id;
		},
		hold: async () => {
			if (stopped || !harness) return () => {};
			holds += 1;
			apply();
			await armed?.id;
			let held = true;
			return () => {
				if (!held) return;
				held = false;
				holds -= 1;
			};
		},
		stop: () => {
			c.abortSignal.removeEventListener("abort", stop);
			stop();
			// Closing with nothing left to wake for, such as after a drain, needs no wake.
			// A failed harness refuses `wake()`; its wake stays, and the reopen arms a new one.
			if (!harness || !isUsable(harness)) return;
			const { active, at } = harness.wake();
			if (!active && at === undefined && armed) rearm(undefined);
		},
	};
}

/**
 * Waits until no run is active and no admitted call is using the harness, or
 * until `drainUntil` passes. Idle sleep has no live work, so it waits only for
 * a call that arrived as the sleep started. The deadline ends before
 * RivetKit's, so closing still fits in the grace period. Pi's records are
 * already stored, and the next wake resumes the work.
 */
async function drain(
	c: PiContext,
	runtime: PiRuntime,
	open: OpenHarness,
	drainUntil: number,
): Promise<void> {
	let changed = () => {};
	let timedOut = false;
	const commits = open.harness.observeCommits({
		advance: () => changed(),
		end: () => {},
	});
	// Pi can settle its wake value after the last commit, so its change counts too.
	const unsubscribeWake = open.onWakeChange(() => changed());
	runtime.callEnded = () => changed();
	const timer = setTimeout(
		() => {
			timedOut = true;
			changed();
		},
		Math.max(0, drainUntil - Date.now()),
	);
	try {
		while (!timedOut) {
			// Armed before the check, so a commit during the check is not missed.
			const next = new Promise<void>((resolve) => {
				changed = resolve;
			});
			if (runtime.calls === 0 && !open.harness.wake().active) return;
			await next;
		}
		c.log.warn({
			msg: "pi durable run still active at the end of the grace period; it resumes on wake",
		});
	} finally {
		clearTimeout(timer);
		commits.detach();
		unsubscribeWake();
		runtime.callEnded = undefined;
	}
}

/**
 * Closes Pi Durable for this actor generation. On sleep it drains first. On
 * destroy it stops running work at once. Records of interrupted work stay
 * running, and the next open resumes them. Then suspends the sandbox on
 * sleep, or destroys it on destroy.
 */
export async function closeHarness(
	c: PiContext,
	options: ResolvedPiOptions,
	stop: PiStop,
): Promise<void> {
	const runtime = piRuntime(c);
	const errors: unknown[] = [];
	let open: OpenHarness | undefined;
	try {
		open = await runtime.harness;
	} catch {}
	// Destroy has no next generation to resume in, so it stops running work at once.
	if (open && stop.reason === "sleep") {
		await drain(c, runtime, open, stop.drainUntil).catch((error: unknown) =>
			errors.push(error),
		);
	}
	runtime.status = stop.reason === "sleep" ? "sleeping" : "destroyed";
	runtime.harness = undefined;
	runtime.pi = undefined;
	if (open) {
		await closeOpenHarness(open, runtime.watches).catch((error: unknown) =>
			errors.push(error),
		);
	}

	const provider = options.sandbox;
	if (provider) {
		await closeSandbox(c, provider, runtime.sandbox, stop).catch(
			(error: unknown) => errors.push(error),
		);
	}

	if (errors.length === 1) throw errors[0];
	if (errors.length > 1)
		throw new AggregateError(errors, "pi durable shutdown failed");
}

/** Resumes Pi's due sleeps when the scheduled `pi.wake` fires. Call it once the harness is open. */
export async function resumeDueSleeps(c: PiContext): Promise<void> {
	(await piRuntime(c).harness)?.resumeDue();
}

/** What a shutdown hook gets from `c.pi` once the actor has started to stop. */
export function piStopping() {
	return new UserError("Pi Durable is closed because the actor is stopping.");
}

/**
 * Gives `c` a `pi` that reads this generation's open harness, so every hook,
 * tool, and action sees the same one, also after a reopen. It never opens Pi
 * Durable. Reading it throws why there is none: `unavailable`, a closed
 * generation, or the error that kept Pi Durable from opening.
 */
export function exposePi(c: PiContext, unavailable?: unknown): void {
	const runtime = (
		c.vars as Record<symbol, PiRuntime | undefined> | undefined
	)?.[PI_RUNTIME];
	Object.defineProperty(c, "pi", {
		get: () => {
			if (unavailable !== undefined) throw unavailable;
			if (runtime && runtime.status !== "open") throw piClosed(runtime.status);
			if (runtime?.pi) return runtime.pi;
			throw runtime?.piError ?? harnessNotOpen();
		},
		configurable: true,
	});
}

/**
 * Connects to the actor's sandbox, creating one when none is stored or the
 * provider reports the stored one no longer exists. A new sandbox id is saved
 * as soon as `create` returns, so a failure later in the start reuses it. Any
 * other connect failure is thrown, so a temporary outage never replaces a
 * sandbox.
 */
export async function connectSandbox(
	c: PiContext,
	provider: SandboxProvider,
): Promise<ConnectedSandbox> {
	const existing = await loadPiSandbox(c.db);
	if (existing && existing.provider !== provider.name) {
		throw new Error(
			`pi sandbox was created by provider ${existing.provider}, but the actor now uses ${provider.name}`,
		);
	}
	if (existing) {
		const sandbox = await provider.connect(c, existing.id);
		if (sandbox) return { provider, id: existing.id, sandbox };
		c.log.warn({
			msg: "pi sandbox no longer exists, creating a new one; files from the previous sandbox are lost",
			provider: provider.name,
			sandboxId: existing.id,
		});
	}
	const id = await provider.create(c);
	await savePiSandbox(c.db, { provider: provider.name, id });
	const sandbox = await provider.connect(c, id);
	if (!sandbox) {
		throw new Error(
			`pi sandbox ${provider.name}/${id} was not found right after it was created`,
		);
	}
	return { provider, id, sandbox };
}

/**
 * Suspends the sandbox this generation connected when the actor sleeps. On
 * destroy it destroys the actor's sandbox, also one stored by an earlier
 * generation that this one never connected.
 */
export async function closeSandbox(
	c: PiContext,
	provider: SandboxProvider,
	connection: Promise<ConnectedSandbox> | undefined,
	stop: PiStop,
): Promise<void> {
	const connected = await connection?.catch(() => undefined);
	if (stop.reason === "sleep") {
		if (connected && provider.suspend) await provider.suspend(c, connected.id);
		return;
	}
	if (!provider.destroy) return;
	const stored = connected ? undefined : await loadPiSandbox(c.db);
	const id =
		connected?.id ??
		(stored?.provider === provider.name ? stored.id : undefined);
	if (id !== undefined) await provider.destroy(c, id);
}
