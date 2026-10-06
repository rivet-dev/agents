import {
	createSqliteDurabilityStore,
	type DurabilitySqliteRow,
	type DurabilitySqliteValue,
	type DurabilityStore,
	sqliteDurabilitySchema,
} from "nanocodex/durability";
import type { RawAccess } from "rivetkit/db";

/**
 * Creates nanocodex's durability tables. nanocodex writes its schema as
 * `CREATE TABLE IF NOT EXISTS` statements that each release may extend, so
 * they run on every start instead of as a numbered migration.
 */
export async function migrateNanocodexTables(db: RawAccess): Promise<void> {
	for (const statement of sqliteDurabilitySchema) await db.execute(statement);
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
