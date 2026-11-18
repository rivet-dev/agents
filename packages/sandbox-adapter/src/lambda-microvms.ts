import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	CreateMicrovmAuthTokenCommand,
	GetMicrovmCommand,
	type GetMicrovmResponse,
	LambdaMicrovmsClient,
	ResumeMicrovmCommand,
	RunMicrovmCommand,
	type RunMicrovmRequest,
	SuspendMicrovmCommand,
	TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import type { SandboxActorContext, SandboxProvider } from "./index.js";
import { SandboxAgentHttp } from "./sandbox-agent-http.js";

/** The MicroVM endpoint sends requests to this port unless a request names another. */
const DEFAULT_PORT = 8080;
/** A MicroVM lives at most 8 hours, counting the time it spends suspended. */
const MAX_DURATION_SECONDS = 28_800;
/** The longest an auth token can live. */
const TOKEN_MINUTES = 60;
/** A cached token is replaced once less than this much of its life remains. */
const TOKEN_REFRESH_MS = 5 * 60_000;

/** Options for `RunMicrovm`. `imageIdentifier`, the image's ARN, is required. */
export type LambdaMicrovmsCreateOptions = RunMicrovmRequest & {
	imageIdentifier: string;
};

export interface LambdaMicrovmsProviderOptions {
	/** Defaults to `new LambdaMicrovmsClient()`, which reads the Region and credentials from the environment. */
	client?: LambdaMicrovmsClient;
	/**
	 * Options for `RunMicrovm`, or a function that returns them for the owning
	 * Actor. The image must start `sandbox-agent server` on `port`.
	 */
	create:
		| LambdaMicrovmsCreateOptions
		| ((
				c: SandboxActorContext,
		  ) => LambdaMicrovmsCreateOptions | Promise<LambdaMicrovmsCreateOptions>);
	/** Port Sandbox Agent listens on inside the MicroVM. Defaults to `8080`. */
	port?: number;
	/** Working directory inside the MicroVM, created when the Actor connects. Defaults to `/workspace`. */
	cwd?: string;
	/** How long `connect` waits for Sandbox Agent to answer after a start or resume. Defaults to 2 minutes. */
	readyTimeoutMs?: number;
}

/**
 * Runs an agent's file and shell tools in an AWS Lambda MicroVM. Commands and
 * file operations go to Sandbox Agent inside the MicroVM through its HTTPS
 * endpoint. The MicroVM is suspended while the actor sleeps and terminated
 * when the actor is destroyed.
 */
export function lambdaMicrovmsProvider(
	options: LambdaMicrovmsProviderOptions,
): SandboxProvider {
	const cwd = posix.normalize(options.cwd ?? "/workspace");
	if (!posix.isAbsolute(cwd))
		throw new Error(
			`lambda-microvms cwd must be an absolute path, received ${cwd}`,
		);
	const port = options.port ?? DEFAULT_PORT;
	const readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
	let client = options.client;
	const lambda = () => {
		client ??= new LambdaMicrovmsClient();
		return client;
	};
	return {
		name: "lambda-microvms",
		cwd,
		create: async (c) => {
			const create =
				typeof options.create === "function"
					? await options.create(c)
					: options.create;
			const connector = await networkConnector(lambda());
			const vm = await lambda().send(
				new RunMicrovmCommand({
					ingressNetworkConnectors: [connector("HTTP_INGRESS")],
					maximumDurationInSeconds: MAX_DURATION_SECONDS,
					// Wakes a MicroVM that suspended itself while a tool was idle.
					idlePolicy: {
						autoResumeEnabled: true,
						maxIdleDurationSeconds: 900,
						suspendedDurationSeconds: MAX_DURATION_SECONDS,
					},
					...create,
				}),
			);
			if (!vm.microvmId)
				throw new Error("lambda-microvms RunMicrovm returned no MicroVM id");
			return vm.microvmId;
		},
		connect: async (_c, id) => {
			const vm = await startMicrovm(lambda(), id, readyTimeoutMs);
			if (!vm) return undefined;
			if (!vm.endpoint)
				throw new Error(`lambda-microvms MicroVM ${id} reported no endpoint`);
			const api = new SandboxAgentHttp(
				endpointUrl(vm.endpoint),
				authHeaders(lambda(), id, port),
			);
			// A MicroVM that is terminated while it starts never answers.
			const ready = await api.waitUntilReady(
				readyTimeoutMs,
				`lambda-microvms MicroVM ${id}`,
				async () => !isGone(await describe(lambda(), id)),
			);
			if (!ready) return undefined;
			const sandbox = api.sandbox(cwd);
			await sandbox.mkdir(cwd);
			return sandbox;
		},
		suspend: async (_c, id) => {
			try {
				await lambda().send(
					new SuspendMicrovmCommand({ microvmIdentifier: id }),
				);
			} catch (error) {
				// A conflict means the MicroVM is already suspended or stopping.
				if (!isMissing(error) && !isConflict(error)) throw error;
			}
		},
		destroy: async (_c, id) => {
			try {
				await lambda().send(
					new TerminateMicrovmCommand({ microvmIdentifier: id }),
				);
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
		},
	};
}

/**
 * Resumes a suspended MicroVM and returns its description, or undefined when
 * it no longer exists. Its state is eventually consistent, so the caller
 * checks readiness through the endpoint instead.
 */
async function startMicrovm(
	client: LambdaMicrovmsClient,
	id: string,
	timeoutMs: number,
): Promise<GetMicrovmResponse | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const vm = await describe(client, id);
		if (!vm || isGone(vm)) return undefined;
		if (vm.state === "SUSPENDED") {
			try {
				await client.send(new ResumeMicrovmCommand({ microvmIdentifier: id }));
			} catch (error) {
				if (isMissing(error)) return undefined;
				// Another caller resumed it first.
				if (!isConflict(error)) throw error;
			}
			return vm;
		}
		if (vm.state !== "SUSPENDING") return vm;
		// A MicroVM can only resume once it has finished suspending.
		if (Date.now() >= deadline)
			throw new Error(
				`lambda-microvms MicroVM ${id} was still suspending after ${timeoutMs} ms`,
			);
		await delay(1_000);
	}
}

/** Describes a MicroVM, or returns undefined when it no longer exists. */
async function describe(
	client: LambdaMicrovmsClient,
	id: string,
): Promise<GetMicrovmResponse | undefined> {
	try {
		return await client.send(new GetMicrovmCommand({ microvmIdentifier: id }));
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

function isGone(vm: GetMicrovmResponse | undefined): boolean {
	return !vm || vm.state === "TERMINATING" || vm.state === "TERMINATED";
}

/** The API returns a bare hostname. */
function endpointUrl(endpoint: string): string {
	return endpoint.includes("://") ? endpoint : `https://${endpoint}`;
}

/** Every request to the endpoint needs an auth token, which is cached until it nears expiry. */
function authHeaders(client: LambdaMicrovmsClient, id: string, port: number) {
	let token: { value: string; expiresAt: number } | undefined;
	let pending: Promise<string> | undefined;
	const refresh = async () => {
		const expiresAt = Date.now() + TOKEN_MINUTES * 60_000;
		const result = await client.send(
			new CreateMicrovmAuthTokenCommand({
				microvmIdentifier: id,
				expirationInMinutes: TOKEN_MINUTES,
				allowedPorts: [{ port }],
			}),
		);
		const value = result.authToken?.["X-aws-proxy-auth"];
		if (!value)
			throw new Error(`lambda-microvms returned no auth token for ${id}`);
		token = { value, expiresAt };
		return value;
	};
	return async (): Promise<Record<string, string>> => {
		let value = token?.value;
		if (!value || !token || token.expiresAt - Date.now() < TOKEN_REFRESH_MS) {
			// Concurrent requests share one refresh.
			pending ??= refresh().finally(() => {
				pending = undefined;
			});
			value = await pending;
		}
		return { "X-aws-proxy-auth": value, "X-aws-proxy-port": String(port) };
	};
}

/** Builds the ARN of an AWS-managed network connector in the client's Region. */
async function networkConnector(client: LambdaMicrovmsClient) {
	const region = await client.config.region();
	return (name: string) =>
		`arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:${name}`;
}

// Errors are matched by name, so a client from another copy of the SDK works too.
function isMissing(error: unknown): boolean {
	return (error as Error | undefined)?.name === "ResourceNotFoundException";
}

function isConflict(error: unknown): boolean {
	return (error as Error | undefined)?.name === "ConflictException";
}
