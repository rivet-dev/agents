import { createRegistry } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { type Registry, setup } from "rivetkit";
import { chatgptLogin } from "./chatgpt-login";
import { credentials } from "./credentials";

const agent = pi({
	model: "openai/gpt-6-sol",
	registry: createRegistry(),
	// The agent's key starts with the user id, so it runs on that user's ChatGPT plan.
	credentials: (c) => {
		const client = c.client<Registry<{ credentials: typeof credentials }>>();
		return client.credentials.getOrCreate([c.key[0]]);
	},
});

export const registry = setup({ use: { credentials, chatgptLogin, agent } });

registry.start();
