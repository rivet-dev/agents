import type { Context, JsonValue } from "@earendil-works/chord";
import {
	BACKGROUND_CONTEXT,
	withAbortSignal,
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
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { SandboxProvider } from "@rivet-dev/sandbox-adapter";
import { UserError } from "rivetkit";
import { SourceCredentialStore } from "../credentials.js";
import {
	createActorModelRuntime,
	emptyCredentialStore,
	type PiModelOptions,
} from "../models.js";
import {
	type ConnectedSandbox,
	connectSandbox,
	type PiContext,
	piSandboxStore,
} from "../runtime.js";
import { loadPiSandbox } from "../storage.js";
import { actorSqlite } from "./actor-sqlite.js";
import { sandboxEnv } from "./env.js";
import { toClientError } from "./errors.js";
import {
	type ConnectionWatches,
	createConnectionWatches,
	reattachWatches,
	stopAllWatches,
} from "./watches.js";

/**
 * Options accepted by `piDurable()` on top of ordinary actor config. The Pi
 * Durable options keep the names and types of `HarnessOptions`.
 */
export interface PiDurableOptions extends PiModelOptions {
	/** Pi Durable's extension registry: tools, hooks, sections, tasks, and documents. */
	registry: HarnessOptions["registry"];
	/** pi-ai model access. Without it, the actor builds it from `model`, `providers`, `apiKeys`, and `credentials`. */
	models?: Models;
	settings?: HarnessSettings;
	/** Builds a conversation's environment. Without it, the actor builds one from `sandbox`. */
	env?: HarnessOptions["env"];
	conversationCreated?: HarnessOptions["conversationCreated"];
	now?: HarnessOptions["now"];
	onReport?: HarnessOptions["onReport"];
	/** The starting thinking level of every new conversation. */
	thinkingLevel?: ModelThinkingLevel;
	/** Runs the tools of Pi's `CodingTools` extension in a sandbox. Used only when `env` is omitted. */
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
export const WAKE_ACTION = "pi.wake";

interface OpenHarness {
	harness: Harness;
	stopBusyWatch: () => void;
	watches: ConnectionWatches;
	isBusy: () => Promise<boolean>;
}

/** Per-actor-generation state, stored on `c.vars` under `PI_DURABLE_RUNTIME`. */
export interface PiDurableRuntime {
	/** The open harness, or the open in progress. */
	harness?: Promise<OpenHarness>;
	sandbox?: Promise<ConnectedSandbox>;
	/** Set when the actor starts to sleep or is destroyed. */
	closing: boolean;
	/**
	 * The `onWake` context. Background work (keep-awake, scheduled wakes, the
	 * sandbox, reopening) uses it, because an action's context is cancelled
	 * with the action.
	 */
	actor?: PiContext;
	/** Open Pi watches of connections, for this generation. */
	watches: ConnectionWatches;
}

export const PI_DURABLE_RUNTIME: unique symbol = Symbol.for(
	"@rivet-dev/pi/durable/runtime",
);

export function createPiDurableRuntime(): PiDurableRuntime {
	return { closing: false, watches: createConnectionWatches() };
}

export function piDurableRuntime(c: PiContext): PiDurableRuntime {
	const runtime = (
		c.vars as Record<symbol, PiDurableRuntime | undefined> | undefined
	)?.[PI_DURABLE_RUNTIME];
	if (!runtime) {
		throw new Error(
			"piDurable() runtime state is missing from actor vars; this actor was not created with piDurable()",
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
	options: PiDurableOptions,
): Promise<Harness> {
	piDurableRuntime(c).actor = c;
	return ensureHarness(c, options, { resume: false });
}

/** Returns the actor's Pi Durable harness, opening it from SQLite on first use. */
export async function ensureHarness(
	c: PiContext,
	options: PiDurableOptions,
	open: { resume: boolean } = { resume: true },
): Promise<Harness> {
	const runtime = piDurableRuntime(c);
	if (runtime.closing) {
		throw new UserError("Pi Durable is closed because the actor is stopping.");
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
 * works.
 */
export async function withHarness<T>(
	c: PiContext,
	options: PiDurableOptions,
	run: (harness: Harness, context: Context) => Promise<T>,
): Promise<T> {
	const harness = await ensureHarness(c, options);
	try {
		return await run(harness, actionContext(c));
	} catch (error) {
		const runtime = piDurableRuntime(c);
		await recoverHarness(runtime.actor ?? c, runtime, options);
		throw toClientError(error);
	}
}

/**
 * Runs one of the app's own actions or hooks with the harness on `c.pi`. A
 * failure that left Pi Durable unusable reopens it. The error reaches the
 * client as from a built-in action.
 */
export async function withPiAccess<T>(
	c: PiContext,
	options: PiDurableOptions,
	body: () => T | Promise<T>,
): Promise<T> {
	const harness = await ensureHarness(c, options);
	Object.defineProperty(c, "pi", { value: harness, configurable: true });
	try {
		return await body();
	} catch (error) {
		const runtime = piDurableRuntime(c);
		await recoverHarness(runtime.actor ?? c, runtime, options);
		throw toClientError(error);
	}
}

/** A cancelled action stops waiting. It never cancels durable work, as Pi Durable's own rule says. */
function actionContext(c: PiContext): Context {
	return withAbortSignal(c.abortSignal, BACKGROUND_CONTEXT);
}

async function openHarness(
	c: PiContext,
	runtime: PiDurableRuntime,
	options: PiDurableOptions,
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
					: undefined),
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
	return { harness, stopBusyWatch, watches: runtime.watches, isBusy };
}

/** App documents by `kind`, for clients that name a document. */
export function documentsByKind(
	options: PiDurableOptions,
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
	runtime: PiDurableRuntime,
	options: PiDurableOptions,
): Promise<void> {
	const current = runtime.harness;
	if (!current || runtime.closing) return;
	let open: OpenHarness;
	try {
		open = await current;
	} catch {
		return;
	}
	if (runtime.harness !== current || runtime.closing || isUsable(open.harness))
		return;

	c.log.warn({
		msg: "pi durable stopped after a failed commit, reopening it from storage",
	});
	const reopened = (async () => {
		await closeOpenHarness(open);
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

async function closeOpenHarness(open: OpenHarness): Promise<void> {
	open.stopBusyWatch();
	await stopAllWatches(open.watches);
	await open.harness.close(BACKGROUND_CONTEXT);
}

async function createModels(
	c: PiContext,
	options: PiDurableOptions,
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
		throw new Error(
			`piDurable() model must be provider/modelId, received ${name}`,
		);
	}
	return { provider: name.slice(0, slash), modelId: name.slice(slash + 1) };
}

/**
 * `model` and `thinkingLevel` start every new conversation: root, created, and
 * forked. A fork already has its parent's agent, so it keeps it. The app's own
 * `conversationCreated` runs after this.
 */
function startingAgent(
	options: PiDurableOptions,
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

/** Connects the sandbox on the first tool call that needs it. */
function sandboxEnvBuilder(
	c: PiContext,
	runtime: PiDurableRuntime,
	provider: SandboxProvider,
): NonNullable<HarnessOptions["env"]> {
	return async (target): Promise<ExecutionEnv> => {
		runtime.sandbox ??= connectSandbox(c, provider, piSandboxStore).catch(
			(error: unknown) => {
				runtime.sandbox = undefined;
				throw error;
			},
		);
		const connected = await runtime.sandbox;
		return sandboxEnv(
			`${provider.name}:${connected.id}`,
			connected.sandbox,
			target.cwd,
		);
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
 * Waits until no run is active, or until `drainUntil` passes. Idle sleep
 * never has live work, so this only waits on a forced stop, such as a deploy.
 * The deadline ends before RivetKit's, so closing still fits in the grace
 * period. Pi's records are already stored, and the next wake resumes the work.
 */
async function drain(
	c: PiContext,
	open: OpenHarness,
	drainUntil: number,
): Promise<void> {
	let changed = () => {};
	let timedOut = false;
	const unsubscribe = open.harness.subscribeCommits(() => changed());
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
			if (!(await open.isBusy())) return;
			await next;
		}
		c.log.warn({
			msg: "pi durable run still active at the end of the grace period; it resumes on wake",
		});
	} finally {
		clearTimeout(timer);
		unsubscribe();
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
	options: PiDurableOptions,
	stop: { reason: "sleep"; drainUntil: number } | { reason: "destroy" },
): Promise<void> {
	const runtime = piDurableRuntime(c);
	const errors: unknown[] = [];
	let open: OpenHarness | undefined;
	try {
		open = await runtime.harness;
	} catch {}
	// Destroy has no next generation to resume in, so it stops running work at once.
	if (open && stop.reason === "sleep") {
		await drain(c, open, stop.drainUntil).catch((error: unknown) =>
			errors.push(error),
		);
	}
	runtime.closing = true;
	runtime.harness = undefined;
	if (open) {
		await closeOpenHarness(open).catch((error: unknown) => errors.push(error));
	}

	const provider = options.sandbox;
	if (provider) {
		try {
			const connected = await runtime.sandbox?.catch(() => undefined);
			if (stop.reason === "sleep") {
				if (connected && provider.suspend)
					await provider.suspend(c, connected.id);
			} else if (provider.destroy) {
				const stored = connected ? undefined : await loadPiSandbox(c.db);
				const id =
					connected?.id ??
					(stored?.provider === provider.name ? stored.id : undefined);
				if (id !== undefined) await provider.destroy(c, id);
			}
		} catch (error) {
			errors.push(error);
		}
	}

	if (errors.length === 1) throw errors[0];
	if (errors.length > 1)
		throw new AggregateError(errors, "pi durable shutdown failed");
}
