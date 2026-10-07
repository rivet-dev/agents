import type { Context } from "@earendil-works/chord";
import type {
	Agent,
	AgentChange,
	Conversation,
	ConversationAbortOptions,
	ConversationId,
	ConversationOwnership,
	ConversationView,
	Cursor,
	EntryId,
	EntryQuery,
	Harness,
	JsonObject,
	SnapshotEvent,
	Submission,
	SubmissionDraft,
	SubmissionId,
	TaskGraph,
	TaskId,
	UserInput,
} from "@earendil-works/pi-durable";
import { UserError } from "rivetkit";
import { assertModelAllowed } from "./models.js";
import type { PiContext } from "./runtime.js";
import {
	documentsByKind,
	type PiOptions,
	piRuntime,
	withHarness,
} from "./runtime.js";
import type { WatchSpec } from "./storage.js";
import { traceRun } from "./tracing.js";
import { unwatch, watch } from "./watches.js";

/** `AgentChange` as it crosses the wire: extensions and tools by name. */
export type PiAgentChange = Omit<AgentChange, "extensions" | "tools"> & {
	readonly extensions?:
		| readonly string[]
		| { readonly add?: readonly string[]; readonly remove?: readonly string[] }
		| null;
	readonly tools?:
		| readonly string[]
		| { readonly remove: readonly string[] }
		| null;
};

/** A conversation's resolved agent with extensions, tools, and sections by name. */
export interface PiAgentInfo {
	model: Agent["model"];
	thinkingLevel: Agent["thinkingLevel"];
	extensions: string[];
	tools: string[];
	sections: string[];
	instructions: Agent["instructions"];
	cwd: Agent["cwd"];
}

/** Options for `harness.createConversation` and `conversation.fork`, with the agent change by name. */
export interface PiCreateConversationOptions {
	ownership: ConversationOwnership;
	agent?: PiAgentChange;
}

/** Options for `prompt`. */
export interface PiPromptOptions {
	/** Defaults to the root conversation. */
	conversationId?: number;
	/** Deduplicates retries: a second prompt with the same id returns the first one's submission. */
	requestId?: string;
	whenBusy?: "steer" | "followUp" | "reject";
}

/** How a `prompt` settled. `unanswered` carries Pi's reason, such as a model error. */
export type PiPromptResult =
	| {
			status: "done";
			/** The answer's text. */
			text: string | undefined;
			submissionId: SubmissionId;
	  }
	| { status: "unanswered"; reason: string; submissionId: SubmissionId };

/** The built-in actions of a `pi()` actor, as clients call them. */
export type PiActions = ReturnType<typeof createPiActions>;

/**
 * The `pi()` actions: Pi Durable's `Harness`, `Conversation`, and
 * `Submission` methods under `harness`, `conversation`, and `submission`, with
 * the same names. Ids replace objects, and conversation methods take the
 * conversation id first. `prompt` is the one convenience action.
 */
export function createPiActions(options: PiOptions) {
	const documents = documentsByKind(options);
	const run = <T>(
		c: PiContext,
		body: (harness: Harness, context: Context) => Promise<T>,
	) => withHarness(c, options, body);
	const agentChange = (change: PiAgentChange | undefined) =>
		change === undefined ? undefined : resolveAgentChange(options, change);

	/**
	 * Starts a watch for the calling connection. Frames go to that connection
	 * only. `T` is the starting value `start` in `watches.ts` returns for the
	 * kind in `spec`; each action below names it.
	 */
	const watchFor = <T>(c: PiContext, spec: WatchSpec) =>
		run(c, async (harness, context) => {
			const connId = connectionId(c);
			const runtime = piRuntime(c);
			return (await watch(
				runtime.actor ?? c,
				runtime.watches,
				harness,
				documents,
				connId,
				spec,
				() => requireWatchTarget(harness, spec, context),
			)) as T;
		});
	const unwatchFor = (c: PiContext, spec: WatchSpec) =>
		run(c, async () => {
			const runtime = piRuntime(c);
			await unwatch(runtime.actor ?? c, runtime.watches, connectionId(c), spec);
		});
	const requireWatchTarget = async (
		harness: Harness,
		spec: WatchSpec,
		context: Context,
	) => {
		if (spec.kind === "doc") requireDocument(spec.docKind);
		if (spec.kind !== "taskGraph")
			await requireConversation(harness, spec.conversationId, context);
	};
	const requireDocument = (kind: string) => {
		const doc = documents.get(kind);
		if (!doc) {
			throw new UserError(
				`Document ${kind} is not listed in pi({ documents }).`,
			);
		}
		return doc;
	};

	// Ids arrive as plain numbers and are cast to Pi's branded id types. Pi's
	// lookups check that each one exists, and a missing one is a `UserError`.
	return {
		harness: {
			root: (c: PiContext, rootOptions?: { agent?: PiAgentChange }) =>
				run(c, async (harness, context) => ({
					id: (
						await harness.root(context, {
							agent: agentChange(rootOptions?.agent),
						})
					).id,
				})),
			conversation: (c: PiContext, id: number) =>
				run(c, (harness, context) =>
					harness.commit(
						(tx) => tx.conversation(id as ConversationId),
						context,
					),
				),
			createConversation: (c: PiContext, create: PiCreateConversationOptions) =>
				run(c, async (harness, context) => ({
					id: (
						await harness.createConversation(
							{ ownership: create.ownership, agent: agentChange(create.agent) },
							context,
						)
					).id,
				})),
			submission: (c: PiContext, id: number) =>
				run(c, async (harness, context) =>
					(await harness.submission(id as SubmissionId, context))?.status(
						context,
					),
				),
			abortSubmission: (c: PiContext, id: number, conversationId?: number) =>
				run(c, async (harness, context) => {
					const result = await harness.abortSubmission(
						id as SubmissionId,
						context,
						conversationId as ConversationId | undefined,
					);
					if (result === "not_found") throw submissionNotFound(id);
					return result;
				}),
			getTask: (c: PiContext, id: number) =>
				run(c, (harness, context) => harness.getTask(id as TaskId, context)),
			abortTask: (c: PiContext, id: number) =>
				run(c, async (harness, context) => {
					await requireTask(harness, id, context);
					return harness.abortTask(id as TaskId, context);
				}),
			waitForTask: (c: PiContext, id: number) =>
				run(c, async (harness, context) => {
					await requireTask(harness, id, context);
					return harness.waitForTask(id as TaskId, context);
				}),
			waitForIdle: (c: PiContext) =>
				run(c, (harness, context) => harness.waitForIdle(context)),
			inspect: (c: PiContext) =>
				run(c, async (harness, context) => {
					const inspection = await harness.inspect(context);
					return {
						...inspection,
						// A migration failure carries an Error, which does not cross the wire.
						tasks: inspection.tasks.map((task) =>
							task.state.kind === "blocked" && task.state.error !== undefined
								? {
										...task,
										state: {
											...task.state,
											error: errorMessage(task.state.error),
										},
									}
								: task,
						),
					};
				}),
			usage: (c: PiContext) =>
				run(c, (harness, context) => harness.usage(context)),
			taskGraph: (c: PiContext) =>
				run(c, async (harness, context) => {
					const graph = await harness.taskGraph(context);
					try {
						return graph.value;
					} finally {
						graph.dispose();
					}
				}),
			snapshot: (c: PiContext, kind: string, conversationId: number) =>
				run(c, async (harness, context) =>
					harness.snapshot(
						requireDocument(kind),
						conversationId as ConversationId,
						context,
					),
				),
			/** The task graph; then `pi.taskGraph` frames to this connection. */
			watchTaskGraph: (c: PiContext) =>
				watchFor<{ value: TaskGraph }>(c, { kind: "taskGraph" }),
			unwatchTaskGraph: (c: PiContext) => unwatchFor(c, { kind: "taskGraph" }),
			/**
			 * The document's value; then `pi.doc` frames to this connection. A
			 * document that does not exist yet has value `undefined`, and its
			 * first frame arrives when a commit creates it.
			 */
			watchDoc: (c: PiContext, kind: string, conversationId: number) =>
				watchFor<{ value: JsonObject | null | undefined }>(c, {
					kind: "doc",
					docKind: kind,
					conversationId,
				}),
			unwatchDoc: (c: PiContext, kind: string, conversationId: number) =>
				unwatchFor(c, { kind: "doc", docKind: kind, conversationId }),
		},

		conversation: {
			agent: (c: PiContext, conversationId: number): Promise<PiAgentInfo> =>
				run(c, async (harness, context) =>
					agentInfo(
						await (
							await requireConversation(harness, conversationId, context)
						).agent(context),
					),
				),
			configure: (
				c: PiContext,
				conversationId: number,
				change: PiAgentChange,
			) =>
				run(c, async (harness, context) => {
					const resolved = resolveAgentChange(options, change);
					await (
						await requireConversation(harness, conversationId, context)
					).configure(resolved, context);
				}),
			submit: (c: PiContext, conversationId: number, draft: SubmissionDraft) =>
				run(c, async (harness, context) =>
					(
						await (
							await requireConversation(harness, conversationId, context)
						).submit(draft, context)
					).status(context),
				),
			reset: (c: PiContext, conversationId: number, handoff?: string) =>
				run(c, async (harness, context) =>
					(await requireConversation(harness, conversationId, context)).reset(
						handoff,
						context,
					),
				),
			compact: (c: PiContext, conversationId: number, instructions?: string) =>
				run(c, async (harness, context) =>
					(await requireConversation(harness, conversationId, context)).compact(
						instructions,
						context,
					),
				),
			context: (c: PiContext, conversationId: number) =>
				run(c, async (harness, context) =>
					(await requireConversation(harness, conversationId, context)).context(
						context,
					),
				),
			entries: (
				c: PiContext,
				conversationId: number,
				query: Omit<EntryQuery, "conversationId">,
				limit: number,
				cursor?: Cursor,
			) =>
				run(c, async (harness, context) =>
					(await requireConversation(harness, conversationId, context)).entries(
						query,
						limit,
						cursor,
						context,
					),
				),
			fork: (
				c: PiContext,
				conversationId: number,
				at: number,
				fork: PiCreateConversationOptions,
			) =>
				run(c, async (harness, context) => {
					const conversation = await requireConversation(
						harness,
						conversationId,
						context,
					);
					const forked = await conversation.fork(
						at as EntryId,
						{ ownership: fork.ownership, agent: agentChange(fork.agent) },
						context,
					);
					return { id: forked.id };
				}),
			abort: (
				c: PiContext,
				conversationId: number,
				abortOptions?: ConversationAbortOptions,
			) =>
				run(c, async (harness, context) =>
					(await requireConversation(harness, conversationId, context)).abort(
						context,
						abortOptions,
					),
				),
			waitForIdle: (c: PiContext, conversationId: number) =>
				run(c, async (harness, context) =>
					(
						await requireConversation(harness, conversationId, context)
					).waitForIdle(context),
				),
			/** The structural view; then `pi.view` frames with Chord operations to this connection. */
			watch: (c: PiContext, conversationId: number) =>
				watchFor<{ value: ConversationView }>(c, {
					kind: "view",
					conversationId,
				}),
			unwatch: (c: PiContext, conversationId: number) =>
				unwatchFor(c, { kind: "view", conversationId }),
			/** A snapshot, partial answer included; then `pi.events` batches to this connection. Nothing is replayed. */
			watchEvents: (c: PiContext, conversationId: number) =>
				watchFor<{ snapshot: SnapshotEvent }>(c, {
					kind: "events",
					conversationId,
				}),
			unwatchEvents: (c: PiContext, conversationId: number) =>
				unwatchFor(c, { kind: "events", conversationId }),
		},

		submission: {
			status: (c: PiContext, id: number) =>
				run(c, async (harness, context) =>
					(await requireSubmission(harness, id, context)).status(context),
				),
			wait: (c: PiContext, id: number) =>
				run(c, async (harness, context) =>
					(await requireSubmission(harness, id, context)).wait(context),
				),
			abort: (c: PiContext, id: number) =>
				run(c, async (harness, context) =>
					(await requireSubmission(harness, id, context)).abort(context),
				),
		},

		/**
		 * Submits user input, waits for the run to settle, and returns the
		 * answer's text. A model error does not reject: the status is
		 * `unanswered` with Pi's reason.
		 */
		prompt: (
			c: PiContext,
			content: UserInput,
			promptOptions?: PiPromptOptions,
		) =>
			run(c, async (harness, context): Promise<PiPromptResult> => {
				const conversation =
					promptOptions?.conversationId === undefined
						? await harness.root(context)
						: await requireConversation(
								harness,
								promptOptions.conversationId,
								context,
							);
				const submission = await conversation.submit(
					{
						type: "input",
						content,
						requestId: promptOptions?.requestId,
						whenBusy: promptOptions?.whenBusy,
					},
					context,
				);
				const model = (await conversation.agent(context)).model;
				const settled = await traceRun(
					c.actorId,
					conversation.id,
					model && `${model.provider}/${model.modelId}`,
					() => submission.wait(context),
				);
				if (settled.status === "unanswered") {
					return {
						status: settled.status,
						reason: settled.reason,
						submissionId: submission.id,
					};
				}
				return {
					status: settled.status,
					text:
						settled.type === "input"
							? await answerText(conversation, settled.answer, context)
							: undefined,
					submissionId: submission.id,
				};
			}),

		pi: {
			/** Scheduled at the end of a long wait. Opening the harness resumes the waiting work. */
			wake: (c: PiContext) => run(c, async () => {}),
		},
	};
}

/**
 * The calling connection, which receives the watch's frames. A stateless call
 * gets the starting value, and its watch ends with the request. Only a call
 * with no connection at all, such as a scheduled action, cannot watch.
 */
function connectionId(c: PiContext): string {
	const conn = (c as { conn?: { id: string } }).conn;
	if (!conn) {
		throw new UserError(
			"Watching needs a calling connection. Call it from a client handle, and use connect() to receive frames.",
		);
	}
	return conn.id;
}

async function requireConversation(
	harness: Harness,
	id: number,
	context: Context,
): Promise<Conversation> {
	const conversation = await harness.conversation(
		id as ConversationId,
		context,
	);
	if (!conversation) {
		throw new UserError(`Conversation ${id} does not exist.`);
	}
	return conversation;
}

async function requireSubmission(
	harness: Harness,
	id: number,
	context: Context,
): Promise<Submission> {
	const submission = await harness.submission(id as SubmissionId, context);
	if (!submission) throw submissionNotFound(id);
	return submission;
}

function submissionNotFound(id: number) {
	return new UserError(`Submission ${id} does not exist.`);
}

async function requireTask(
	harness: Harness,
	id: number,
	context: Context,
): Promise<void> {
	if (!(await harness.getTask(id as TaskId, context))) {
		throw new UserError(`Task ${id} does not exist.`);
	}
}

/**
 * Resolves extension and tool names against the installed registry. A model
 * outside `scopedModels`, or other than `model` when `scopedModels` is unset,
 * is rejected.
 */
function resolveAgentChange(
	options: PiOptions,
	change: PiAgentChange,
): AgentChange {
	const snapshot = options.registry.snapshot();
	const extension = (name: string) => {
		const found = snapshot.extension(name);
		if (!found) throw new UserError(`Extension ${name} is not installed.`);
		return found;
	};
	const tool = (name: string) => {
		const found = snapshot.tools().find((entry) => entry.tool.name === name);
		if (!found) throw new UserError(`Tool ${name} is not installed.`);
		return found.tool;
	};

	if (change.model) {
		assertModelAllowed(options, change.model.provider, change.model.modelId);
	}

	const { extensions, tools, ...rest } = change;
	return {
		...rest,
		extensions:
			extensions === undefined || extensions === null
				? extensions
				: isNameList(extensions)
					? extensions.map(extension)
					: {
							add: extensions.add?.map(extension),
							remove: extensions.remove?.map(extension),
						},
		tools:
			tools === undefined || tools === null
				? tools
				: isNameList(tools)
					? tools.map(tool)
					: { remove: tools.remove.map(tool) },
	};
}

function isNameList(
	value: readonly string[] | object,
): value is readonly string[] {
	return Array.isArray(value);
}

function agentInfo(agent: Agent): PiAgentInfo {
	return {
		model: agent.model,
		thinkingLevel: agent.thinkingLevel,
		extensions: agent.extensions.map((extension) => extension.name),
		tools: agent.tools.map((tool) => tool.name),
		sections: agent.sections.map((section) => section.key),
		instructions: agent.instructions,
		cwd: agent.cwd,
	};
}

/** The text blocks of the answer entry, which holds the assistant message. */
async function answerText(
	conversation: Conversation,
	answer: EntryId,
	context: Context,
): Promise<string | undefined> {
	const page = await conversation.entries(
		{ minEntryId: answer, maxEntryId: answer },
		1,
		undefined,
		context,
	);
	const message = page.items[0]?.model?.[0];
	if (message?.role !== "assistant") return undefined;
	return message.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
