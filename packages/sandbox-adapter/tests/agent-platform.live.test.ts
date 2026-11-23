import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { agentPlatformProvider } from "../src/agent-platform.js";
import type {
	Sandbox,
	SandboxActorContext,
	SandboxProvider,
} from "../src/index.js";
import {
	createTestTemplate,
	type TestTemplate,
} from "./live/agent-platform-template.js";

/**
 * Runs against a real shell sandbox with `pnpm test:live agent-platform`.
 * Credentials come from Application Default Credentials. Set
 * `AGENT_PLATFORM_TEST_PROJECT` to a project with the Agent Platform API
 * enabled, and the test creates an Agent Engine and a shell template first and
 * deletes them afterwards. `AGENT_PLATFORM_TEST_LOCATION` defaults to
 * `us-central1`. Set `AGENT_PLATFORM_TEST_TEMPLATE` instead to reuse an
 * existing template.
 */
const context: SandboxActorContext = {
	actorId: `live-${randomBytes(4).toString("hex")}`,
	client: () => undefined,
};

describe("agent-platform provider (live)", () => {
	let built: TestTemplate | undefined;
	let provider: SandboxProvider;
	let id: string | undefined;
	let sandbox: Sandbox;

	beforeAll(async () => {
		let template = process.env.AGENT_PLATFORM_TEST_TEMPLATE;
		if (!template) {
			const project = process.env.AGENT_PLATFORM_TEST_PROJECT;
			if (!project)
				throw new Error(
					"set AGENT_PLATFORM_TEST_PROJECT to a project to create a test template in, or AGENT_PLATFORM_TEST_TEMPLATE to an existing template",
				);
			built = await createTestTemplate(
				project,
				process.env.AGENT_PLATFORM_TEST_LOCATION ?? "us-central1",
			);
			template = built.template;
		}
		provider = agentPlatformProvider({ template, create: { ttl: "1800s" } });
		id = await provider.create(context);
		const connected = await provider.connect(context, id);
		if (!connected) throw new Error("new sandbox did not connect");
		sandbox = connected;
	});

	afterAll(async () => {
		try {
			if (id) await provider?.destroy?.(context, id);
		} finally {
			await built?.cleanup();
		}
	});

	test("exec returns stdout, stderr, the exit code, cwd, and env", async () => {
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

	test("a timeout reports timedOut and no exit code", async () => {
		const started = Date.now();
		const result = await sandbox.exec("sleep 60", {
			cwd: sandbox.cwd,
			timeoutMs: 3_000,
		});
		expect(result).toMatchObject({ exitCode: null, timedOut: true });
		expect(Date.now() - started).toBeLessThan(30_000);
	});

	test("file operations, including names with quotes and spaces", async () => {
		const dir = `${sandbox.cwd}/files/it's a dir`;
		await sandbox.mkdir(dir);
		const file = `${dir}/a b.txt`;
		await sandbox.writeFile(file, "héllo\n");
		expect(Buffer.from(await sandbox.readFile(file)).toString()).toBe(
			"héllo\n",
		);
		await sandbox.writeFile(`${dir}/.hidden`, "");
		expect(await sandbox.stat(dir)).toEqual({ isDirectory: true });
		expect(await sandbox.stat(file)).toEqual({ isDirectory: false });
		expect((await sandbox.readdir(dir)).sort()).toEqual([".hidden", "a b.txt"]);
		expect(await sandbox.exists(file)).toBe(true);
		expect(await sandbox.exists(`${dir}/missing`)).toBe(false);
		await expect(sandbox.stat(`${dir}/missing`)).rejects.toThrow(
			"no such file or directory",
		);
	});

	test("large files are written in chunks", async () => {
		const content = randomBytes(150 * 1024).toString("base64");
		const file = `${sandbox.cwd}/large.txt`;
		await sandbox.writeFile(file, content);
		expect(Buffer.from(await sandbox.readFile(file)).toString()).toBe(content);
	}, 300_000);

	test("suspend and connect keep the sandbox's files", async () => {
		if (!id) throw new Error("no sandbox");
		await sandbox.writeFile(`${sandbox.cwd}/kept.txt`, "kept");
		await provider.suspend?.(context, id);
		const resumed = await provider.connect(context, id);
		if (!resumed) throw new Error("paused sandbox did not reconnect");
		sandbox = resumed;
		expect(
			Buffer.from(await sandbox.readFile(`${sandbox.cwd}/kept.txt`)).toString(),
		).toBe("kept");
	}, 600_000);

	test("destroy deletes the sandbox", async () => {
		if (!id) throw new Error("no sandbox");
		await provider.destroy?.(context, id);
		expect(await provider.connect(context, id)).toBeUndefined();
		id = undefined;
	}, 300_000);
});
