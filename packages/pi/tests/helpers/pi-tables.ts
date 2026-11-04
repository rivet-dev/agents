import type { RawAccess } from "rivetkit/db";

/** Every row of Pi's tables in the actor's database, as JSON. */
export async function readPiTables(db: RawAccess): Promise<string> {
	const tables = await db.execute<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi\\_%' ESCAPE '\\'",
	);
	const rows = await Promise.all(
		tables.map(({ name }) => db.execute(`SELECT * FROM ${name}`)),
	);
	return JSON.stringify(rows);
}
