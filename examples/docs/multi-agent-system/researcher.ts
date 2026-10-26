import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";

const fetchPage = defineTool({
	name: "fetch_page",
	description: "Fetch a web page and return the start of its text.",
	parameters: Type.Object({ url: Type.String() }),
	// A fetch changes nothing, so running it again after a crash is harmless.
	replay: "safe",
	execute: async ({ url }, _api, context) => {
		const response = await fetch(url, { signal: context.abortSignal });
		if (!response.ok) throw new Error(`${url} returned ${response.status}.`);
		const text = (await response.text()).slice(0, 20_000);
		return { content: [{ type: "text", text }] };
	},
});

const extensions = createRegistry();
extensions.install(
	defineExtension({
		name: "research",
		tools: [fetchPage],
		sections: [
			section(
				"role",
				() => "You research one question. Answer it in a few short paragraphs and list the URLs you used.",
			),
		],
	}),
);

// One researcher per subtask, with a fresh conversation.
export const researcher = pi({ model: "openai/gpt-5.4-mini", registry: extensions });
