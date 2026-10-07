import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";
import { getOrder } from "./get-order";

const extensions = createRegistry();
extensions.install(defineExtension({ name: "orders", tools: [getOrder] }));

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
});

export const registry = setup({ use: { agent } });

registry.start();
