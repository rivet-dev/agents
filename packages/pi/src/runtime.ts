import { isAbsolute } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	type BashOperations,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Sandbox, SandboxProvider } from "@rivet-dev/sandbox-adapter";
import { type ActorContext, UserError } from "rivetkit";
import type { DatabaseProvider, RawAccess } from "rivetkit/db";
import { SourceCredentialStore } from "./credentials.js";
import {
	createActorModelRuntime,
	emptyCredentialStore,
	openingModel,
	type PiModelOptions,
} from "./models.js";
import { createSandboxBashOperations, createSandboxTools } from "./sandbox.js";
import {
	appendPiEntry,
	createPiSession,
	loadPiInterruptedRun,
	loadPiSandbox,
	loadPiSession,
	migratePiSession,
	type PiQueue,
	type PiSettings,
	savePiIdle,
	savePiRunning,
	savePiSandbox,
	savePiSettings,
	toFileEntries,
} from "./storage.js";

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

/** How an actor generation stops. A sleep drains until `drainUntil`; a destroy stops at once. */
export type PiStop =
	| { reason: "sleep"; drainUntil: number }
	| { reason: "destroy" };

/** Pi options accepted by `pi()` on top of ordinary actor config. */
export interface PiSessionOptions
	extends Omit<
			CreateAgentSessionOptions,
			| "sessionManager"
			| "settingsManager"
			| "modelRuntime"
			| "model"
			| "scopedModels"
		>,
		PiModelOptions {
	/** Initial Pi settings for a brand-new session. Later changes persist per actor. */
	settings?: Partial<PiSettings>;
	/**
	 * Runs Pi's built-in file and shell tools in a sandbox. Without one, Pi has
	 * no file or shell tools and only the `customTools` passed in.
	 */
	sandbox?: SandboxProvider;
}

/** One open Pi session for a live actor generation. */
export interface PiSession {
	session: AgentSession;
	settingsManager: SettingsManager;
	cwd: string;
	sandbox: LazySandbox | undefined;
	/** Command execution for `executeBash`. Undefined when there is no sandbox. */
	bashOperations: BashOperations | undefined;
	/** JSON of the settings last written to SQLite, to skip no-op writes. */
	persistedSettings: string;
	/** Entries (header excluded) already written to SQLite, in Pi's append order. */
	persistedEntryCount: number;
	/** The application's credentials, when `pi({ credentials })` is set. */
	credentials: SourceCredentialStore | undefined;
}

/** The sandbox a session's tools run in for this actor generation. */
export interface ConnectedSandbox {
	provider: SandboxProvider;
	id: string;
	sandbox: Sandbox;
}

/**
 * The actor's sandbox, connected on first use in this generation. Opening a
 * session never needs it, so actions that touch no files cost no connect.
 */
interface LazySandbox {
	connect(): Promise<ConnectedSandbox>;
	/** The connection of this generation, if one was made. */
	current: Promise<ConnectedSandbox> | undefined;
}

function lazySandbox(c: PiContext, provider: SandboxProvider): LazySandbox {
	const lazy: LazySandbox = {
		current: undefined,
		connect: () =>
			(lazy.current ??= connectSandbox(c, provider).catch((error: unknown) => {
				lazy.current = undefined;
				throw error;
			})),
	};
	return lazy;
}

/** Per-actor-generation runtime state, stored on `c.vars` under `PI_RUNTIME`. */
export interface PiRuntime {
	ready?: Promise<PiSession>;
	/** Serializes SQLite entry writes so entries keep their append order. Never rejects. */
	writes: Promise<void>;
	/** Set once the session closes for sleep or destroy. It never reopens in this generation. */
	closing: boolean;
}

export const PI_RUNTIME: unique symbol = Symbol.for("@rivet-dev/pi/runtime");

export function createPiRuntime(): PiRuntime {
	return { writes: Promise.resolve(), closing: false };
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

/** Returns the actor's Pi session, opening it from SQLite on first use. */
export function ensurePiSession(
	c: PiContext,
	options: PiSessionOptions,
): Promise<PiSession> {
	const runtime = piRuntime(c);
	if (runtime.closing) {
		return Promise.reject(sessionClosed());
	}
	if (!runtime.ready) {
		runtime.ready = openPiSession(c, runtime, options).catch((error) => {
			runtime.ready = undefined;
			throw error;
		});
	}
	return runtime.ready;
}

/**
 * Runs the app's own action or hook with `c.pi` set to the session, then
 * saves what it changed, such as the model, as the built-in actions do. Code
 * that never reads `c.pi` runs even when the session cannot open; reading
 * `c.pi` throws the open error. Shutdown hooks pass `opensSession: false`, so
 * they use a session that is already open and never create a session or a
 * sandbox only to close it.
 */
export async function withPiSession<T>(
	c: PiContext,
	options: PiSessionOptions,
	body: () => T | Promise<T>,
	{ opensSession = true }: { opensSession?: boolean } = {},
): Promise<T> {
	const runtime = piRuntime(c);
	// Hooks such as onDisconnect still run after the session closed; only using c.pi fails.
	if (runtime.closing) return withUnavailablePi(c, sessionClosed(), body);
	if (!opensSession && !runtime.ready) {
		return withUnavailablePi(c, sessionNotOpen(), body);
	}
	let handle: PiSession;
	try {
		handle = await ensurePiSession(c, options);
	} catch (error) {
		c.log.warn({
			msg: "pi session could not open; reading c.pi throws this error",
			error,
		});
		return withUnavailablePi(c, error, body);
	}
	Object.defineProperty(c, "pi", { value: handle.session, configurable: true });
	let result: T;
	try {
		result = await body();
	} catch (error) {
		await persistPiState(c, handle).catch((writeError: unknown) => {
			c.log.error({
				msg: "pi state write failed after an app action error",
				error: writeError,
			});
		});
		throw error;
	}
	await persistPiState(c, handle);
	return result;
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

function sessionNotOpen() {
	return new UserError(
		"The Pi session is not open in this actor generation, so this shutdown hook cannot use c.pi.",
	);
}

function sessionClosed() {
	return new UserError(
		"The Pi session is closed because the actor is stopping.",
	);
}

/** Pi's built-in tools, which all run on the actor host. */
const PI_BUILT_IN_TOOLS = [
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
];

async function openPiSession(
	c: PiContext,
	runtime: PiRuntime,
	options: PiSessionOptions,
): Promise<PiSession> {
	const {
		settings,
		sandbox: sandboxProvider,
		providers,
		apiKeys,
		model,
		scopedModels,
		credentials: credentialSource,
		...sessionOptions
	} = options;
	const loaded = await loadPiSession(c.db);
	const stored = loaded && (await migratePiSession(c.db, loaded));
	const sandbox = sandboxProvider ? lazySandbox(c, sandboxProvider) : undefined;
	// A new session takes its working directory from the sandbox, so only its first open connects.
	const firstSandbox =
		sandbox && !stored ? (await sandbox.connect()).sandbox : undefined;
	const cwd =
		firstSandbox?.cwd ?? stored?.cwd ?? sessionOptions.cwd ?? process.cwd();
	if (!isAbsolute(cwd)) {
		throw new Error(`pi() cwd must be an absolute path, received ${cwd}`);
	}
	const connect = sandbox && (async () => (await sandbox.connect()).sandbox);

	const settingsManager = SettingsManager.inMemory(
		stored?.settings ?? settings ?? {},
	);
	const sessionManager = stored
		? SessionManager.inMemory(cwd, undefined, toFileEntries(stored))
		: SessionManager.inMemory(cwd);
	const credentials = credentialSource
		? new SourceCredentialStore(credentialSource(c))
		: undefined;
	const modelRuntime = await createActorModelRuntime(
		{ providers, apiKeys },
		credentials ?? emptyCredentialStore,
	);
	const resourceLoader =
		sessionOptions.resourceLoader ??
		(await isolatedResourceLoader(
			cwd,
			sessionOptions.agentDir,
			settingsManager,
		));

	const { session, modelFallbackMessage } = await createAgentSession({
		...sessionOptions,
		cwd,
		modelRuntime,
		model: openingModel(
			{ model, scopedModels },
			modelRuntime,
			sessionManager.buildSessionContext().model,
		),
		settingsManager,
		sessionManager,
		resourceLoader,
		customTools: connect
			? [
					...(sessionOptions.customTools ?? []),
					...createSandboxTools(cwd, connect),
				]
			: sessionOptions.customTools,
		excludeTools: [
			...new Set([
				...(sessionOptions.excludeTools ?? []),
				...(sandbox ? ["powershell"] : PI_BUILT_IN_TOOLS),
			]),
		],
	});
	if (modelFallbackMessage) {
		c.log.warn({ msg: "pi model fallback", detail: modelFallbackMessage });
	}

	const handle: PiSession = {
		session,
		settingsManager,
		cwd,
		sandbox,
		bashOperations: connect
			? createSandboxBashOperations(cwd, connect)
			: undefined,
		persistedSettings: JSON.stringify(settingsManager.getGlobalSettings()),
		persistedEntryCount: stored?.entries.length ?? 0,
		credentials,
	};

	if (!stored) {
		const header = sessionManager.getHeader();
		if (!header) {
			throw new Error("Pi did not create a session header");
		}
		await createPiSession(c.db, {
			header,
			cwd,
			settings: JSON.parse(handle.persistedSettings) as PiSettings,
		});
	}
	await flushPiEntries(c, runtime, handle);
	session.subscribe((event) => {
		broadcastSessionEvent(c, event);
		if (!isStreamingDelta(event)) {
			flushPiEntries(c, runtime, handle).catch((error: unknown) => {
				c.log.error({
					msg: "pi session entry write failed, retrying on the next flush",
					error,
				});
			});
		}
		// The run state tells the next wake whether a run was cut off.
		if (
			event.type === "agent_start" ||
			(event.type === "queue_update" && session.isStreaming)
		) {
			void writeInOrder(c, runtime, () =>
				savePiRunning(c.db, queuedMessages(session)),
			);
		} else if (event.type === "agent_settled") {
			void writeInOrder(c, runtime, () => savePiIdle(c.db));
		}
	});

	c.log.info({
		msg: "pi session opened",
		sessionId: session.sessionId,
		restored: stored !== undefined,
		entryCount: sessionManager.getEntries().length,
		messageCount: session.messages.length,
	});
	return handle;
}

/**
 * Connects to the actor's sandbox, creating one when none is stored or the
 * provider reports the stored one no longer exists. A new sandbox id is saved
 * as soon as `create` returns, so a failure later in the start reuses it. Any
 * other connect failure is thrown, so a temporary outage never replaces a
 * sandbox. `pi()` and `piDurable()` both store the id in `pi_sandbox`.
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
 * Pi's resource discovery reads the actor host's filesystem and loads host
 * code as extensions. Extensions, skills, prompt templates, context files, and
 * themes stay off unless the developer passes a loader.
 */
async function isolatedResourceLoader(
	cwd: string,
	agentDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<DefaultResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: agentDir ?? getAgentDir(),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		noThemes: true,
	});
	await loader.reload();
	return loader;
}

/** Token and output deltas never append entries, so they skip the entry diff. */
function isStreamingDelta(event: AgentSessionEvent): boolean {
	return (
		event.type === "message_update" ||
		event.type === "tool_execution_update" ||
		event.type === "bash_execution_update"
	);
}

/**
 * Writes every entry Pi appended since the last successful write, in append
 * order. The count only advances after an insert succeeds, so a failed write
 * is retried by the next flush. Returns the write so actions can await it.
 */
function flushPiEntries(
	c: PiContext,
	runtime: PiRuntime,
	handle: PiSession,
): Promise<void> {
	const write = runtime.writes.then(async () => {
		const entries = handle.session.sessionManager.getEntries();
		while (handle.persistedEntryCount < entries.length) {
			await appendPiEntry(c.db, entries[handle.persistedEntryCount]!);
			handle.persistedEntryCount += 1;
		}
	});
	runtime.writes = write.catch(() => {});
	return write;
}

/** Runs a SQLite write after the entry writes queued before it. */
function writeInOrder(
	c: PiContext,
	runtime: PiRuntime,
	write: () => Promise<void>,
): Promise<void> {
	const next = runtime.writes.then(write);
	runtime.writes = next.catch((error: unknown) => {
		c.log.error({ msg: "pi run state write failed", error });
	});
	return next;
}

function queuedMessages(session: AgentSession): PiQueue {
	return {
		steering: [...session.getSteeringMessages()],
		followUp: [...session.getFollowUpMessages()],
	};
}

/**
 * Continues the run that was active when the actor stopped, when Pi's own
 * `Agent.continue()` accepts the transcript: its last message is a user or a
 * tool result message. Otherwise the chat stays as Pi left it, as after an
 * abort. The run continues in the background and keeps the actor awake.
 */
export async function resumeInterruptedRun(
	c: PiContext,
	options: PiSessionOptions,
): Promise<void> {
	const queue = await loadPiInterruptedRun(c.db);
	if (!queue) return;
	const handle = await ensurePiSession(c, options);
	const lastRole = handle.session.messages.at(-1)?.role;
	if (lastRole !== "user" && lastRole !== "toolResult") {
		c.log.info({
			msg: "pi run stopped where Pi cannot continue it, leaving the chat as is",
			lastRole,
		});
		await writeInOrder(c, piRuntime(c), () => savePiIdle(c.db));
		return;
	}
	c.log.info({
		msg: "resuming the pi run that was active when the actor stopped",
		lastRole,
	});
	const run = continueRun(handle.session, queue)
		.then(() => persistPiState(c, handle))
		.catch((error: unknown) => {
			c.log.error({ msg: "resumed pi run failed", error });
		});
	void c.keepAwake(run);
}

/** The private `AgentSession` methods that resume uses. */
interface AgentSessionInternals {
	_runAgentPrompt(messages: unknown[]): Promise<void>;
	_queueSteer(text: string): Promise<void>;
	_queueFollowUp(text: string): Promise<void>;
}

/**
 * Runs `AgentSession`'s own run loop from the stored transcript, so retry,
 * compaction, and queued messages work as in any run. The loop starts with
 * `agent.prompt`; for that one call it continues instead. `pi-coding-agent`
 * is pinned exactly, and the resume test fails if these methods change.
 */
async function continueRun(
	session: AgentSession,
	queue: PiQueue,
): Promise<void> {
	const internals = session as unknown as AgentSessionInternals;
	for (const text of queue.steering) await internals._queueSteer(text);
	for (const text of queue.followUp) await internals._queueFollowUp(text);
	const agent = session.agent;
	Object.defineProperty(agent, "prompt", {
		configurable: true,
		value: async () => {
			Reflect.deleteProperty(agent, "prompt");
			await agent.continue();
		},
	});
	try {
		await internals._runAgentPrompt([]);
	} finally {
		Reflect.deleteProperty(agent, "prompt");
	}
}

function broadcastSessionEvent(c: PiContext, event: AgentSessionEvent): void {
	try {
		c.broadcast("event", event);
	} catch (error) {
		if (isActorStoppingError(error)) return;
		c.log.error({ msg: "failed to broadcast pi session event", error });
	}
}

function isActorStoppingError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { group?: unknown; code?: unknown };
	return candidate.group === "actor" && candidate.code === "stopping";
}

/**
 * Queues entries appended since the last flush and writes Pi's mutable settings
 * when they changed. Called after every action and on shutdown.
 */
export async function persistPiState(
	c: PiContext,
	handle: PiSession,
): Promise<void> {
	await flushPiEntries(c, piRuntime(c), handle);
	const settings = handle.settingsManager.getGlobalSettings();
	const encoded = JSON.stringify(settings);
	if (encoded === handle.persistedSettings) return;
	await savePiSettings(c.db, settings);
	handle.persistedSettings = encoded;
}

/**
 * Aborts the run in memory when RivetKit declares this actor generation lost.
 * The engine may already run the next generation, which resumes the run, so
 * the lost one must stop calling the model and running tools. A lost
 * generation skips `onSleep`, and its storage rejects writes, so nothing is
 * stored here. A normal stop fires the same signal and drains in `onSleep`.
 * Takes the wake context, whose signal is the actor's, not one action's.
 */
export function stopRunWhenLost(c: PiContext): void {
	const runtime = piRuntime(c);
	c.abortSignal.addEventListener(
		"abort",
		() => {
			if (!isLost(c)) return;
			runtime.closing = true;
			const ready = runtime.ready;
			runtime.ready = undefined;
			void ready
				?.then((handle) => handle.session.abort())
				.catch((error: unknown) =>
					c.log.error({ msg: "pi could not abort the lost run", error }),
				);
			c.log.warn({
				msg: "pi actor generation lost, aborting its run; the next generation resumes it",
			});
		},
		{ once: true },
	);
}

/**
 * RivetKit releases that stop lost generations expose `isLost` on the actor
 * context. Older releases still run `onSleep` for a lost generation, so the
 * drain handles it there.
 */
function isLost(c: PiContext): boolean {
	return (c as { isLost?: unknown }).isLost === true;
}

/**
 * Waits until the session is idle, or until `drainUntil` passes. Idle sleep
 * never has a run, so this only waits on a forced stop, such as a deploy. The
 * deadline ends before RivetKit's, so closing still fits in the grace period.
 * Pi stores each message as it ends, and the next wake resumes the run.
 */
async function drain(
	c: PiContext,
	session: AgentSession,
	drainUntil: number,
): Promise<void> {
	if (session.isIdle) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const gracePeriodEnded = new Promise<true>((resolve) => {
		timer = setTimeout(
			() => resolve(true),
			Math.max(0, drainUntil - Date.now()),
		);
	});
	try {
		const idle = session.waitForIdle().then(() => false as const);
		if (await Promise.race([idle, gracePeriodEnded])) {
			c.log.warn({
				msg: "pi run still active at the end of the grace period; it resumes on wake when Pi can continue it",
			});
		}
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Stops the Pi session for this actor generation. On sleep it first waits,
 * until `drainUntil`, for a run to finish. A run still active then is not
 * aborted: the transcript ends at the last message Pi stored, and the next
 * wake resumes it. On destroy it aborts the run at once, since nothing would
 * resume it. Then lets extensions shut down, flushes settings and entries,
 * and suspends the sandbox on sleep, or destroys it on destroy.
 */
export async function closePiSession(
	c: PiContext,
	options: PiSessionOptions,
	stop: PiStop,
): Promise<void> {
	const runtime = piRuntime(c);
	const ready = runtime.ready;
	const errors: unknown[] = [];
	let handle: PiSession | undefined;
	try {
		handle = await ready;
	} catch {}

	if (handle) {
		const open = handle;
		await attempt(errors, () =>
			stop.reason === "sleep"
				? drain(c, open.session, stop.drainUntil)
				: open.session.abort(),
		);
	}
	runtime.closing = true;
	runtime.ready = undefined;

	if (handle) {
		const open = handle;
		await attempt(errors, async () => {
			if (open.session.hasExtensionHandlers("session_shutdown")) {
				await open.session.extensionRunner.emit({
					type: "session_shutdown",
					reason: "quit",
				});
			}
		});
		await attempt(errors, () => persistPiState(c, open));
		open.session.dispose();
		c.log.info({ msg: "pi session closed", sessionId: open.session.sessionId });
	}

	const provider = options.sandbox;
	if (provider) {
		await attempt(errors, () =>
			closeSandbox(c, provider, handle?.sandbox?.current, stop),
		);
	}

	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) {
		throw new AggregateError(errors, "pi session shutdown failed");
	}
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

async function attempt(
	errors: unknown[],
	operation: () => void | Promise<void>,
): Promise<void> {
	try {
		await operation();
	} catch (error) {
		errors.push(error);
	}
}
