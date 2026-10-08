import type { ConversationId } from "@earendil-works/pi-durable";
import type { RawAccess } from "rivetkit/db";
import { migrations } from "rivetkit/unstable/migrations";
import { PI_DURABLE_TABLES } from "./actor-sqlite.js";

export type PiDatabase = Pick<RawAccess, "execute">;

/**
 * `pi()`'s own tables. Pi Durable creates its tables in the same database
 * itself, with the `pi_` prefix `actorSqlite` adds. The `pi_durable` names are
 * stored in actors' databases, so they stay.
 */
export const migratePiTables = migrations({
	tableName: "pi_durable_schema_version",
	migrations: [
		{
			version: 1,
			// Actors of the earlier session-based pi() already have this table, with the same columns.
			sql: `
				CREATE TABLE IF NOT EXISTS pi_sandbox (
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
		{
			version: 3,
			// Files of agents without a sandbox. Agents from 0.5.1 created this table on first use.
			sql: `
				CREATE TABLE IF NOT EXISTS pi_file (
					path TEXT PRIMARY KEY,
					content BLOB NOT NULL,
					mtime_ms INTEGER NOT NULL
				) STRICT;
			`,
		},
		{
			version: 4,
			// Pi Durable's tables of agents from 0.5.1 and earlier have no prefix. Renaming them keeps their data.
			up: async (db) => {
				for (const table of PI_DURABLE_TABLES) {
					const [found] = await db.execute(
						"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
						table,
					);
					if (found)
						await db.execute(`ALTER TABLE ${table} RENAME TO pi_${table}`);
				}
			},
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
	| { kind: "events"; conversationId: ConversationId }
	| { kind: "view"; conversationId: ConversationId }
	| { kind: "taskGraph" }
	| { kind: "doc"; docKind: string; conversationId: ConversationId };

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
		// Only `saveWatch` writes this column, from a `WatchSpec`.
		spec: JSON.parse(row.spec_json) as WatchSpec,
	}));
}

/** The sandbox an actor created, stored so the actor reconnects to it on wake. */
export interface StoredSandbox {
	provider: string;
	id: string;
}

export async function loadPiSandbox(
	db: PiDatabase,
): Promise<StoredSandbox | undefined> {
	const rows = await db.execute<{ provider: string; sandbox_id: string }>(
		`SELECT provider, sandbox_id FROM pi_sandbox WHERE singleton = 1`,
	);
	const row = rows[0];
	return row && { provider: row.provider, id: row.sandbox_id };
}

export async function savePiSandbox(
	db: PiDatabase,
	sandbox: StoredSandbox,
): Promise<void> {
	await db.execute(
		`INSERT INTO pi_sandbox (singleton, provider, sandbox_id, created_at) VALUES (1, ?, ?, ?)
		 ON CONFLICT (singleton) DO UPDATE SET
			provider = excluded.provider,
			sandbox_id = excluded.sandbox_id,
			created_at = excluded.created_at`,
		sandbox.provider,
		sandbox.id,
		Date.now(),
	);
}
