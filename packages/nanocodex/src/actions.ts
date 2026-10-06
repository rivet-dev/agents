import type {
	AgentOptions,
	AgentSessionContext,
	DefaultAgent,
	PromptInput,
	Thinking,
} from "nanocodex";
import { UserError } from "rivetkit";
import {
	ensureAgent,
	isNanocodexError,
	type NanocodexContext,
	type NanocodexOptions,
	type NanocodexTurnResult,
	promptTurn,
	runningTurn,
} from "./runtime.js";

type Model = NonNullable<AgentOptions["model"]>;

/** What `turn.prompt` takes. */
export interface NanocodexPromptRequest {
	input: PromptInput;
	/**
	 * Identifies the turn. Prompting a finished id returns its result from the
	 * journal without a model call; prompting a running id joins it; prompting
	 * the id of a turn a stop cut off resumes it. Defaults to a new id, so pass
	 * one to make retries safe.
	 */
	id?: string | undefined;
}

/**
 * The built-in actions, one per nanocodex `Turn` and `session` method.
 * nanocodex failures reach clients as a `UserError` whose `code` is
 * nanocodex's own, such as `conflict` or `cancelled`.
 */
export interface NanocodexActions {
	turn: {
		/** Starts a turn and resolves when it finishes. Agent events stream through the `event` event. */
		prompt: (
			c: NanocodexContext,
			request: NanocodexPromptRequest,
		) => Promise<NanocodexTurnResult>;
		/** Adds input to a running turn, which the agent reads at its next step. */
		steer: (
			c: NanocodexContext,
			id: string,
			options: { input: PromptInput; messageId?: string },
		) => Promise<void>;
		/** Removes a steer that the agent has not read yet. Resolves to whether it was removed. */
		withdrawSteer: (
			c: NanocodexContext,
			id: string,
			options: { messageId: string },
		) => Promise<boolean>;
		/** Cancels a running turn. Its `turn.prompt` rejects with code `cancelled`. */
		cancel: (c: NanocodexContext, id: string) => Promise<void>;
	};
	session: {
		/** Adds a developer message to the conversation and returns the context. */
		appendDeveloperMessage: (
			c: NanocodexContext,
			text: string,
		) => Promise<AgentSessionContext>;
		/** Compacts the conversation history. */
		compact: (c: NanocodexContext) => Promise<void>;
		/** The workspace and the history the model sees. */
		context: (c: NanocodexContext) => Promise<AgentSessionContext>;
		/** Switches the model for later turns. */
		setModel: (c: NanocodexContext, model: Model) => Promise<void>;
		/** Turns fast mode on or off for later turns. */
		setFastMode: (c: NanocodexContext, enabled: boolean) => Promise<void>;
		/** Sets the thinking level for later turns. */
		setThinking: (c: NanocodexContext, thinking: Thinking) => Promise<void>;
	};
}

/** The built-in actions for an actor with these options. */
export function createNanocodexActions(
	options: NanocodexOptions,
): NanocodexActions {
	const session = async <T>(
		c: NanocodexContext,
		call: (session: DefaultAgent["session"]) => Promise<T>,
	): Promise<T> => {
		const { agent } = await ensureAgent(c, options);
		return call(agent.session);
	};
	return {
		turn: {
			prompt: (c, request) => toClientErrors(promptTurn(c, options, request)),
			steer: (c, id, steer) =>
				toClientErrors(runningTurn(c, id).then((turn) => turn.steer(steer))),
			withdrawSteer: (c, id, withdraw) =>
				toClientErrors(
					runningTurn(c, id).then((turn) => turn.withdrawSteer(withdraw)),
				),
			cancel: (c, id) =>
				toClientErrors(runningTurn(c, id).then((turn) => turn.cancel())),
		},
		session: {
			appendDeveloperMessage: (c, text) =>
				toClientErrors(session(c, (s) => s.appendDeveloperMessage(text))),
			compact: (c) => toClientErrors(session(c, (s) => s.compact())),
			context: (c) => toClientErrors(session(c, (s) => s.context())),
			setModel: (c, model) =>
				toClientErrors(session(c, (s) => s.setModel(model))),
			setFastMode: (c, enabled) =>
				toClientErrors(session(c, (s) => s.setFastMode(enabled))),
			setThinking: (c, thinking) =>
				toClientErrors(session(c, (s) => s.setThinking(thinking))),
		},
	};
}

/** Rejects with a `UserError` carrying nanocodex's code, so clients see it. */
async function toClientErrors<T>(work: Promise<T>): Promise<T> {
	try {
		return await work;
	} catch (error) {
		if (isNanocodexError(error)) {
			throw new UserError(error.message, { code: error.code });
		}
		throw error;
	}
}
