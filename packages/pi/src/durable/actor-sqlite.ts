import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";
import type { RawAccess } from "rivetkit/db";

/**
 * Pi Durable's `SqliteDatabase` over the actor's SQLite database.
 *
 * The actor owns the database, so `close` does nothing. Pi Durable calls it from
 * `storage.close()`, and the actor closes the database itself when it stops.
 */
export function actorSqlite(db: RawAccess): SqliteDatabase {
	return {
		...actorSqliteExecutor(db),
		transaction: (callback) =>
			db.transaction((tx) => callback(actorSqliteExecutor(tx)), {
				name: "pi-durable",
			}),
		close: async () => {},
	};
}

function actorSqliteExecutor(db: Pick<RawAccess, "execute">): SqliteExecutor {
	return {
		exec: async (sql) => {
			await db.execute(sql);
		},
		run: async (sql, ...params) => {
			await db.execute(sql, ...params);
		},
		get: async <T extends object>(sql: string, ...params: SqliteValue[]) =>
			((await db.execute(sql, ...params)) as T[]).at(0),
		all: async <T extends object>(sql: string, ...params: SqliteValue[]) =>
			(await db.execute(sql, ...params)) as T[],
	};
}
