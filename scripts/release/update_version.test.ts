import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ReleaseOpts } from "./main";
import { updateVersion } from "./update_version";

async function write(path: string, content: string) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}

const versionOf = async (path: string) =>
	JSON.parse(await readFile(path, "utf-8")).version;

test("a release that excludes Sandbox Agent bumps only the packages in packages/", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "release-version-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cargo = '[workspace.package]\nversion = "0.5.6"\n';
	await write(join(root, "sandbox-agent/Cargo.toml"), cargo);
	await write(
		join(root, "sandbox-agent/sdks/typescript/package.json"),
		'{\n\t"name": "sandbox-agent",\n\t"version": "0.5.6"\n}\n',
	);
	await write(
		join(root, "packages/pi/package.json"),
		'{\n\t"name": "@rivet-dev/pi",\n\t"version": "0.5.6"\n}\n',
	);

	await updateVersion({
		repoRoot: root,
		sandboxAgentRoot: join(root, "sandbox-agent"),
		version: "0.5.7-rc.3",
		latest: false,
		minorVersionChannel: "0.5.x",
		commit: "abcdef0",
		excludeSandboxAgent: true,
	} satisfies ReleaseOpts);

	assert.equal(
		await versionOf(join(root, "packages/pi/package.json")),
		"0.5.7-rc.3",
	);
	assert.equal(
		await versionOf(join(root, "sandbox-agent/sdks/typescript/package.json")),
		"0.5.6",
	);
	assert.equal(
		await readFile(join(root, "sandbox-agent/Cargo.toml"), "utf-8"),
		cargo,
	);
});
