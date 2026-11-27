import { actor, type Registry } from "rivetkit";
import { createClient } from "rivetkit/client";
import { db } from "rivetkit/db";

type Report = { title: string; body: string };

export const report = actor({
	db: db({
		onMigrate: async (db) => {
			await db.execute(
				"CREATE TABLE IF NOT EXISTS report (id INTEGER PRIMARY KEY CHECK (id = 1), title TEXT NOT NULL, body TEXT NOT NULL)",
			);
		},
	}),
	onCreate: async (c, input: Report) => {
		await c.db.execute("INSERT INTO report (id, title, body) VALUES (1, ?, ?)", input.title, input.body);
	},
	actions: {
		read: async (c) => {
			const [saved] = await c.db.execute<Report>("SELECT title, body FROM report WHERE id = 1");
			return saved;
		},
	},
});

export const admin = createClient<Registry<{ report: typeof report }>>();
