import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import type { Registry } from "rivetkit";
import { createClient } from "rivetkit/client";
import { getOrder } from "./get-order";

const orderTools = createRegistry();
orderTools.install(defineExtension({ name: "orders", tools: [getOrder] }));

export const orders = pi({ model: "openai/gpt-5.4-mini", registry: orderTools });

const codingTools = createRegistry();
codingTools.install(CodingTools);

export const engineering = pi({ model: "anthropic/claude-opus-5-5", registry: codingTools, sandbox: e2bProvider() });

export const askSpecialist = defineTool({
	name: "ask_specialist",
	description:
		"Hand one focused question to a specialist and get its answer. Use orders for order status, refunds, and shipping. Use engineering for bugs that need someone to read or run the code.",
	parameters: Type.Object({
		specialist: Type.Union([Type.Literal("orders"), Type.Literal("engineering")]),
		question: Type.String({ description: "Everything the specialist needs. It can't see this conversation." }),
	}),
	// A rerun reaches the same specialist Actor, through the memo below.
	replay: "safe",
	execute: async ({ specialist, question }, api, context) => {
		// The memo is saved with this tool call, so a rerun gets the same id.
		const id = await api.memo("specialist-id", crypto.randomUUID(), context);
		const agent = client[specialist].getOrCreate([id]);
		context.abortSignal?.addEventListener("abort", () => void agent.conversation.abort(ROOT_CONVERSATION_ID));

		const result = await agent.prompt(question, { requestId: id });
		if (result.status === "unanswered") {
			return { content: [{ type: "text", text: `The specialist did not answer: ${result.reason}` }], isError: true };
		}
		const answer = result.text || "The specialist finished without an answer.";
		return { content: [{ type: "text", text: answer }], details: { specialist } };
	},
});

const client = createClient<Registry<{ orders: typeof orders; engineering: typeof engineering }>>();
