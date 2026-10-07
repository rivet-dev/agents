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
});
