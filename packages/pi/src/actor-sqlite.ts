import {
	SQLITE_MIGRATIONS,
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";
import type { RawAccess } from "rivetkit/db";

/**
 * Pi Durable's tables: the ones its migrations create, and `durable_schema`,
 * which its migration runner creates. The actor's database also holds the
 * app's tables, so Pi's tables are stored with a `pi_` prefix.
 */
export const PI_DURABLE_TABLES: readonly string[] = [
	"durable_schema",
	...SQLITE_MIGRATIONS.flatMap((migration) =>
		migration.statements.flatMap((statement) => {
			const table = /^\s*CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i.exec(
				statement,
			)?.[1];
			return table === undefined ? [] : [table];
		}),
	),
];

/** Pi Durable's SQL names its tables only as table references, so whole words are table names. */
const PI_TABLE_NAMES = new RegExp(
	`\\b(${PI_DURABLE_TABLES.join("|")})\\b`,
	"g",
);

/** Pi Durable's SQL with its table names prefixed. */
function prefixTables(sql: string): string {
	return sql.replace(PI_TABLE_NAMES, "pi_$1");
}

/** Runs `body` so RivetKit records no spans for its database calls. */
export type OutsideTrace = <T>(body: () => T) => T;

/**
 * Pi Durable's `SqliteDatabase` over the actor's SQLite database.
 *
 * The actor owns the database, so `close` does nothing. Pi Durable calls it from
 * `storage.close()`, and the actor closes the database itself when it stops.
 *
 * Pi's storage stays out of the trace: one prompt makes hundreds of queries,
 * which bury the app's own `c.db` spans.
 */
export function actorSqlite(
	db: RawAccess,
	outsideTrace: OutsideTrace = (body) => body(),
): SqliteDatabase {
	return {
		...actorSqliteExecutor(db, outsideTrace),
		// `changes()` reads the connection's last write, so no other work can run between the two statements.
		runCounted: (sql, ...params) =>
			outsideTrace(() =>
				db.transaction((tx) => runCounted(tx, sql, params), {
					name: "pi-durable-counted",
				}),
			),
		transaction: (callback) =>
			outsideTrace(() =>
				db.transaction(
					(tx) => callback(actorSqliteExecutor(tx, outsideTrace)),
					{ name: "pi-durable" },
				),
			),
		close: async () => {},
	};
}

/**
 * Pi Durable's SQL against `pi_` tables. Pi Durable names the row type of each
 * query it sends. SQLite returns plain rows, so `get` and `all` take Pi's word
 * for their shape.
 */
function actorSqliteExecutor(
	db: Pick<RawAccess, "execute">,
	outsideTrace: OutsideTrace,
): SqliteExecutor {
	const execute = (sql: string, ...params: SqliteValue[]) =>
		outsideTrace(() => db.execute(prefixTables(sql), ...params));
	return {
		runCounted: (sql, ...params) =>
			outsideTrace(() => runCounted(db, sql, params)),
		exec: async (sql) => {
			await execute(sql);
		},
		run: async (sql, ...params) => {
			await execute(sql, ...params);
		},
		get: async <T extends object>(sql: string, ...params: SqliteValue[]) =>
			((await execute(sql, ...params)) as T[]).at(0),
		all: async <T extends object>(sql: string, ...params: SqliteValue[]) =>
			(await execute(sql, ...params)) as T[],
	};
}

async function runCounted(
	tx: Pick<RawAccess, "execute">,
	sql: string,
	params: SqliteValue[],
): Promise<number> {
	await tx.execute(prefixTables(sql), ...params);
	const [row] = await tx.execute<{ changes: number }>(
		"SELECT changes() AS changes",
	);
	return Number(row?.changes ?? 0);
}
