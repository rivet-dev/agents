import { migrations } from "rivetkit/unstable/migrations";

/**
 * `piDurable()`'s own tables. Pi Durable creates its tables in the same
 * database itself. The sandbox id lives in `pi_sandbox`, the same table and
 * helpers as `pi()`.
 */
export const migratePiDurableTables = migrations({
	tableName: "pi_durable_schema_version",
	migrations: [
		{
			version: 1,
			sql: `
				CREATE TABLE pi_sandbox (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					provider TEXT NOT NULL,
					sandbox_id TEXT NOT NULL,
					created_at INTEGER NOT NULL
				) STRICT;
			`,
		},
	],
});
