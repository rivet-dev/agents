import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { lambdaMicrovmsProvider } from "@rivet-dev/sandbox-adapter/lambda-microvms";
import { setup } from "rivetkit";

// read, write, edit, and bash, running in the sandbox
const extensions = createRegistry();
extensions.install(CodingTools);

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	sandbox: lambdaMicrovmsProvider({
		// The ARN of a MicroVM image that runs Sandbox Agent on port 8080.
		create: {
			imageIdentifier:
				"arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox-agent",
		},
	}),
});

export const registry = setup({ use: { agent } });

registry.start();
