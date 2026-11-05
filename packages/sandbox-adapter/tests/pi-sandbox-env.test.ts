import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerProvider } from "../src/docker.js";
import type {
	Sandbox,
	SandboxActorContext,
	SandboxExecResult,
} from "../src/index.js";
import { sandboxEnv } from "../src/pi/index.js";

const MODIFIED_MS = Date.UTC(2020, 0, 2, 3, 4, 5);
const AWKWARD_NAME = `it's a "file" with $HOME | spaces.txt`;

const context: SandboxActorContext = {
	actorId: "pi-sandbox-env-test",
	client: () => undefined,
};

/** Commands run on this machine, so `stat` is BSD on a Mac and GNU on Linux. */
function hostSandbox(cwd: string): Sandbox {
	const unused = async () => {
		throw new Error("file info only runs commands");
	};
	return {
		cwd,
		exec: (command, options) =>
			new Promise<SandboxExecResult>((resolve) => {
				execFile(
					"/bin/sh",
					["-c", command],
					{ cwd: options.cwd, env: { PATH: process.env.PATH, ...options.env } },
					(error, stdout, stderr) => {
						const exitCode = error ? Number(error.code) : 0;
						resolve({ exitCode, timedOut: false, stdout, stderr });
					},
				);
			}),
		readFile: unused,
		writeFile: unused,
		mkdir: unused,
		stat: unused,
		readdir: unused,
		exists: unused,
	};
}

const targets = [
	{
		name: "the host",
		skip: false,
		start: async () => {
			const dir = await mkdtemp(join(tmpdir(), "pi-sandbox-env-"));
			return {
				sandbox: hostSandbox(dir),
				stop: () => rm(dir, { recursive: true, force: true }),
			};
		},
	},
	{
		name: "Alpine (BusyBox)",
		skip: spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0,
		start: async () => {
			const provider = dockerProvider({ image: "alpine:3.22" });
			const id = await provider.create(context);
			const sandbox = await provider.connect(context, id);
			if (!sandbox) throw new Error("new sandbox did not connect");
			return {
				sandbox,
				stop: async () => provider.destroy?.(context, id),
			};
		},
	},
];

for (const target of targets) {
	describe.skipIf(target.skip)(`file info in ${target.name}`, () => {
		let stop: () => Promise<unknown>;
		let root: string;
		let info: (
			name: string,
		) => ReturnType<ReturnType<typeof sandboxEnv>["fileInfo"]>;

		beforeAll(async () => {
			const started = await target.start();
			stop = started.stop;
			root = `${started.sandbox.cwd}/file-info`;
			const setup = await started.sandbox.exec(
				`mkdir -p "$ROOT/dir" && cd "$ROOT" &&
				printf hello > content.txt &&
				: > empty.txt &&
				printf hello > "$AWKWARD" &&
				mkfifo pipe &&
				ln -s missing dangling &&
				TZ=UTC touch -t 202001020304.05 content.txt empty.txt "$AWKWARD" dir`,
				{
					cwd: started.sandbox.cwd,
					env: { ROOT: root, AWKWARD: AWKWARD_NAME },
				},
			);
			expect(setup).toMatchObject({ exitCode: 0 });
			const env = sandboxEnv(async () => started.sandbox, {
				id: "test",
				root,
			});
			info = (name) => env.fileInfo(`${root}/${name}`, BACKGROUND_CONTEXT);
		});

		afterAll(() => stop?.());

		test.each([
			["a file", "content.txt", 5],
			["an empty file", "empty.txt", 0],
			["a path with spaces, quotes, and shell characters", AWKWARD_NAME, 5],
		])("%s reports its kind, size, and modified time", async (_label, name, size) => {
			expect(await info(name)).toEqual({
				ok: true,
				value: {
					name,
					path: `${root}/${name}`,
					kind: "file",
					size,
					mtimeMs: MODIFIED_MS,
				},
			});
		});

		test("a directory reports its kind and modified time", async () => {
			expect(await info("dir")).toMatchObject({
				ok: true,
				value: { kind: "directory", mtimeMs: MODIFIED_MS },
			});
		});

		test("a symlink reports the link, not a missing target", async () => {
			expect(await info("dangling")).toMatchObject({
				ok: true,
				value: { kind: "symlink", size: "missing".length },
			});
		});

		test.each([
			["a missing path", "missing.txt", "not_found"],
			["a missing path with quotes", `no "such" it's.txt`, "not_found"],
			["a path under a file", "content.txt/child", "unknown"],
			["a path that is not a file, directory, or symlink", "pipe", "invalid"],
		])("%s returns its error code", async (_label, name, code) => {
			expect(await info(name)).toMatchObject({
				ok: false,
				error: { code, path: `${root}/${name}` },
			});
		});
	});
}
