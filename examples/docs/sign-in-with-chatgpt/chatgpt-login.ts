import { type Credential, createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { actor, type Registry, UserError } from "rivetkit";
import type { credentials } from "./credentials";

// A UUID you generate once for this deployment. OpenAI calls it the agent host ID.
const HOST_ID = process.env.CHATGPT_HOST_ID ?? "";
// Your app's name. Users see it on the ChatGPT consent screen.
const APP_NAME = "Acme";

interface PendingSignIn {
	cancel: () => void;
	pasteRedirect: (url: string) => void;
	credential: Promise<Credential>;
}

// One per user. Runs one sign-in at a time and saves the result to the user's credentials Actor.
export const chatgptLogin = actor({
	createVars: () => ({ pending: undefined as PendingSignIn | undefined }),
	actions: {
		// Starts a sign-in and returns the URL to open in the user's browser.
		start: async (c) => {
			c.vars.pending?.cancel();

			const models = createModels({ credentials: new InMemoryCredentialStore() });
			models.setProvider(openaiProvider());

			const cancel = new AbortController();
			const authUrl = Promise.withResolvers<string>();
			const redirect = Promise.withResolvers<string>();
			const credential = models.login(
				"openai",
				"oauth",
				{
					// Give up after ten minutes, or when the user starts over.
					signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(10 * 60_000)]),
					notify: (event) => {
						if (event.type === "auth_url") authUrl.resolve(event.url);
					},
					// pi-ai asks for the redirect URL the browser landed on. Rejecting on abort
					// lets pi-ai close its callback server, so the next sign-in can start.
					prompt: ({ signal }) =>
						new Promise<string>((resolve, reject) => {
							signal?.addEventListener("abort", () => reject(new Error("Sign-in cancelled.")), { once: true });
							redirect.promise.then(resolve);
						}),
				},
				{ getDeviceId: () => HOST_ID, agentName: APP_NAME },
			);

			c.vars.pending = { cancel: () => cancel.abort(), pasteRedirect: redirect.resolve, credential };
			// Stay awake until the sign-in finishes, fails, or times out.
			c.keepAwake(credential.catch(() => undefined));

			// Rejects here if the sign-in fails before it has a URL.
			return Promise.race([authUrl.promise, credential.then(() => authUrl.promise)]);
		},

		// Finishes the sign-in with the redirect URL the user pasted. Without one, it waits
		// for the browser to reach the callback on its own, which works only when the worker
		// runs on the same machine as the browser.
		finish: async (c, redirectUrl?: string) => {
			const pending = c.vars.pending;
			if (!pending) throw new UserError("Start a sign-in first.");
			if (redirectUrl) pending.pasteRedirect(redirectUrl);

			try {
				const credential = await pending.credential;
				const client = c.client<Registry<{ credentials: typeof credentials }>>();
				await client.credentials.getOrCreate([c.key[0]]).save("openai", credential);
			} catch (error) {
				throw new UserError(error instanceof Error ? error.message : "ChatGPT sign-in failed.");
			} finally {
				c.vars.pending = undefined;
			}
		},
	},
});
