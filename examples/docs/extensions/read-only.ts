import { defineExtension, hook, section, ToolTask } from "@earendil-works/pi-durable";

const changesFiles = new Set(["write", "edit", "bash"]);

export const readOnly = defineExtension({
	name: "read-only",
	sections: [section("mode", () => "You are in read-only mode. Read files and explain them, but do not change anything.")],
	hooks: [
		hook(ToolTask, {
			// A blocked call never runs. The model gets the message as an error result.
			beforeTool: (call) => (changesFiles.has(call.name) ? { block: `${call.name} is turned off in read-only mode.` } : undefined),
		}),
	],
});
