import { access } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "execa";
import type { ReleaseOpts } from "./main";
import { releaseTag, releaseTitle, rootPackage } from "./target";

function releaseCommitMessage(opts: ReleaseOpts): string {
	const pkg = rootPackage(opts.target);
	return pkg
		? `chore(release): update ${pkg.name} to ${opts.version}`
		: `chore(release): update version to ${opts.version}`;
}

export async function configureVcs(repoRoot: string): Promise<boolean> {
	try {
		await access(join(repoRoot, ".jj"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return false;
	}

	// If .jj exists, failures here indicate a broken jj workspace. Falling back to
	// Git could release a different revision, especially in non-colocated repos.
	await $({ cwd: repoRoot })`jj git root`;
	return true;
}

export async function getCurrentRevision(repoRoot: string): Promise<string> {
	if (await configureVcs(repoRoot)) {
		const { stdout: empty } = await $({
			cwd: repoRoot,
		})`jj log -r @ --no-graph -T empty`;
		const revision = empty.trim() === "true" ? "@-" : "@";
		const { stdout } = await $({
			cwd: repoRoot,
		})`jj log -r ${revision} --no-graph -T commit_id`;
		return stdout.trim();
	}
	const { stdout } = await $({ cwd: repoRoot })`git rev-parse HEAD`;
	return stdout.trim();
}

export async function getCurrentBookmark(repoRoot: string): Promise<string> {
	if (await configureVcs(repoRoot)) {
		const bookmarkedAncestor = "latest(ancestors(@) & bookmarks())";
		const { stdout } = await $({
			cwd: repoRoot,
		})`jj log -r ${bookmarkedAncestor} --no-graph -T ${'local_bookmarks.map(|bookmark| bookmark.name()).join("\\n") ++ "\\n"'}`;
		const bookmarks = stdout
			.split("\n")
			.map((bookmark) => bookmark.trim())
			.filter(Boolean);
		if (bookmarks.length === 0)
			throw new Error(
				"The release revision is not associated with a jj bookmark",
			);
		if (bookmarks.length > 1)
			throw new Error(
				`The release revision has multiple jj bookmarks (${bookmarks.join(", ")}); specify a single release bookmark by deleting or moving the others`,
			);
		return bookmarks[0];
	}
	const { stdout } = await $({
		cwd: repoRoot,
	})`git rev-parse --abbrev-ref HEAD`;
	return stdout.trim();
}

export async function commitAndPush(opts: ReleaseOpts, push: boolean) {
	if (await configureVcs(opts.repoRoot)) {
		const { stdout: summary } = await $({
			cwd: opts.repoRoot,
		})`jj diff --summary -r @`;
		if (summary.trim()) {
			await $({
				stdio: "inherit",
				cwd: opts.repoRoot,
			})`jj commit -m ${releaseCommitMessage(opts)}`;
		}
		if (push) {
			const bookmark = await getCurrentBookmark(opts.repoRoot);
			const revision = await getCurrentRevision(opts.repoRoot);
			const { stdout: gitDir } = await $({ cwd: opts.repoRoot })`jj git root`;
			const gitOptions = {
				cwd: opts.repoRoot,
				env: { GIT_DIR: gitDir.trim() },
			};
			const remoteRef = `refs/remotes/origin/${bookmark}`;
			const remote = await $({
				...gitOptions,
				reject: false,
			})`git rev-parse -q --verify ${remoteRef}`;
			if (remote.exitCode === 0) {
				// jj pushes use lease semantics. Releases must also be fast-forward,
				// even when a freshly initialized workspace has not tracked origin.
				await $(
					gitOptions,
				)`git merge-base --is-ancestor ${remoteRef} ${revision}`;
				await $({
					stdio: "inherit",
					cwd: opts.repoRoot,
				})`jj bookmark track ${bookmark} --remote origin`;
			}
			await $({
				stdio: "inherit",
				cwd: opts.repoRoot,
			})`jj bookmark set ${bookmark} -r ${revision}`;
			await $({
				stdio: "inherit",
				cwd: opts.repoRoot,
			})`jj git push --remote origin --bookmark ${bookmark}`;
		}
		return;
	}
	if (!push) {
		await $({ stdio: "inherit", cwd: opts.repoRoot })`git add .`;
		const { stdout: staged } = await $({
			cwd: opts.repoRoot,
		})`git status --porcelain`;
		if (staged.trim())
			await $({
				stdio: "inherit",
				cwd: opts.repoRoot,
			})`git commit -m ${releaseCommitMessage(opts)}`;
	} else {
		const bookmark = await getCurrentBookmark(opts.repoRoot);
		if (bookmark === "main") {
			await $({ stdio: "inherit", cwd: opts.repoRoot })`git push`;
		} else {
			await $({
				stdio: "inherit",
				cwd: opts.repoRoot,
			})`gt submit --no-edit --publish`;
		}
	}
}

export async function validateGit(opts: ReleaseOpts) {
	// Validate there's no uncommitted changes
	const result = (await configureVcs(opts.repoRoot))
		? await $({ cwd: opts.repoRoot })`jj diff --summary -r @`
		: await $({ cwd: opts.repoRoot })`git status --porcelain`;
	const status = result.stdout;
	if (status.trim().length > 0) {
		throw new Error(
			"There are uncommitted changes. Please commit or stash them.",
		);
	}
}

export async function createAndPushTag(opts: ReleaseOpts) {
	const tag = releaseTag(opts.target, opts.version);
	console.log(`Creating tag ${tag}...`);
	try {
		const gitDir = (await configureVcs(opts.repoRoot))
			? (await $({ cwd: opts.repoRoot })`jj git root`).stdout.trim()
			: undefined;
		const gitOptions = { cwd: opts.repoRoot, env: { GIT_DIR: gitDir } };
		const existing = await $({
			...gitOptions,
			reject: false,
		})`git rev-parse -q --verify ${`refs/tags/${tag}^{commit}`}`;
		const target = await $(
			gitOptions,
		)`git rev-parse ${`${opts.commit}^{commit}`}`;
		if (
			existing.exitCode === 0 &&
			existing.stdout.trim() !== target.stdout.trim()
		) {
			throw new Error(`${tag} already exists at a different commit`);
		}
		if (existing.exitCode !== 0)
			await $(gitOptions)`git tag ${tag} ${opts.commit}`;
		await $({
			...gitOptions,
			stdio: "inherit",
		})`git push origin refs/tags/${tag}`;

		console.log(`✅ Tag ${tag} created and pushed`);
	} catch (err) {
		console.error("❌ Failed to create or push tag");
		throw err;
	}
}

export async function createGitHubRelease(opts: ReleaseOpts) {
	console.log("Creating GitHub release...");

	try {
		const tagName = releaseTag(opts.target, opts.version);
		const title = releaseTitle(opts.target, opts.version);

		console.log(`Looking for existing release ${title}`);

		// Check if a release with this version name already exists
		const { stdout: releaseJson } = await $({
			cwd: opts.repoRoot,
		})`gh release list --json name,tagName`;
		const releases = JSON.parse(releaseJson);
		const existingRelease = releases.find((r: any) => r.name === title);

		if (existingRelease) {
			console.log(`Updating release ${title} to point to new tag ${tagName}`);
			await $({
				stdio: "inherit",
				cwd: opts.repoRoot,
			})`gh release edit ${existingRelease.tagName} --tag ${tagName}`;
		} else {
			console.log(`Creating new release ${title} pointing to tag ${tagName}`);
			// GitHub's "Latest" badge stays on Sandbox Agent's releases.
			const latest = rootPackage(opts.target) ? ["--latest=false"] : [];
			await $({
				stdio: "inherit",
				cwd: opts.repoRoot,
			})`gh release create ${tagName} --title ${title} --generate-notes ${latest}`;

			// Check if this is a pre-release (contains -rc. or similar)
			if (opts.version.includes("-")) {
				await $({
					stdio: "inherit",
					cwd: opts.repoRoot,
				})`gh release edit ${tagName} --prerelease`;
			}
		}

		console.log("✅ GitHub release created/updated");
	} catch (err) {
		console.error("❌ Failed to create GitHub release");
		console.warn("! You may need to create the release manually");
		throw err;
	}
}
