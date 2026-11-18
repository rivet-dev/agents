import { type Credential, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiProviderCredential } from "@rivet-dev/pi";
import { actor } from "rivetkit";

export const credentials = actor({
	state: { saved: {} as Record<string, Credential> },
	actions: {
		save: (c, provider: string, credential: Credential) => {
			c.state.saved[provider] = credential;
		},
		list: (c) => Object.entries(c.state.saved).map(([providerId, { type }]) => ({ providerId, type })),
		read: (c, provider: string) => withoutRefreshToken(c.state.saved[provider]),
		refresh: async (c, provider: string) => {
			const store = new InMemoryCredentialStore();
			await store.modify(provider, async () => c.state.saved[provider]);
			const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null });
			await runtime.getAuth(provider, { minOAuthValidityMs: 10 * 60_000 });
			const refreshed = await store.read(provider);
			if (refreshed) c.state.saved[provider] = refreshed;
			return withoutRefreshToken(refreshed);
		},
	},
});

function withoutRefreshToken(credential: Credential | undefined): PiProviderCredential | undefined {
	if (credential?.type !== "oauth") return credential;
	const { refresh: _refresh, ...rest } = credential;
	return rest;
}
