import {
	createSqliteDurabilityStore,
	type DurabilitySqliteRow,
	type DurabilitySqliteValue,
	type DurabilityStore,
	sqliteDurabilitySchema,
} from "nanocodex/durability";
import type { RawAccess } from "rivetkit/db";
import { migrations } from "rivetkit/unstable/migrations";

export type NanocodexDatabase = Pick<RawAccess, "execute">;

export interface StoredSandbox {
	provider: string;
	id: string;
}

const migrateSandboxTable = migrations({
	tableName: "nanocodex_schema_version",
	migrations: [
		{
			version: 1,
			sql: `
				CREATE TABLE nanocodex_sandbox (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					provider TEXT NOT NULL,
					sandbox_id TEXT NOT NULL,
					created_at INTEGER NOT NULL
				) STRICT;
			`,
		},
	],
});

/**
 * Creates nanocodex's durability tables and the sandbox table. nanocodex
 * writes its schema as `CREATE TABLE IF NOT EXISTS` statements that each
 * release may extend, so they run on every start instead of as a numbered
 * migration.
 */
export async function migrateNanocodexTables(db: RawAccess): Promise<void> {
	for (const statement of sqliteDurabilitySchema) await db.execute(statement);
	await migrateSandboxTable(db);
}

/** nanocodex's durable journal, stored in the actor's SQLite database. */
export function durabilityStore(db: RawAccess): DurabilityStore {
	return createSqliteDurabilityStore({
		transaction: (callback) =>
			db.transaction((tx) =>
				callback(
					<Row extends DurabilitySqliteRow>(
						sql: string,
						args: readonly DurabilitySqliteValue[],
					) => tx.execute<Row>(sql, ...args),
				),
			),
	});
}

export async function loadSandbox(
	db: NanocodexDatabase,
): Promise<StoredSandbox | undefined> {
	const rows = await db.execute<{ provider: string; sandbox_id: string }>(
		"SELECT provider, sandbox_id FROM nanocodex_sandbox WHERE singleton = 1",
	);
	const row = rows[0];
	return row && { provider: row.provider, id: row.sandbox_id };
}

export async function saveSandbox(
	db: NanocodexDatabase,
	sandbox: StoredSandbox,
): Promise<void> {
	await db.execute(
		`INSERT INTO nanocodex_sandbox (singleton, provider, sandbox_id, created_at) VALUES (1, ?, ?, ?)
		 ON CONFLICT (singleton) DO UPDATE SET
			provider = excluded.provider,
			sandbox_id = excluded.sandbox_id,
			created_at = excluded.created_at`,
		sandbox.provider,
		sandbox.id,
		Date.now(),
	);
}
