import type { PiCredential, PiCredentialStore } from "./models.js";

/**
 * A provider credential an application supplies. A subscription login never
 * includes its refresh token, because the application refreshes it.
 */
export type PiProviderCredential =
	| Extract<PiCredential, { type: "api_key" }>
	| {
			type: "oauth";
			access: string;
			expires: number;
			[field: string]: unknown;
	  };

/** A provider that has a credential, without the secret. */
export interface PiCredentialInfo {
	providerId: string;
	type: PiProviderCredential["type"];
}

/**
 * Provider credentials an application supplies to a Pi actor. The application
 * owns login, storage, and refresh. Errors reject the model call that needed
 * the credential, so their messages must not contain secrets.
 */
export interface PiCredentialSource {
	/** Providers that have a credential. */
	list(): Promise<PiCredentialInfo[]>;
	/** A provider's credential, possibly expired, or `undefined` when it has none. */
	read(providerId: string): Promise<PiProviderCredential | undefined>;
	/**
	 * A provider's credential after the application refreshed it. Pi calls this
	 * when a subscription token expires within five minutes, so the result must
	 * be valid for longer than that.
	 */
	refresh(providerId: string): Promise<PiProviderCredential | undefined>;
}

/** How long Pi requires an OAuth token to stay valid before it refreshes it. */
const PI_OAUTH_MIN_VALIDITY_MS = 5 * 60_000;

/**
 * Adapts an application's credential source to Pi's credential store. It
 * asks the source each time Pi needs a credential, so logins and logouts
 * apply to the next model call, and never writes. Pi's `{ signal }` is not
 * passed on, because a source is often an Actor handle, whose actions would
 * receive the signal as an argument.
 */
export class SourceCredentialStore implements PiCredentialStore {
	readonly #source: PiCredentialSource;

	constructor(source: PiCredentialSource) {
		this.#source = source;
	}

	list(): Promise<PiCredentialInfo[]> {
		return this.#source.list();
	}

	async read(providerId: string): Promise<PiCredential | undefined> {
		return toPiCredential(await this.#source.read(providerId));
	}

	/**
	 * Pi calls this to refresh a subscription token that expires soon. The
	 * source refreshes it, so `fn` sees a fresh credential and never writes.
	 */
	async modify(
		providerId: string,
		fn: (
			current: PiCredential | undefined,
		) => Promise<PiCredential | undefined>,
	): Promise<PiCredential | undefined> {
		const credential = await this.#source.refresh(providerId);
		if (
			credential?.type === "oauth" &&
			credential.expires - Date.now() <= PI_OAUTH_MIN_VALIDITY_MS
		) {
			throw new Error(
				`the credential source returned a ${providerId} token that expires within five minutes`,
			);
		}
		const current = toPiCredential(credential);
		if ((await fn(current)) !== undefined) {
			throw new Error(
				`pi actor cannot store credentials for ${providerId}; the credential source owns them`,
			);
		}
		return current;
	}

	async delete(providerId: string): Promise<void> {
		throw new Error(
			`pi actor cannot delete credentials for ${providerId}; the credential source owns them`,
		);
	}
}

/** Pi's OAuth credential type needs a refresh token field. Pi never uses it, because `modify` refreshes through the source. */
function toPiCredential(
	credential: PiProviderCredential | undefined,
): PiCredential | undefined {
	if (!credential) return undefined;
	if (credential.type === "api_key") return credential;
	return { ...credential, refresh: "" };
}
