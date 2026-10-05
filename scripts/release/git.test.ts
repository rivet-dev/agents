import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { $ } from "execa";
import {
	commitAndPush,
	configureVcs,
	createAndPushTag,
	getCurrentBookmark,
	getCurrentRevision,
	validateGit,
} from "./git";
import type { ReleaseOpts } from "./main";
import type { ReleaseTarget } from "./target";

async function temporaryDirectory(t: test.TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "release-git-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

function opts(
	repoRoot: string,
	version = "1.2.3",
	commit = "HEAD",
	target: ReleaseTarget = "sandbox-agent",
) {
	return { repoRoot, version, commit, target } as ReleaseOpts;
}

async function initGit(directory: string) {
	await $({ cwd: directory })`git init -b main`;
	await $({ cwd: directory })`git config user.name Release Test`;
	await $({ cwd: directory })`git config user.email release@example.com`;
	await writeFile(join(directory, "file.txt"), "initial\n");
	await $({ cwd: directory })`git add .`;
	await $({ cwd: directory })`git commit -m initial`;
}

test("Git is selected only when .jj is missing and dirty state is validated", async (t) => {
	const directory = await temporaryDirectory(t);
	await initGit(directory);
	assert.equal(await configureVcs(directory), false);
	await writeFile(join(directory, "file.txt"), "dirty\n");
	await assert.rejects(validateGit(opts(directory)), /uncommitted changes/);

	await $({ cwd: directory })`git checkout -- file.txt`;
	await $({ cwd: directory })`mkdir .jj`;
	await assert.rejects(configureVcs(directory));
});

test("non-colocated jj uses its revision, validates dirt, and requires one local bookmark", async (t) => {
	const directory = await temporaryDirectory(t);
	await $`jj git init --no-colocate ${directory}`;
	await writeFile(join(directory, "file.txt"), "initial\n");
	await assert.rejects(validateGit(opts(directory)), /uncommitted changes/);
	await $({ cwd: directory })`jj commit -m initial`;
	await $({ cwd: directory })`jj bookmark create main -r @-`;

	const { stdout: expected } = await $({
		cwd: directory,
	})`jj log -r @- --no-graph -T commit_id`;
	assert.equal(await getCurrentRevision(directory), expected.trim());
	assert.equal(await getCurrentBookmark(directory), "main");

	await $({ cwd: directory })`jj bookmark create release -r @-`;
	await assert.rejects(
		getCurrentBookmark(directory),
		/multiple jj bookmarks \(main, release\)/,
	);
});

test("jj commit/push can resume without an extra commit", async (t) => {
	const directory = await temporaryDirectory(t);
	const remote = join(await temporaryDirectory(t), "remote.git");
	await $`git init --bare ${remote}`;
	await $`jj git init --no-colocate ${directory}`;
	await $({ cwd: directory })`jj git remote add origin ${remote}`;
	await writeFile(join(directory, "file.txt"), "release\n");
	await $({ cwd: directory })`jj bookmark create main -r @`;

	await commitAndPush(opts(directory), false);
	const first = await getCurrentRevision(directory);
	await commitAndPush(opts(directory), false);
	assert.equal(await getCurrentRevision(directory), first);
	await commitAndPush(opts(directory), true);
	const { stdout } = await $`git --git-dir=${remote} rev-parse refs/heads/main`;
	assert.equal(stdout.trim(), first);

	await $({ cwd: directory })`jj bookmark untrack main@origin`;
	await writeFile(join(directory, "file.txt"), "next release\n");
	await commitAndPush(opts(directory), false);
	await commitAndPush(opts(directory), true);
	const second = await getCurrentRevision(directory);
	assert.equal(
		(await $`git --git-dir=${remote} rev-parse refs/heads/main`).stdout.trim(),
		second,
	);

	// A release cannot rewind the remote even though jj itself supports leases.
	await $({ cwd: directory })`jj new ${first}`;
	await $({ cwd: directory })`jj bookmark set main -r @ --allow-backwards`;
	await assert.rejects(commitAndPush(opts(directory), true));
	assert.equal(
		(await $`git --git-dir=${remote} rev-parse refs/heads/main`).stdout.trim(),
		second,
	);
});

test("an existing annotated tag is compared by peeled commit and never rewritten", async (t) => {
	const directory = await temporaryDirectory(t);
	const remote = join(await temporaryDirectory(t), "remote.git");
	await $`git init --bare ${remote}`;
	await initGit(directory);
	await $({ cwd: directory })`git remote add origin ${remote}`;
	await $({ cwd: directory })`git tag -a v1.2.3 -m release HEAD`;
	const { stdout: tagObject } = await $({
		cwd: directory,
	})`git rev-parse refs/tags/v1.2.3`;

	await createAndPushTag(opts(directory));
	assert.equal(
		(await $({ cwd: directory })`git rev-parse refs/tags/v1.2.3`).stdout.trim(),
		tagObject.trim(),
	);
	await writeFile(join(directory, "file.txt"), "next\n");
	await $({ cwd: directory })`git add .`;
	await $({ cwd: directory })`git commit -m next`;
	await assert.rejects(createAndPushTag(opts(directory)), /different commit/);
	assert.equal(
		(await $({ cwd: directory })`git rev-parse refs/tags/v1.2.3`).stdout.trim(),
		tagObject.trim(),
	);
});
