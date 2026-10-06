import type {
	SubscriptionCommitResult,
	SubscriptionRevision,
	SubscriptionStoredValue,
} from "nanocodex";
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

export const migrateSubscriptionTable = migrations({
	tableName: "nanocodex_auth_schema_version",
	migrations: [
		{
			version: 1,
			sql: `
				CREATE TABLE nanocodex_subscription (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					revision TEXT NOT NULL,
					payload TEXT NOT NULL
				) STRICT;
			`,
		},
	],
});

/**
 * Parses a ChatGPT credential revision, an unsigned 64-bit decimal string.
 *
 * @throws When `value` is not a decimal string; revisions only come from this
 * module's own rows and from nanocodex.
 */
export function parseSubscriptionRevision(value: string): SubscriptionRevision {
	if (!/^(0|[1-9][0-9]*)$/.test(value)) {
		throw new Error(`invalid ChatGPT credential revision: ${value}`);
	}
	// SAFETY: nanocodex brands revisions and exports no constructor. The check
	// above is the format nanocodex itself requires.
	return value as SubscriptionRevision;
}

/** The ChatGPT credential state, an opaque secret that nanocodex encodes. */
export async function loadSubscription(
	db: NanocodexDatabase,
): Promise<SubscriptionStoredValue> {
	const rows = await db.execute<{ revision: string; payload: string }>(
		"SELECT revision, payload FROM nanocodex_subscription WHERE singleton = 1",
	);
	const row = rows[0];
	return row
		? {
				revision: parseSubscriptionRevision(row.revision),
				payload: row.payload,
			}
		: { revision: parseSubscriptionRevision("0") };
}

/** Replaces the credential state only when it is still at `expectedRevision`. */
export function compareAndSwapSubscription(
	db: RawAccess,
	expectedRevision: SubscriptionRevision,
	payload: string,
): Promise<SubscriptionCommitResult> {
	return db.transaction(async (tx) => {
		const current = await loadSubscription(tx);
		if (current.revision !== expectedRevision) {
			return { status: "conflict", actualRevision: current.revision };
		}
		const revision = parseSubscriptionRevision(
			(BigInt(expectedRevision) + 1n).toString(),
		);
		await tx.execute(
			`INSERT INTO nanocodex_subscription (singleton, revision, payload) VALUES (1, ?, ?)
			 ON CONFLICT (singleton) DO UPDATE SET revision = excluded.revision, payload = excluded.payload`,
			revision,
			payload,
		);
		return { status: "committed", revision };
	});
}
