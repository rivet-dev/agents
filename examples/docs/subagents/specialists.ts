import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import type { Registry } from "rivetkit";
import { createClient } from "rivetkit/client";
import { getOrder } from "../custom-tools/get-order";

export const orders = pi({ model: "openai/gpt-5.4-mini", customTools: [getOrder] });

export const engineering = pi({ model: "anthropic/claude-opus-5-5", sandbox: e2bProvider() });

export const askSpecialist = defineTool({
	name: "ask_specialist",
	label: "Ask a specialist",
	description:
		"Hand one focused question to a specialist and get its answer. Use orders for order status, refunds, and shipping. Use engineering for bugs that need someone to read or run the code.",
	parameters: Type.Object({
		specialist: Type.Union([Type.Literal("orders"), Type.Literal("engineering")]),
		question: Type.String({ description: "Everything the specialist needs. It can't see this conversation." }),
	}),
	async execute(_toolCallId, { specialist, question }, _signal, _onUpdate, ctx) {
		const agent = client[specialist].getOrCreate([ctx.sessionManager.getSessionId()]);
		await agent.prompt(question);
		const answer = (await agent.getLastAssistantText()) ?? "The specialist finished without an answer.";
		return { content: [{ type: "text", text: answer }], details: { specialist } };
	},
});

const client = createClient<Registry<{ orders: typeof orders; engineering: typeof engineering }>>();
