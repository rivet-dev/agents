import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineExtension,
	type Extension,
	GenerationTask,
	type HarnessSettings,
	hook,
	type RegistryReader,
	type RegistrySnapshot,
} from "@earendil-works/pi-durable";
import type { PiContext } from "./runtime.js";

/** A final answer, as `onAnswer` receives it. */
export interface PiAnswer {
	/** The conversation that answered. The root conversation, unless the app creates others. */
	conversationId: ConversationId;
	/** The answer's text, or `undefined` when it has none. */
	text: string | undefined;
	/** The model's message, with its content blocks and usage. */
	message: AssistantMessage;
}

/** Called with the actor's context for every final answer. */
export type PiOnAnswer = (
	c: PiContext,
	answer: PiAnswer,
) => void | Promise<void>;

/** The extension that runs `onAnswer`. Conversations that use the default selection get it. */
const ANSWER_EXTENSION = "rivet-pi-on-answer";

/**
 * The app's registry and settings plus an extension whose `onYield` hook calls
 * `onAnswer` with this actor's context. A registry's hooks are shared by every
 * actor, so the actor's own view of the registry is the only place that knows
 * which actor answered.
 */
export function withAnswerHook(
	options: { registry: RegistryReader; settings?: HarnessSettings },
	c: PiContext,
	onAnswer: PiOnAnswer,
	report: (error: unknown) => void,
): { registry: RegistryReader; settings?: HarnessSettings } {
	const extension = answerExtension(c, onAnswer, report);
	let cached:
		| { base: RegistrySnapshot; snapshot: RegistrySnapshot }
		| undefined;
	const registry: RegistryReader = {
		snapshot() {
			const base = options.registry.snapshot();
			if (cached?.base !== base) {
				cached = { base, snapshot: withExtension(base, extension) };
			}
			return cached.snapshot;
		},
		subscribe: (listener) => options.registry.subscribe(listener),
	};
	// Without a default selection, every installed extension is selected, this one included.
	const settings =
		options.settings &&
		new Proxy(options.settings, {
			get(target, property, receiver) {
				if (property !== "extensions") {
					return Reflect.get(target, property, receiver);
				}
				return target.extensions && [...target.extensions, extension];
			},
		});
	return { registry, settings };
}

function answerExtension(
	c: PiContext,
	onAnswer: PiOnAnswer,
	report: (error: unknown) => void,
): Extension {
	return defineExtension({
		name: ANSWER_EXTENSION,
		hooks: [
			hook(GenerationTask, {
				onYield: async (message, api, context) => {
					// A run that resumes after a crash yields the same answer again.
					const key = `${ANSWER_EXTENSION}:${message.responseId ?? message.timestamp}`;
					if (await api.memo<boolean>(key, context)) return undefined;
					try {
						await onAnswer(c, {
							conversationId: api.conversationId,
							text: answerText(message),
							message,
						});
					} catch (error) {
						// A failed delivery leaves the answer in the conversation.
						report(error);
						return undefined;
					}
					await api.memo(key, true, context);
					return undefined;
				},
			}),
		],
	});
}

function withExtension(
	base: RegistrySnapshot,
	extension: Extension,
): RegistrySnapshot {
	const installed = [...base.installed(), extension];
	return {
		installed: () => installed,
		extension: (name) =>
			name === extension.name ? extension : base.extension(name),
		tools: () => base.tools(),
		sections: () => base.sections(),
		tasks: () => base.tasks(),
		task: (name) => base.task(name),
	};
}

function answerText(message: AssistantMessage): string | undefined {
	const text = message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");
	return text === "" ? undefined : text;
}
