import { pi } from "@rivet-dev/pi";
import { freestyleProvider } from "@rivet-dev/sandbox-adapter/freestyle";
import { setup } from "rivetkit";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	// The sandbox brings read, write, edit, and bash, which run in it.
	sandbox: freestyleProvider({
		create: {
			snapshotId: "freestyle/ubuntu-sm",
			// A VM has no network access until a rule allows it. This allows DNS and HTTPS out.
			firewall: {
				rules: [
					{ action: "allow", source: {}, destination: { public: true, port: 53, protocol: "udp" } },
					{ action: "allow", source: {}, destination: { public: true, port: 443, protocol: "tcp" } },
				],
			},
		},
	}),
});

export const registry = setup({ use: { agent } });

registry.start();
