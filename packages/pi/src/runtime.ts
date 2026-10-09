import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { Sandbox, SandboxProvider } from "@rivet-dev/sandbox-adapter";
import { sandboxEnv } from "@rivet-dev/sandbox-adapter/pi";
import { type ActorContext, UserError } from "rivetkit";
import type { DatabaseProvider, RawAccess } from "rivetkit/db";
import { actorSqlite } from "./actor-sqlite.js";
import { SourceCredentialStore } from "./credentials.js";
import { databaseEnv } from "./database-env.js";
import { toClientError } from "./errors.js";
import {
	createActorModelRuntime,
	emptyCredentialStore,
	type PiModelOptions,
} from "./models.js";
import { loadPiSandbox, savePiSandbox } from "./storage.js";
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
	/** Pi Durable's extension registry: tools, hooks, sections, tasks, and documents. */
	registry: HarnessOptions["registry"];
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
	/**
	 * Runs the tools of Pi's `CodingTools` extension in a sandbox. Used only
	 * when `env` is omitted. Without a sandbox, files live in the actor's
	 * database and there is no shell.
	 */
	sandbox?: SandboxProvider;
	/** App documents that clients may read by `kind` with `harness.snapshot`. */
	documents?: readonly ConversationDocToken<any>[];
}

/**
 * One minute, as in Cloudflare's Pi harness. A retry or poll wait longer than
 * this lets the actor sleep, and a scheduled wake reopens Pi Durable at the
 * deadline.
 */
const LONG_WAIT_MS = 60_000;

/** The internal action a scheduled wake calls. */
const WAKE_ACTION = "pi.wake";

interface OpenHarness {
	harness: Harness;
	stopBusyWatch: () => void;
	isBusy: () => Promise<boolean>;
}

/** Per-actor-generation state, stored on `c.vars` under `PI_RUNTIME`. */
export interface PiRuntime {
	/** The open harness, or the open in progress. */
	harness?: Promise<OpenHarness>;
	sandbox?: Promise<ConnectedSandbox>;
	/** Pi Durable is open until the actor starts to sleep or is destroyed. */
	status: PiStatus;
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
	options: PiOptions,
): Promise<Harness> {
	piRuntime(c).actor = c;
	return ensureHarness(c, options, { resume: false });
}

/** Returns the actor's Pi Durable harness, opening it from SQLite on first use. */
async function ensureHarness(
	c: PiContext,
	options: PiOptions,
	open: { resume: boolean } = { resume: true },
): Promise<Harness> {
	const runtime = piRuntime(c);
	// Callers check the status first, so a closed generation never reopens Pi Durable.
	if (runtime.status !== "open") {
		throw new Error(`pi durable cannot open after it closed (${runtime.status})`);
	}
	runtime.harness ??= openHarness(
		runtime.actor ?? c,
		runtime,
		options,
		open,
	).catch((error: unknown) => {
		runtime.harness = undefined;
		throw toClientError(error);
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
	options: PiOptions,
	run: (harness: Harness, context: Context, waiting: Waiting) => Promise<T>,
): Promise<T> {
	const runtime = piRuntime(c);
	if (runtime.status !== "open") throw piClosed(runtime.status);
	const harness = await ensureHarness(c, options);
	const release = countCall(runtime);
	try {
		return await run(harness, BACKGROUND_CONTEXT, (wait) => {
			release();
			return wait();
		});
	} catch (error) {
		await recoverHarness(runtime.actor ?? c, runtime, options);
		throw toClientError(error);
	} finally {
		release();
	}
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
	options: PiOptions,
	body: () => T | Promise<T>,
	{ opensHarness = true }: { opensHarness?: boolean } = {},
): Promise<T> {
	const runtime = piRuntime(c);
	// Hooks such as onDisconnect still run after Pi Durable closed; only using c.pi fails.
	if (runtime.status !== "open") {
		return withUnavailablePi(c, piClosed(runtime.status), body);
	}
	if (!opensHarness && !runtime.harness) {
		return withUnavailablePi(c, harnessNotOpen(), body);
	}
	let harness: Harness;
	try {
		harness = await ensureHarness(c, options);
	} catch (error) {
		c.log.warn({
			msg: "pi durable could not open; reading c.pi throws this error",
			error,
		});
		return withUnavailablePi(c, error, body);
	}
	Object.defineProperty(c, "pi", { value: harness, configurable: true });
	const release = countCall(runtime);
	try {
		return await body();
	} catch (error) {
		await recoverHarness(runtime.actor ?? c, runtime, options);
		throw toClientError(error);
	} finally {
		release();
	}
}

function harnessNotOpen() {
	return new UserError(
		"Pi Durable is not open in this actor generation, so this shutdown hook cannot use c.pi.",
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
	options: PiOptions,
	open: { resume: boolean } = { resume: true },
): Promise<OpenHarness> {
	const storage = await SqliteStorage.open(actorSqlite(c.db));
	const now = options.now ?? Date.now;
	const harness = await Harness.open(
		storage,
		{
			models: options.models ?? (await createModels(c, options)),
			registry: options.registry,
			settings: options.settings,
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
			onReport: (error) => {
				// A commit that failed after storage admitted it leaves Pi Durable
				// unusable. Background work reports it here, with no action to catch it.
				queueMicrotask(() => void recoverHarness(c, runtime, options));
				options.onReport?.(error);
			},
		},
		BACKGROUND_CONTEXT,
	);
	reportBlockedTasks(c, await harness.inspect(BACKGROUND_CONTEXT));
	if (open.resume) harness.resume();
	const isBusy = async () =>
		busyState(await harness.inspect(BACKGROUND_CONTEXT), now(), LONG_WAIT_MS)
			.kind === "busy";
	const stopBusyWatch = watchBusy(c, harness, now, LONG_WAIT_MS);
	await reattachWatches(c, runtime.watches, harness, documentsByKind(options));
	return { harness, stopBusyWatch, isBusy };
}

/** App documents by `kind`, for clients that name a document. */
export function documentsByKind(
	options: PiOptions,
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
	options: PiOptions,
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
		if (runtime.harness === reopened) runtime.harness = undefined;
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
	open.stopBusyWatch();
	await stopAllWatches(watches);
	await open.harness.close(BACKGROUND_CONTEXT);
}

async function createModels(c: PiContext, options: PiOptions): Promise<Models> {
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
 * `model` and `thinkingLevel` start every new conversation: root, created, and
 * forked. A fork already has its parent's agent, so it keeps it. The app's own
 * `conversationCreated` runs after this.
 */
function startingAgent(
	options: PiOptions,
): HarnessOptions["conversationCreated"] {
	const model =
		options.model === undefined ? undefined : parseModelRef(options.model);
	const thinkingLevel = options.thinkingLevel;
	const created = options.conversationCreated;
	if (model === undefined && thinkingLevel === undefined) return created;
	return async (tx, conversation) => {
		const agent = await tx.doc(AgentDoc, conversation.id);
		await configure(tx, conversation.id, {
			model: agent.model === undefined ? model : undefined,
			thinkingLevel:
				agent.thinkingLevel === undefined ? thinkingLevel : undefined,
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

type BusyState =
	| { kind: "busy" }
	| { kind: "idle" }
	/** Every live task waits for a deadline further away than the long wait threshold. */
	| { kind: "waiting"; until: number };

/**
 * Whether live work should keep the actor awake. Tasks that run or are ready
 * to run do. A task in a retry or poll wait longer than `longWaitMs` does not;
 * the actor sleeps and a scheduled wake reopens it at the deadline. Waiting
 * and completing tasks depend on other tasks, which decide. Blocked tasks
 * never run, so they never keep the actor awake.
 */
function busyState(
	inspection: HarnessInspection,
	now: number,
	longWaitMs: number,
): BusyState {
	let until: number | undefined;
	for (const task of inspection.tasks) {
		switch (task.state.kind) {
			case "running":
			case "ready": {
				const deadline = waitDeadline(task.record.state.checkpoint);
				if (deadline === undefined || deadline - now <= longWaitMs)
					return { kind: "busy" };
				until = Math.min(until ?? deadline, deadline);
				break;
			}
			case "waiting":
			case "completing":
			case "blocked":
				break;
		}
	}
	return until === undefined ? { kind: "idle" } : { kind: "waiting", until };
}

/** The deadline of a task checkpoint in Pi's retry or poll phase. */
function waitDeadline(checkpoint: JsonValue | undefined): number | undefined {
	if (
		typeof checkpoint !== "object" ||
		checkpoint === null ||
		Array.isArray(checkpoint)
	)
		return undefined;
	if (checkpoint.phase === "retry" && typeof checkpoint.until === "number")
		return checkpoint.until;
	if (checkpoint.phase === "poll" && typeof checkpoint.pollAt === "number")
		return checkpoint.pollAt;
	return undefined;
}

/**
 * Keeps the actor awake while Pi Durable has live work, rechecking after
 * every commit. Returns a function that stops watching.
 */
function watchBusy(
	c: PiContext,
	harness: Harness,
	now: () => number,
	longWaitMs: number,
): () => void {
	let release: (() => void) | undefined;
	let scheduledWakeAt: number | undefined;
	let checking = false;
	let dirty = false;
	let stopped = false;

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
	const check = async () => {
		if (checking) {
			dirty = true;
			return;
		}
		checking = true;
		try {
			do {
				dirty = false;
				const busy = busyState(
					await harness.inspect(BACKGROUND_CONTEXT),
					now(),
					longWaitMs,
				);
				if (stopped) return;
				if (busy.kind === "waiting" && busy.until !== scheduledWakeAt) {
					// The actor may sleep through a long wait only once its wake is written.
					stayAwake();
					try {
						await c.schedule.at(busy.until, WAKE_ACTION);
						scheduledWakeAt = busy.until;
					} catch (error) {
						// Pi's own timer then ends the wait, and its commit checks again.
						c.log.warn({
							msg: "pi durable could not schedule its wake, so the actor stays awake through the wait",
							error,
						});
					}
					if (stopped) return;
				}
				const canSleep =
					busy.kind === "idle" ||
					(busy.kind === "waiting" && busy.until === scheduledWakeAt);
				if (canSleep) letGo();
				else stayAwake();
			} while (dirty && !stopped);
		} catch (error) {
			if (!stopped) c.log.warn({ msg: "pi durable busy check failed", error });
		} finally {
			checking = false;
		}
	};

	// Commit listeners must not call Pi Durable, so the check runs after the listener returns.
	const unsubscribe = harness.subscribeCommits(() =>
		queueMicrotask(() => void check()),
	);
	const stop = () => {
		stopped = true;
		unsubscribe();
		letGo();
	};
	// Keep-awake only blocks idle sleep. Once shutdown starts it would only delay it.
	c.abortSignal.addEventListener("abort", stop, { once: true });
	void check();
	return () => {
		c.abortSignal.removeEventListener("abort", stop);
		stop();
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
	const unsubscribe = open.harness.subscribeCommits(() => changed());
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
			if (runtime.calls === 0 && !(await open.isBusy())) return;
			await next;
		}
		c.log.warn({
			msg: "pi durable run still active at the end of the grace period; it resumes on wake",
		});
	} finally {
		clearTimeout(timer);
		unsubscribe();
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
	options: PiOptions,
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

/** Runs `body` with a `c.pi` that throws `error` when read. */
export function withUnavailablePi<T>(
	c: PiContext,
	error: unknown,
	body: () => T | Promise<T>,
): T | Promise<T> {
	Object.defineProperty(c, "pi", {
		get: () => {
			throw error;
		},
		configurable: true,
	});
	return body();
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
