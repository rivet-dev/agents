import { migrations } from "rivetkit/unstable/migrations";
import type { PiDatabase } from "../storage.js";

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
		{
			version: 2,
			sql: `
				CREATE TABLE pi_durable_watch (
					conn_id TEXT NOT NULL,
					watch_key TEXT NOT NULL,
					spec_json TEXT NOT NULL CHECK (json_valid(spec_json)),
					PRIMARY KEY (conn_id, watch_key)
				) STRICT, WITHOUT ROWID;
			`,
		},
	],
});

/** A watch a connection asked for. Stored so a connection that survives sleep gets its watches back on wake. */
export type StoredWatch = {
	connId: string;
	key: string;
	spec: WatchSpec;
};

export type WatchSpec =
	| { kind: "events"; conversationId: number }
	| { kind: "view"; conversationId: number }
	| { kind: "taskGraph" }
	| { kind: "doc"; docKind: string; conversationId: number };

export async function saveWatch(
	db: PiDatabase,
	watch: StoredWatch,
): Promise<void> {
	await db.execute(
		`INSERT INTO pi_durable_watch (conn_id, watch_key, spec_json) VALUES (?, ?, ?)
		 ON CONFLICT (conn_id, watch_key) DO NOTHING`,
		watch.connId,
		watch.key,
		JSON.stringify(watch.spec),
	);
}

export async function deleteWatch(
	db: PiDatabase,
	connId: string,
	key: string,
): Promise<void> {
	await db.execute(
		`DELETE FROM pi_durable_watch WHERE conn_id = ? AND watch_key = ?`,
		connId,
		key,
	);
}

export async function deleteConnectionWatches(
	db: PiDatabase,
	connId: string,
): Promise<void> {
	await db.execute(`DELETE FROM pi_durable_watch WHERE conn_id = ?`, connId);
}

export async function loadWatches(db: PiDatabase): Promise<StoredWatch[]> {
	const rows = await db.execute<{
		conn_id: string;
		watch_key: string;
		spec_json: string;
	}>(`SELECT conn_id, watch_key, spec_json FROM pi_durable_watch`);
	return rows.map((row) => ({
		connId: row.conn_id,
		key: row.watch_key,
		spec: JSON.parse(row.spec_json) as WatchSpec,
	}));
}
