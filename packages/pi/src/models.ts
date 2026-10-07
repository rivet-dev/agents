import {
	type CreateModelRuntimeOptions,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { UserError } from "rivetkit";
import type { PiCredentialSource } from "./credentials.js";
import type { PiContext } from "./runtime.js";

/** Pi's credential store interface. `read`, `list`, `modify`, and `delete`, keyed by provider id. */
export type PiCredentialStore = NonNullable<
	CreateModelRuntimeOptions["credentials"]
>;

/** A stored Pi credential: an API key or a subscription (OAuth) login. */
export type PiCredential = NonNullable<
	Awaited<ReturnType<PiCredentialStore["read"]>>
>;

/** A custom provider, the same shape as one entry of Pi's `models.json` `providers`. */
export type PiProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];

/** Model and credential options accepted by `pi()`. */
export interface PiModelOptions {
	/** The model of every new conversation, as `provider/modelId`, such as `anthropic/claude-opus-5-5`. */
	model?: string;
	/**
	 * Models a client may choose with `conversation.configure`, as `provider/modelId`.
	 * Without it, only `model`.
	 */
	scopedModels?: string[];
	/** Custom providers registered on the actor's model runtime. */
	providers?: Record<string, PiProviderConfig>;
	/**
	 * API keys by provider id. They stay in the actor's memory and win over
	 * every other source.
	 */
	apiKeys?: Record<string, string>;
	/**
	 * Provider credentials the application manages, such as subscription
	 * logins. Called once per actor generation with the actor's context.
	 */
	credentials?: (c: PiContext) => PiCredentialSource;
}

/** The model options that decide which models a client may use. */
type AllowlistOptions = Pick<PiModelOptions, "model" | "scopedModels">;

/**
 * Creates the model runtime for one actor generation. It never reads Pi's
 * `~/.pi/agent/auth.json` or `models.json`; credentials come from `apiKeys`,
 * then `credentials`, then the server environment.
 */
export async function createActorModelRuntime(
	options: Omit<PiModelOptions, "credentials">,
	credentials: PiCredentialStore,
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
	for (const [providerId, config] of Object.entries(options.providers ?? {})) {
		runtime.registerProvider(providerId, config);
	}
	for (const [providerId, apiKey] of Object.entries(options.apiKeys ?? {})) {
		await runtime.setRuntimeApiKey(providerId, apiKey);
	}
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

/** A credential store that holds nothing and refuses writes. */
export const emptyCredentialStore: PiCredentialStore = {
	read: async () => undefined,
	list: async () => [],
	modify: async (providerId, fn) => {
		const next = await fn(undefined);
		if (next !== undefined) {
			throw new Error(
				`pi actor has no credential storage for ${providerId}; configure pi({ credentials })`,
			);
		}
		return undefined;
	},
	delete: async () => {},
};

/** The models a client may switch to: `scopedModels`, or only `model`. */
function allowedModels(options: AllowlistOptions): string[] {
	return options.scopedModels ?? (options.model ? [options.model] : []);
}

function isAllowed(
	options: AllowlistOptions,
	provider: string,
	modelId: string,
): boolean {
	return allowedModels(options).includes(`${provider}/${modelId}`);
}

/**
 * Throws unless a client may switch to `provider/modelId`. With neither
 * `model` nor `scopedModels` set, a client may not choose any model.
 */
export function assertModelAllowed(
	options: AllowlistOptions,
	provider: string,
	modelId: string,
): void {
	if (!isAllowed(options, provider, modelId)) {
		throw new UserError(
			`Model ${provider}/${modelId} is not allowed for this agent.`,
			{ code: "model_not_allowed" },
		);
	}
}
