import { num, obj, str } from "@earendil-works/pi-schema";
import { pi } from "@rivet-dev/pi";
import { actor, setup } from "rivetkit";
import { db } from "rivetkit/db";

// Another actor the agent's tool calls.
const payments = actor({
	db: db({
		onMigrate: async (db) => {
			await db.execute("CREATE TABLE IF NOT EXISTS refunds (order_id TEXT NOT NULL, amount REAL NOT NULL)");
		},
	}),
	actions: {
		refund: async (c, orderId: string, amount: number) => {
			await c.db.execute("INSERT INTO refunds (order_id, amount) VALUES (?, ?)", orderId, amount);
		},
	},
});

// The agent's own table, in its database next to Pi Durable's.
const FREEZES = "CREATE TABLE IF NOT EXISTS refund_freezes (frozen_at INTEGER NOT NULL)";

// One agent per customer, keyed by their email.
const support = pi({
	model: "anthropic/claude-opus-5-5",
	tools: {
		refund: {
			description: "Refund an order, in dollars.",
			parameters: obj({ orderId: str(), amount: num() }),
			// `c` is the agent's context: its key, database, vars, and other actors.
			execute: async (c, args) => {
				const [email] = c.key;
				await c.client<typeof registry>().payments.getOrCreate([email]).refund(args.orderId, args.amount);
				return { output: [{ type: "text", text: `Refunded $${args.amount} for ${args.orderId}.` }] };
			},
		},
	},
	hooks: {
		// Hooks get the agent's context first too.
		beforeTool: async (c, call) => {
			if (call.name !== "refund") return undefined;
			await c.db.execute(FREEZES);
			const freezes = await c.db.execute("SELECT 1 FROM refund_freezes LIMIT 1");
			return freezes.length > 0 ? { block: "Refunds are frozen for this customer." } : undefined;
		},
	},
	actions: {
		freezeRefunds: async (c) => {
			await c.db.execute(FREEZES);
			await c.db.execute("INSERT INTO refund_freezes (frozen_at) VALUES (?)", Date.now());
		},
	},
});

export const registry = setup({ use: { support, payments } });

registry.start();
