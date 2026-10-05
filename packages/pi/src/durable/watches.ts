import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import {
	type AgentEvent,
	type ConversationDocToken,
	type ConversationId,
	type ConversationView,
	type Harness,
	type JsonObject,
	type SnapshotEvent,
	type TaskGraph,
	type WatchHandle,
	watchEvents,
} from "@earendil-works/pi-durable";
import type { PiContext } from "../runtime.js";
import {
	deleteConnectionWatches,
	deleteWatch,
	loadWatches,
	saveWatch,
	type WatchSpec,
} from "./storage.js";

/** One batch of agent events, one commit per batch. */
export type PiEventsFrame = {
	conversationId: number;
	seq: number;
	events: readonly AgentEvent[];
};
/** `seq` 0 carries the whole view; later frames carry Chord operations. */
export type PiViewFrame = {
	conversationId: number;
	seq: number;
	value?: ConversationView;
	ops?: readonly Op[];
};
/** `seq` 0 carries the whole graph; later frames carry Chord operations. */
export type PiTaskGraphFrame = {
	seq: number;
	value?: TaskGraph;
	ops?: readonly Op[];
};
/** Every frame carries the document's whole value; `null` means it was retired. */
export type PiDocFrame = {
	kind: string;
	conversationId: number;
	seq: number;
	value: JsonObject | null;
};

/**
 * Events a watching connection receives. `seq` counts frames per watch: the
 * action's result is frame 0, and later frames count from 1. A frame with
 * `seq` 0 replaces everything the client had, as after a reattach on wake. A
 * client that sees a gap calls the watch action again.
 */
export type PiWatchEvents = {
	"pi.events": PiEventsFrame;
	"pi.view": PiViewFrame;
	"pi.taskGraph": PiTaskGraphFrame;
	"pi.doc": PiDocFrame;
};

type ActiveWatch = { stop(): Promise<void> };

/** The open Pi watches of this actor generation. */
export type ConnectionWatches = {
	/** Open watches by connection id and watch key. */
	byConnection: Map<string, Map<string, ActiveWatch>>;
	/** Watch changes run one at a time, so overlapping calls cannot leave a stream that nothing stops. */
	queue: Promise<unknown>;
};

export function createConnectionWatches(): ConnectionWatches {
	return { byConnection: new Map(), queue: Promise.resolve() };
}

function serially<T>(
	watches: ConnectionWatches,
	change: () => Promise<T>,
): Promise<T> {
	const run = watches.queue.then(change);
	watches.queue = run.catch(() => {});
	return run;
}

type Documents = ReadonlyMap<string, ConversationDocToken<any>>;

export function watchKey(spec: WatchSpec): string {
	switch (spec.kind) {
		case "events":
		case "view":
			return `${spec.kind}:${spec.conversationId}`;
		case "taskGraph":
			return spec.kind;
		case "doc":
			return `doc:${spec.conversationId}:${spec.docKind}`;
	}
}

/**
 * Starts a watch for a connection, stored so it comes back after sleep, and
 * returns the value it starts from. Watching the same thing again restarts
 * it with a fresh value.
 */
export async function watch(
	actor: PiContext,
	watches: ConnectionWatches,
	harness: Harness,
	documents: Documents,
	connId: string,
	spec: WatchSpec,
): Promise<unknown> {
	const key = watchKey(spec);
	return serially(watches, async () => {
		await saveWatch(actor.db, { connId, key, spec });
		return attach(actor, watches, harness, documents, connId, key, spec, false);
	});
}

export async function unwatch(
	actor: PiContext,
	watches: ConnectionWatches,
	connId: string,
	spec: WatchSpec,
): Promise<void> {
	const key = watchKey(spec);
	await serially(watches, async () => {
		const active = watches.byConnection.get(connId)?.get(key);
		watches.byConnection.get(connId)?.delete(key);
		await active?.stop();
		await deleteWatch(actor.db, connId, key);
	});
}

/** Ends every watch of a connection that left. */
export async function unwatchConnection(
	actor: PiContext,
	watches: ConnectionWatches,
	connId: string,
): Promise<void> {
	await serially(watches, async () => {
		const active = [...(watches.byConnection.get(connId)?.values() ?? [])];
		watches.byConnection.delete(connId);
		await Promise.all(active.map((watch) => watch.stop()));
		await deleteConnectionWatches(actor.db, connId);
	});
}

/** Ends every watch of this generation, without forgetting them. Called when the harness closes. */
export async function stopAllWatches(
	watches: ConnectionWatches,
): Promise<void> {
	await serially(watches, async () => {
		const active = [...watches.byConnection.values()].flatMap((byKey) => [
			...byKey.values(),
		]);
		watches.byConnection.clear();
		await Promise.all(active.map((watch) => watch.stop()));
	});
}

/**
 * Restarts the stored watches of connections that are still open, after wake
 * or a reopen. Each sends its whole value as a `seq` 0 frame. Watches of
 * connections that are gone are forgotten.
 */
export async function reattachWatches(
	actor: PiContext,
	watches: ConnectionWatches,
	harness: Harness,
	documents: Documents,
): Promise<void> {
	await serially(watches, async () => {
		const open = new Set(actor.conns.keys());
		for (const stored of await loadWatches(actor.db)) {
			if (!open.has(stored.connId)) {
				await deleteWatch(actor.db, stored.connId, stored.key);
				continue;
			}
			try {
				await attach(
					actor,
					watches,
					harness,
					documents,
					stored.connId,
					stored.key,
					stored.spec,
					true,
				);
			} catch (error) {
				actor.log.warn({
					msg: "pi durable could not reattach a watch after wake",
					connId: stored.connId,
					watch: stored.key,
					error,
				});
			}
		}
	});
}

async function attach(
	actor: PiContext,
	watches: ConnectionWatches,
	harness: Harness,
	documents: Documents,
	connId: string,
	key: string,
	spec: WatchSpec,
	resend: boolean,
): Promise<unknown> {
	const byKey =
		watches.byConnection.get(connId) ?? new Map<string, ActiveWatch>();
	watches.byConnection.set(connId, byKey);
	await byKey.get(key)?.stop();

	let seq = 0;
	let active: ActiveWatch | undefined;
	const send = <K extends keyof PiWatchEvents>(
		name: K,
		frame: Omit<PiWatchEvents[K], "seq">,
	) => {
		const conn = actor.conns.get(connId);
		if (!conn) {
			void active?.stop();
			return;
		}
		conn.send(name, { ...frame, seq: seq++ });
	};
	const started = await start(
		actor.log,
		harness,
		documents,
		spec,
		send,
		resend,
	);
	active = started;
	byKey.set(key, started);
	if (!resend) seq = 1;
	return started.initial;
}

type Send = <K extends keyof PiWatchEvents>(
	name: K,
	frame: Omit<PiWatchEvents[K], "seq">,
) => void;

/** Starts the Pi watch. With `resend`, the initial value goes out as the first frame. */
async function start(
	log: PiContext["log"],
	harness: Harness,
	documents: Documents,
	spec: WatchSpec,
	send: Send,
	resend: boolean,
): Promise<ActiveWatch & { initial: unknown }> {
	const context = BACKGROUND_CONTEXT;
	switch (spec.kind) {
		case "events": {
			const conversationId = spec.conversationId;
			const stream = await watchEvents(
				harness,
				conversationId as ConversationId,
				context,
			);
			if (resend)
				send("pi.events", {
					conversationId,
					events: [stream.snapshot satisfies SnapshotEvent],
				});
			stream.start(async (events) =>
				send("pi.events", { conversationId, events }),
			);
			return {
				initial: { snapshot: stream.snapshot },
				stop: async () => void (await stream.stop()),
			};
		}
		case "view": {
			const conversationId = spec.conversationId;
			const conversation = await harness.conversation(
				conversationId as ConversationId,
				context,
			);
			if (!conversation)
				throw new Error(`conversation ${conversationId} does not exist`);
			const view = await conversation.watch(context);
			if (resend) send("pi.view", { conversationId, value: view.value });
			view.start(async (_value, ops) =>
				send("pi.view", { conversationId, ops }),
			);
			return {
				initial: { value: view.value },
				stop: async () => void (await view.stop()),
			};
		}
		case "taskGraph": {
			const graph = await harness.watchTaskGraph(context);
			if (resend) send("pi.taskGraph", { value: graph.value });
			graph.start(async (_value, ops) => send("pi.taskGraph", { ops }));
			return {
				initial: { value: graph.value },
				stop: async () => void (await graph.stop()),
			};
		}
		case "doc":
			return startDoc(log, harness, documents, spec, send, resend);
	}
}

/**
 * Pi's `watchDoc` never creates a document. For one that does not exist yet,
 * the watch attaches when a commit creates it, and its value is the first frame.
 */
async function startDoc(
	log: PiContext["log"],
	harness: Harness,
	documents: Documents,
	spec: Extract<WatchSpec, { kind: "doc" }>,
	send: Send,
	resend: boolean,
): Promise<ActiveWatch & { initial: unknown }> {
	const token = documents.get(spec.docKind);
	if (!token)
		throw new Error(
			`document ${spec.docKind} is not listed in piDurable({ documents })`,
		);
	const { docKind: kind, conversationId } = spec;
	const conversation = conversationId as ConversationId;
	let docWatch: WatchHandle<Readonly<JsonObject> | null> | undefined;
	let stopped = false;

	const follow = (
		handle: WatchHandle<Readonly<JsonObject> | null>,
		sendFirst: boolean,
	) => {
		docWatch = handle;
		if (sendFirst)
			send("pi.doc", { kind, conversationId, value: handle.value });
		handle.start(async (value) =>
			send("pi.doc", { kind, conversationId, value }),
		);
	};

	const existing = await harness.watchDoc(
		token,
		conversation,
		BACKGROUND_CONTEXT,
	);
	if (existing) {
		follow(existing, resend);
		return {
			initial: { value: existing.value },
			stop: async () => {
				stopped = true;
				await docWatch?.stop();
			},
		};
	}

	if (resend) send("pi.doc", { kind, conversationId, value: null });
	let attaching = false;
	const unsubscribe = harness.subscribeCommits((publication) => {
		const created = publication.changes.some(
			(change) =>
				change.type === "document" &&
				change.record.kind === kind &&
				change.conversationId === conversation &&
				change.value !== null,
		);
		if (!created || attaching) return;
		attaching = true;
		// Commit listeners must not call Pi Durable, so the watch attaches after the listener returns.
		queueMicrotask(() => void attachCreated());
	});
	const attachCreated = async () => {
		try {
			const handle = await harness.watchDoc(
				token,
				conversation,
				BACKGROUND_CONTEXT,
			);
			if (stopped) {
				await handle?.stop();
				return;
			}
			if (!handle) {
				attaching = false;
				return;
			}
			unsubscribe();
			follow(handle, true);
		} catch (error) {
			// The next write to the document tries again.
			attaching = false;
			log.warn({
				msg: "pi durable could not attach a document watch",
				kind,
				conversationId,
				error,
			});
		}
	};
	return {
		initial: { value: undefined },
		stop: async () => {
			stopped = true;
			unsubscribe();
			await docWatch?.stop();
		},
	};
}
