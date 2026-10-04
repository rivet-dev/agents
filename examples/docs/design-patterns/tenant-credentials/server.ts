import { pi } from "@rivet-dev/pi";
import { type Registry, setup } from "rivetkit";
import { credentials } from "../../user-subscriptions/credentials";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	// Agent keys start with the tenant id, so every agent in a tenant reads the same credentials Actor.
	credentials: (c) => {
		const [tenantId] = c.key;
		const client = c.client<Registry<{ credentials: typeof credentials }>>();
		return client.credentials.getOrCreate([tenantId]);
	},
});

export const registry = setup({ use: { credentials, agent } });

registry.start();
