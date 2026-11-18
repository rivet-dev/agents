import { setTimeout as delay } from "node:timers/promises";
import { GoogleAuth } from "google-auth-library";

interface Operation {
	name: string;
	done?: boolean;
	error?: { message?: string };
	response?: { name?: string };
}

export interface TestTemplate {
	template: string;
	/** Deletes the Agent Engine, which deletes its template and sandboxes too. */
	cleanup(): Promise<void>;
}

/**
 * Creates an Agent Engine with a shell sandbox template, the way the docs
 * describe. The template takes a few minutes to create. The project must have
 * the `aiplatform.googleapis.com` API enabled.
 */
export async function createTestTemplate(
	project: string,
	location: string,
): Promise<TestTemplate> {
	const auth = new GoogleAuth({
		scopes: ["https://www.googleapis.com/auth/cloud-platform"],
	});
	const request = async (
		method: string,
		path: string,
		body?: unknown,
	): Promise<Operation> => {
		const response = await fetch(
			`https://${location}-aiplatform.googleapis.com/v1/${path}`,
			{
				method,
				headers: {
					authorization: `Bearer ${await auth.getAccessToken()}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			},
		);
		const text = await response.text();
		if (!response.ok) {
			const hint = text.includes("SERVICE_DISABLED")
				? ` Run \`gcloud services enable aiplatform.googleapis.com --project ${project}\`.`
				: "";
			throw new Error(
				`${method} ${path} failed with ${response.status}: ${text}${hint}`,
			);
		}
		return JSON.parse(text) as Operation;
	};
	const wait = async (operation: Operation): Promise<Operation> => {
		const deadline = Date.now() + 15 * 60_000;
		while (!operation.done) {
			if (Date.now() >= deadline)
				throw new Error(`${operation.name} did not finish within 15 minutes`);
			await delay(5_000);
			operation = await request("GET", operation.name);
		}
		if (operation.error)
			throw new Error(`${operation.name} failed: ${operation.error.message}`);
		return operation;
	};

	const created = await request(
		"POST",
		`projects/${project}/locations/${location}/reasoningEngines`,
		{ displayName: "sandbox-adapter-live" },
	);
	// The engine's operation is named after it.
	const engine = created.name.split("/operations/")[0];
	const cleanup = async () => {
		await wait(await request("DELETE", `${engine}?force=true`));
	};
	try {
		await wait(created);
		const operation = await wait(
			await request("POST", `${engine}/sandboxEnvironmentTemplates`, {
				displayName: "shell",
				defaultContainerEnvironment: {
					defaultContainerCategory: "DEFAULT_CONTAINER_CATEGORY_SHELL_SANDBOX",
				},
				egressControlConfig: { internetAccess: true },
			}),
		);
		const template = operation.response?.name;
		if (!template) throw new Error(`${operation.name} returned no template`);
		return { template, cleanup };
	} catch (error) {
		await cleanup().catch((cleanupError: Error) =>
			console.error(
				`could not delete Agent Engine ${engine}. Delete it by hand: ${cleanupError.message}`,
			),
		);
		throw error;
	}
}
