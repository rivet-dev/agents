import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";
import { audit } from "./audit";
import { readOnly } from "./read-only";

const extensions = createRegistry();
extensions.install(CodingTools);
extensions.install(audit);
extensions.install(readOnly);

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	sandbox: e2bProvider(),
	// New conversations start without read-only. A client turns it on per conversation.
	settings: { extensions: [CodingTools, audit] },
});

export const registry = setup({ use: { agent } });

registry.start();
