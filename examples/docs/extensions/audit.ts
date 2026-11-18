import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";

export const audit = defineExtension({
	name: "audit",
	wraps: [
		// Wraps whichever `bash` tool the conversation ends up with.
		wrapTool(createBashTool(), (bash) => ({
			...bash,
			execute: (args, api, context) => {
				console.log(`[audit] ${api.conversationId}: ${args.command}`);
				return bash.execute(args, api, context);
			},
		})),
	],
});
