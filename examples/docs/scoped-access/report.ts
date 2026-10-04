import { actor, type Registry } from "rivetkit";
import { createClient } from "rivetkit/client";

type Report = { title: string; body: string };

export const report = actor({
	createState: (_c, input: Report): Report => input,
	actions: {
		read: (c) => c.state,
	},
});

export const admin = createClient<Registry<{ report: typeof report }>>();
