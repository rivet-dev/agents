import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";
import { approval, deploy } from "./deploy";

const extensions = createRegistry();
extensions.install(defineExtension({ name: "deploys", tools: [deploy] }));

const agent = pi({ model: "anthropic/claude-opus-5-5", registry: extensions });

export const registry = setup({ use: { agent, approval } });

registry.start();
