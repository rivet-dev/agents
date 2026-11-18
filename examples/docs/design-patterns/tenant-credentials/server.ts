import { createRegistry } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { type Registry, setup } from "rivetkit";
import { credentials } from "./credentials";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: createRegistry(),
	// Agent keys start with the tenant id, so every agent in a tenant reads the same credentials Actor.
	credentials: (c) => {
		const [tenantId] = c.key;
		const client = c.client<Registry<{ credentials: typeof credentials }>>();
		return client.credentials.getOrCreate([tenantId]);
	},
});

export const registry = setup({ use: { credentials, agent } });

registry.start();
