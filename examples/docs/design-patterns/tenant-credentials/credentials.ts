import { type Credential, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiProviderCredential } from "@rivet-dev/pi";
import { actor } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";

export const credentials = actor({
	db: db({
		onMigrate: async (db) => {
			await db.execute("CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY, credential TEXT NOT NULL)");
		},
	}),
	actions: {
		save: async (c, provider: string, credential: Credential) => {
			await saveCredential(c.db, provider, credential);
		},
		list: (c) =>
			c.db.execute<{ providerId: string; type: Credential["type"] }>(
				"SELECT provider AS providerId, json_extract(credential, '$.type') AS type FROM credentials",
			),
		read: async (c, provider: string) => withoutRefreshToken(await loadCredential(c.db, provider)),
		refresh: async (c, provider: string) => {
			const saved = await loadCredential(c.db, provider);
			const store = new InMemoryCredentialStore();
			await store.modify(provider, async () => saved);
			const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null });
			await runtime.getAuth(provider, { minOAuthValidityMs: 10 * 60_000 });
			const refreshed = await store.read(provider);
			if (refreshed) await saveCredential(c.db, provider, refreshed);
			return withoutRefreshToken(refreshed);
		},
	},
});

async function saveCredential(db: RawAccess, provider: string, credential: Credential): Promise<void> {
	await db.execute("INSERT OR REPLACE INTO credentials (provider, credential) VALUES (?, ?)", provider, JSON.stringify(credential));
}

async function loadCredential(db: RawAccess, provider: string): Promise<Credential | undefined> {
	const [row] = await db.execute<{ credential: string }>("SELECT credential FROM credentials WHERE provider = ?", provider);
	return row ? (JSON.parse(row.credential) as Credential) : undefined;
}

function withoutRefreshToken(credential: Credential | undefined): PiProviderCredential | undefined {
	if (credential?.type !== "oauth") return credential;
	const { refresh: _refresh, ...rest } = credential;
	return rest;
}
