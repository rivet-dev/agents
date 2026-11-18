import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
	createExpectAssertions,
	createStorageConformance,
	type StorageConformanceProvider,
} from "@earendil-works/pi-durable/testing";
import { actor, setup } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { setupTest } from "rivetkit/test";
import { describe, expect, test } from "vitest";
import { actorSqlite } from "../src/actor-sqlite.js";

function storageConformance(withStorage: StorageConformanceProvider) {
	return createStorageConformance({
		assertions: createExpectAssertions(expect),
		withStorage,
	});
}

function withActorStorage(database: RawAccess): StorageConformanceProvider {
	return async (use) => {
		const storage = await SqliteStorage.open(actorSqlite(database));
		try {
			await use(storage);
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
	};
}

// Each conformance case runs inside an action, against the actor's own SQLite
// database. A case returns its failure as text so the test shows the cause.
const conformance = actor({
	db: db(),
	actions: {
		runCase: async (c, name: string): Promise<string | null> => {
			const testCase = storageConformance(withActorStorage(c.db)).find(
				(candidate) => candidate.name === name,
			);
			if (!testCase) return `unknown conformance case: ${name}`;
			try {
				await testCase.run();
				return null;
			} catch (error) {
				return error instanceof Error
					? (error.stack ?? error.message)
					: String(error);
			}
		},
		// Two counted writes at once, each from the database and from a transaction.
		overlappingCountedWrites: async (c) => {
			const database = actorSqlite(c.db);
			await database.exec("CREATE TABLE counted (value INTEGER) STRICT");
			await database.exec(
				"INSERT INTO counted (value) VALUES (1), (2), (3), (4), (5)",
			);
			return Promise.all([
				database.runCounted("UPDATE counted SET value = value + 10"),
				database.runCounted("DELETE FROM counted WHERE value = 12"),
				database.transaction((tx) =>
					tx.runCounted("UPDATE counted SET value = 0 WHERE value > 13"),
				),
			]);
		},
		// A read that arrives during a transaction waits for it, so it never sees writes that roll back.
		readDuringTransaction: async (c) => {
			const database = actorSqlite(c.db);
			await database.exec("CREATE TABLE pending (value INTEGER) STRICT");
			const written = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const transaction = database.transaction(async (tx) => {
				await tx.run("INSERT INTO pending (value) VALUES (1)");
				written.resolve();
				await release.promise;
				throw new Error("roll back");
			});
			await written.promise;
			const read = database.all<{ count: number }>(
				"SELECT count(*) AS count FROM pending",
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			release.resolve();
			await transaction.catch(() => {});
			return (await read)[0]?.count;
		},
	},
});

const registry = setup({ use: { conformance } });

const caseNames = storageConformance(async () => {
	throw new Error("only case names are read here");
}).map((testCase) => testCase.name);

describe("pi durable storage over actor sqlite", () => {
	test.for(caseNames)("%s", async (name, c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.conformance.getOrCreate([name, randomUUID()]);
		expect(await handle.runCase(name)).toBeNull();
	});

	test("overlapping counted writes each get their own count of changed rows", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.conformance.getOrCreate(["counted", randomUUID()]);
		// Updates 5 rows to 11 through 15, deletes 12, then updates 14 and 15.
		expect(await handle.overlappingCountedWrites()).toEqual([5, 1, 2]);
	});

	test("a read during a transaction waits for it and never sees writes that roll back", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.conformance.getOrCreate(["isolated", randomUUID()]);
		expect(await handle.readDuringTransaction()).toBe(0);
	});
});
