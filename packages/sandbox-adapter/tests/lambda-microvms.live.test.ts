import { randomBytes } from "node:crypto";
import { LambdaMicrovmsClient } from "@aws-sdk/client-lambda-microvms";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type {
	Sandbox,
	SandboxActorContext,
	SandboxProvider,
} from "../src/index.js";
import { lambdaMicrovmsProvider } from "../src/lambda-microvms.js";
import {
	createTestImage,
	type TestImage,
} from "./live/lambda-microvms-image.js";

/**
 * Runs against a real MicroVM with `pnpm test:live lambda-microvms`. The
 * Region and credentials come from the environment. Without
 * `LAMBDA_MICROVMS_TEST_IMAGE`, the test builds a MicroVM image, an S3 bucket,
 * and an IAM build role first and deletes them afterwards. Set it to the ARN
 * of an image that runs Sandbox Agent on port 8080 to skip the build.
 */
const context: SandboxActorContext = {
	actorId: `live-${randomBytes(4).toString("hex")}`,
	client: () => undefined,
};

describe("lambda-microvms provider (live)", () => {
	const client = new LambdaMicrovmsClient();
	let built: TestImage | undefined;
	let provider: SandboxProvider;
	let id: string | undefined;
	let sandbox: Sandbox;

	beforeAll(async () => {
		let image = process.env.LAMBDA_MICROVMS_TEST_IMAGE;
		if (!image) {
			built = await createTestImage(client);
			image = built.imageArn;
		}
		provider = lambdaMicrovmsProvider({
			client,
			// Ends the MicroVM even if the test cannot.
			create: { imageIdentifier: image, maximumDurationInSeconds: 1_800 },
		});
		id = await provider.create(context);
		const connected = await provider.connect(context, id);
		if (!connected) throw new Error("new MicroVM did not connect");
		sandbox = connected;
	});

	afterAll(async () => {
		try {
			if (id) await provider?.destroy?.(context, id);
		} finally {
			await built?.cleanup();
		}
	});

	test("exec returns separate stdout and stderr, the exit code, cwd, and env", async () => {
		const cwd = `${sandbox.cwd}/sub`;
		await sandbox.mkdir(cwd);
		const result = await sandbox.exec(
			'echo "$GREETING $NAME"; pwd; echo oops >&2; exit 3',
			{ cwd, env: { GREETING: "hello", NAME: "it's me" } },
		);
		expect(result).toEqual({
			exitCode: 3,
			timedOut: false,
			stdout: `hello it's me\n${cwd}\n`,
			stderr: "oops\n",
		});
	});

	test("output streams before the command ends, and aborting kills its children", async () => {
		const controller = new AbortController();
		const marker = `stream-${randomBytes(4).toString("hex")}`;
		const pidFile = `${sandbox.cwd}/${marker}.pid`;
		let streamed: (chunk: string) => void = () => {};
		const firstChunk = new Promise<string>((resolve) => {
			streamed = resolve;
		});
		const pending = sandbox.exec(
			`sleep 300 & echo $! > ${pidFile}; echo ${marker}; wait`,
			{
				cwd: sandbox.cwd,
				signal: controller.signal,
				onData: (chunk) => streamed(Buffer.from(chunk).toString()),
			},
		);
		expect(await firstChunk).toContain(marker);
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
		const child = Buffer.from(await sandbox.readFile(pidFile))
			.toString()
			.trim();
		expect(child).toMatch(/^\d+$/);
		// Sandbox Agent runs as pid 1 and does not reap orphans, so a killed child
		// stays a zombie.
		const state = await sandbox.exec(
			`sleep 1; grep '^State' /proc/${child}/status || echo gone`,
			{ cwd: sandbox.cwd },
		);
		expect(state.stdout).toMatch(/zombie|gone/);
	});

	test("a timeout ends the command and reports timedOut", async () => {
		const started = Date.now();
		const result = await sandbox.exec("echo before; sleep 300", {
			cwd: sandbox.cwd,
			timeoutMs: 2_000,
		});
		expect(Date.now() - started).toBeLessThan(30_000);
		expect(result).toMatchObject({
			exitCode: null,
			timedOut: true,
			stdout: "before\n",
		});
	});

	test("file operations", async () => {
		const dir = `${sandbox.cwd}/files/it's a dir`;
		await sandbox.mkdir(dir);
		const file = `${dir}/a b.txt`;
		await sandbox.writeFile(file, "héllo\n");
		expect(Buffer.from(await sandbox.readFile(file)).toString()).toBe(
			"héllo\n",
		);
		expect(await sandbox.stat(dir)).toEqual({ isDirectory: true });
		expect(await sandbox.stat(file)).toEqual({ isDirectory: false });
		expect(await sandbox.readdir(dir)).toEqual(["a b.txt"]);
		expect(await sandbox.exists(file)).toBe(true);
		expect(await sandbox.exists(`${dir}/missing`)).toBe(false);
		const large = randomBytes(1024 * 1024).toString("base64");
		await sandbox.writeFile(`${sandbox.cwd}/large.txt`, large);
		expect(
			Buffer.from(
				await sandbox.readFile(`${sandbox.cwd}/large.txt`),
			).toString(),
		).toBe(large);
	});

	test("suspend and connect keep the MicroVM's files", async () => {
		if (!id) throw new Error("no MicroVM");
		await sandbox.writeFile(`${sandbox.cwd}/kept.txt`, "kept");
		await provider.suspend?.(context, id);
		const resumed = await provider.connect(context, id);
		if (!resumed) throw new Error("suspended MicroVM did not reconnect");
		sandbox = resumed;
		expect(
			Buffer.from(await sandbox.readFile(`${sandbox.cwd}/kept.txt`)).toString(),
		).toBe("kept");
	});

	test("destroy terminates the MicroVM", async () => {
		if (!id) throw new Error("no MicroVM");
		await provider.destroy?.(context, id);
		expect(await provider.connect(context, id)).toBeUndefined();
		id = undefined;
	}, 300_000);
});
