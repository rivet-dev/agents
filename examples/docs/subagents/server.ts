import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";
import { askSpecialist, engineering, orders } from "./specialists";

const extensions = createRegistry();
extensions.install(defineExtension({ name: "support", tools: [askSpecialist] }));

const support = pi({ model: "anthropic/claude-opus-5-5", registry: extensions });

export const registry = setup({ use: { support, orders, engineering } });

registry.start();
