import { createHash, timingSafeEqual } from "node:crypto";
import type {
	ChatGptCredentialSeed,
	ChatGptLoginStatus,
	ChatGptSubscriptionHandle,
	ChatGptSubscriptionStore,
	SubscriptionCommitResult,
} from "nanocodex";
import { ChatGptSubscription, Transport } from "nanocodex/node";
import { type ActorDefinition, actor, UserError } from "rivetkit";
import { type DatabaseProvider, db, type RawAccess } from "rivetkit/db";
import type { NanocodexContext, NanocodexTransport } from "./runtime.js";
import {
	compareAndSwapSubscription,
	loadSubscription,
	migrateSubscriptionTable,
	parseSubscriptionRevision,
} from "./storage.js";

const DEFAULT_ISSUER = "https://auth.openai.com";

/** The token endpoint nanocodex posts refreshes and sign-in exchanges to. */
const TOKEN_PATH = "/oauth/token";

/** Options of `chatGptCredentials()`. */
export interface ChatGptCredentialsOptions {
	/** Callers pass this as the connection parameter `secret`. Keep it on servers only. */
	secret: string;
	/**
	 * Trusted first credentials, such as the tokens in a Codex `auth.json`. A
	 * stored credential that can refresh wins over the seed.
	 */
	seed?: ChatGptCredentialSeed;
	/** nanocodex's test-only issuer override, a `http://127.0.0.1:<port>` URL. */
	issuer?: string;
}

/** The credential state as it crosses the actor boundary, before revisions are parsed. */
interface StoredSubscription {
	revision: string;
	payload?: string | undefined;
}

/** A compare-and-swap outcome as it crosses the actor boundary. */
type CommitOutcome =
	| { status: "committed"; revision: string }
	| { status: "conflict"; actualRevision: string };

/** A token endpoint reply, passed back to nanocodex unchanged. */
interface TokenResponse {
	status: number;
	body: string;
}

/**
 * A handle to a `chatGptCredentials()` actor, as `c.client()` returns it.
 * Conversation actors read and write the credential state through it.
 */
export interface ChatGptCredentialsHandle {
	resolve(): Promise<string>;
	load(): Promise<StoredSubscription>;
	compareAndSwap(request: {
		expectedRevision: string;
		payload: string;
	}): Promise<CommitOutcome>;
	token(body: string): Promise<TokenResponse>;
}

interface AuthVars {
	handle?: Promise<ChatGptSubscriptionHandle> | undefined;
	/** The last token request, so callers that send the same refresh share one exchange. */
	token?: { body: string; response: Promise<TokenResponse> } | undefined;
}

interface AuthContext {
	readonly actorId: string;
	readonly db: RawAccess;
	readonly vars: AuthVars;
}

/** The actions of the `chatGptCredentials()` actor. */
type ChatGptCredentialsActions = {
	/** Starts ChatGPT device sign-in. Show the verification URL and user code to the account owner. */
	startLogin: (c: AuthContext) => Promise<ChatGptLoginStatus>;
	/** Whether the subscription is signed out, pending sign-in, or signed in. */
	status: (c: AuthContext) => Promise<ChatGptLoginStatus>;
	/** Signs out and forgets the stored credential. */
	logout: (c: AuthContext) => Promise<void>;
	/** Reads the credential state for a conversation actor's subscription handle. */
	load: (c: AuthContext) => Promise<StoredSubscription>;
	/** Replaces the credential state when it is still at `expectedRevision`. */
	compareAndSwap: (
		c: AuthContext,
		request: { expectedRevision: string; payload: string },
	) => Promise<SubscriptionCommitResult>;
	/** Sends a token request once; see `exchangeOnce`. */
	token: (c: AuthContext, body: string) => Promise<TokenResponse>;
};

/** The Rivet Actor definition `chatGptCredentials()` returns. */
export type ChatGptCredentialsDefinition = ActorDefinition<
	undefined,
	unknown,
	undefined,
	AuthVars,
	undefined,
	DatabaseProvider<RawAccess>,
	Record<never, never>,
	Record<never, never>,
	ChatGptCredentialsActions
>;

/**
 * Defines the Rivet Actor that holds one ChatGPT subscription. nanocodex signs
 * in and refreshes; this actor stores the credential state and sends every
 * token exchange once, because a refresh token rotates and a second use of
 * the old one fails. Register one actor per user or per tenant and pick it in
 * `chatGptSubscription()`, but never under the name `auth`, which RivetKit's
 * client uses.
 *
 * @throws When `secret` is empty.
 */
export function chatGptCredentials(
	options: ChatGptCredentialsOptions,
): ChatGptCredentialsDefinition {
	if (!options.secret) {
		throw new Error("chatGptCredentials() needs a secret");
	}
	const issuer = options.issuer ?? DEFAULT_ISSUER;
	const actions: ChatGptCredentialsActions = {
		startLogin: async (c) => (await ownHandle(c, options, issuer)).startLogin(),
		status: async (c) => (await ownHandle(c, options, issuer)).status(),
		logout: async (c) => (await ownHandle(c, options, issuer)).logout(),
		load: async (c) => {
			// Opening the actor's own handle applies the seed before the first read.
			await ownHandle(c, options, issuer);
			return loadSubscription(c.db);
		},
		compareAndSwap: (c, request) =>
			compareAndSwapSubscription(
				c.db,
				parseSubscriptionRevision(request.expectedRevision),
				request.payload,
			),
		token: (c, body) => exchangeOnce(c, issuer, body),
	};
	return actor({
		db: db({ onMigrate: migrateSubscriptionTable }),
		createVars: (): AuthVars => ({}),
		onBeforeConnect: (_c, params: unknown) => {
			if (!sameSecret(options.secret, connectionSecret(params))) {
				throw new UserError(
					"chatGptCredentials needs the secret connection parameter",
					{ code: "unauthorized" },
				);
			}
		},
		onSleep: (c) => closeOwnHandle(c),
		onDestroy: (c) => closeOwnHandle(c),
		actions,
	});
}

/** The actor's own subscription handle, for sign-in and status. */
function ownHandle(
	c: AuthContext,
	options: ChatGptCredentialsOptions,
	issuer: string,
): Promise<ChatGptSubscriptionHandle> {
	if (c.vars.handle !== undefined) return c.vars.handle;
	const opening: Promise<ChatGptSubscriptionHandle> = ChatGptSubscription.open({
		// Subscription ids are global to the process; conversation actors use their own.
		id: `nanocodex-credentials:${c.actorId}`,
		store: {
			load: () => loadSubscription(c.db),
			compareAndSwap: (_id, request) =>
				compareAndSwapSubscription(
					c.db,
					request.expectedRevision,
					request.payload,
				),
		},
		fetch: async (input, init) => {
			if (requestPath(input) !== TOKEN_PATH) return fetch(input, init);
			const response = await exchangeOnce(c, issuer, requestBody(init));
			return new Response(response.body, { status: response.status });
		},
		...(options.issuer === undefined ? {} : { issuer: options.issuer }),
		...(options.seed === undefined ? {} : { seed: options.seed }),
	}).catch((error: unknown) => {
		if (c.vars.handle === opening) c.vars.handle = undefined;
		throw error;
	});
	c.vars.handle = opening;
	return opening;
}

async function closeOwnHandle(c: AuthContext): Promise<void> {
	// A handle that failed to open has nothing to release.
	const handle = await c.vars.handle?.catch(() => undefined);
	c.vars.handle = undefined;
	handle?.dispose();
}

/**
 * Posts a token request, or returns the response of the same request already
 * sent. Two actors that hit an expired token at once send the same refresh
 * token; the second use would fail, so both get the first exchange's result
 * and nanocodex's compare-and-swap keeps the one stored copy. Only a
 * successful exchange is shared, so a failed one can be retried.
 */
function exchangeOnce(
	c: AuthContext,
	issuer: string,
	body: string,
): Promise<TokenResponse> {
	if (c.vars.token?.body === body) return c.vars.token.response;
	const entry = {
		body,
		response: postToken(issuer, body).then(
			(reply) => {
				if (reply.status >= 300 && c.vars.token === entry) {
					c.vars.token = undefined;
				}
				return reply;
			},
			(error: unknown) => {
				if (c.vars.token === entry) c.vars.token = undefined;
				throw error;
			},
		),
	};
	c.vars.token = entry;
	return entry.response;
}

async function postToken(issuer: string, body: string): Promise<TokenResponse> {
	const reply = await fetch(`${issuer}${TOKEN_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
		redirect: "manual",
	});
	return { status: reply.status, body: await reply.text() };
}

function connectionSecret(params: unknown): string | undefined {
	return typeof params === "object" &&
		params !== null &&
		"secret" in params &&
		typeof params.secret === "string"
		? params.secret
		: undefined;
}

function sameSecret(expected: string, actual: string | undefined): boolean {
	if (actual === undefined) return false;
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(expected), digest(actual));
}

function requestPath(input: RequestInfo | URL): string {
	return new URL(input instanceof Request ? input.url : input).pathname;
}

/** nanocodex posts token requests with a JSON string body. */
function requestBody(init: RequestInit | undefined): string {
	if (typeof init?.body !== "string") {
		throw new Error("nanocodex token requests carry a JSON string body");
	}
	return init.body;
}

/** nanocodex's ChatGPT endpoint overrides, such as `websocketUrl`. */
export type ChatGptEndpoints = Omit<
	Parameters<typeof Transport.chatGpt>[0],
	"subscription"
>;

/**
 * A `transport` for `nanocodex()` that runs on the ChatGPT subscription in a
 * `chatGptCredentials()` actor. `credentials` picks that actor for each agent,
 * such as one per user from the agent's key, and passes its `secret`.
 */
export function chatGptSubscription(
	credentials: (c: NanocodexContext) => ChatGptCredentialsHandle,
	endpoints: ChatGptEndpoints = {},
): NanocodexTransport {
	return async (c, closed) => {
		const handle = credentials(c);
		const subscription = await acquireSubscription(
			`nanocodex-subscription:${await handle.resolve()}`,
			handle,
		);
		closed.addEventListener("abort", subscription.release, { once: true });
		return Transport.chatGpt({
			subscription: subscription.handle,
			...endpoints,
		});
	};
}

/**
 * Subscription handles shared by the conversation actors in this process.
 * nanocodex allows one open handle per subscription id per process, and one
 * handle also serializes refreshes within the process.
 */
const sharedSubscriptions = new Map<
	string,
	{
		handle: Promise<ChatGptSubscriptionHandle>;
		users: Set<ChatGptCredentialsHandle>;
	}
>();

/**
 * Opens the process's handle for a credentials actor's subscription, or joins the
 * open one. Store reads, writes, and token exchanges go to the credentials actor
 * through the connection of any actor that still holds the handle.
 */
async function acquireSubscription(
	id: string,
	auth: ChatGptCredentialsHandle,
): Promise<{ handle: ChatGptSubscriptionHandle; release: () => void }> {
	const shared = sharedSubscriptions.get(id) ?? openShared(id);
	shared.users.add(auth);
	let handle: ChatGptSubscriptionHandle;
	try {
		handle = await shared.handle;
	} catch (error) {
		shared.users.delete(auth);
		throw error;
	}
	let released = false;
	return {
		handle,
		release: () => {
			if (released) return;
			released = true;
			shared.users.delete(auth);
			if (shared.users.size > 0 || sharedSubscriptions.get(id) !== shared) {
				return;
			}
			sharedSubscriptions.delete(id);
			handle.dispose();
		},
	};
}

function openShared(id: string) {
	const users = new Set<ChatGptCredentialsHandle>();
	const via = (): ChatGptCredentialsHandle => {
		const [first] = users;
		if (!first) throw new Error(`no actor holds ChatGPT subscription ${id}`);
		return first;
	};
	const store: ChatGptSubscriptionStore = {
		load: async () => {
			const stored = await via().load();
			return {
				revision: parseSubscriptionRevision(stored.revision),
				payload: stored.payload,
			};
		},
		compareAndSwap: async (_id, request) => {
			const outcome = await via().compareAndSwap({
				expectedRevision: request.expectedRevision,
				payload: request.payload,
			});
			return outcome.status === "committed"
				? {
						status: "committed",
						revision: parseSubscriptionRevision(outcome.revision),
					}
				: {
						status: "conflict",
						actualRevision: parseSubscriptionRevision(outcome.actualRevision),
					};
		},
	};
	const shared = {
		users,
		handle: ChatGptSubscription.open({
			id,
			store,
			fetch: async (input, init) => {
				if (requestPath(input) !== TOKEN_PATH) {
					throw new Error(
						"sign in through the chatGptCredentials actor's startLogin action",
					);
				}
				const response = await via().token(requestBody(init));
				return new Response(response.body, { status: response.status });
			},
		}).catch((error: unknown) => {
			if (sharedSubscriptions.get(id) === shared)
				sharedSubscriptions.delete(id);
			throw error;
		}),
	};
	sharedSubscriptions.set(id, shared);
	return shared;
}
