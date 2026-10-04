import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "execa";
import type { ReleaseOpts } from "./main";
import {
	copyReleasesPath,
	deleteReleasesPath,
	fetchGitRef,
	listReleasesObjects,
	PREFIX,
	uploadContentToReleases,
	versionOrCommitToRef,
} from "./utils";

export async function promoteArtifacts(opts: ReleaseOpts) {
	// Determine which commit to use for source artifacts
	let sourceCommit = opts.commit;
	if (opts.reuseEngineVersion) {
		console.log(`==> Reusing artifacts from ${opts.reuseEngineVersion}`);
		const ref = versionOrCommitToRef(opts.reuseEngineVersion);
		await fetchGitRef(ref);
		const result = await $`git rev-parse ${ref}`;
		sourceCommit = result.stdout.trim().slice(0, 7);
		console.log(`==> Source commit: ${sourceCommit}`);
	}

	// Promote TypeScript SDK artifacts (uploaded by build-artifacts.ts to sandbox-agent/{commit}/typescript/)
	await promotePath(opts, sourceCommit, "typescript");

	// Promote binary artifacts (uploaded by CI in release.yaml to sandbox-agent/{commit}/binaries/)
	await promotePath(opts, sourceCommit, "binaries");

	// Upload install scripts
	await uploadInstallScripts(opts, opts.version);
	if (opts.latest) {
		await uploadInstallScripts(opts, "latest");
		await uploadInstallScripts(opts, opts.minorVersionChannel);
	}

	// Upload gigacode install scripts
	await uploadGigacodeInstallScripts(opts, opts.version);
	if (opts.latest) {
		await uploadGigacodeInstallScripts(opts, "latest");
	}
}

async function uploadInstallScripts(opts: ReleaseOpts, version: string) {
	const installScriptPaths = [
		path.resolve(opts.repoRoot, "scripts/release/static/install.sh"),
		path.resolve(opts.repoRoot, "scripts/release/static/install.ps1"),
	];

	for (const scriptPath of installScriptPaths) {
		let scriptContent = await fs.readFile(scriptPath, "utf-8");
		scriptContent = scriptContent.replace(/__VERSION__/g, version);

		const uploadKey = `${PREFIX}/${version}/${scriptPath.split("/").pop() ?? ""}`;

		console.log(`Uploading install script: ${uploadKey}`);
		await uploadContentToReleases(scriptContent, uploadKey);
	}
}

async function uploadGigacodeInstallScripts(
	opts: ReleaseOpts,
	version: string,
) {
	const installScriptPaths = [
		path.resolve(opts.repoRoot, "scripts/release/static/gigacode-install.sh"),
		path.resolve(opts.repoRoot, "scripts/release/static/gigacode-install.ps1"),
	];

	for (const scriptPath of installScriptPaths) {
		let scriptContent = await fs.readFile(scriptPath, "utf-8");
		scriptContent = scriptContent.replace(/__VERSION__/g, version);

		const uploadKey = `${PREFIX}/${version}/${scriptPath.split("/").pop() ?? ""}`;

		console.log(`Uploading gigacode install script: ${uploadKey}`);
		await uploadContentToReleases(scriptContent, uploadKey);
	}
}

async function copyPath(sourcePrefix: string, targetPrefix: string) {
	console.log(`Copying ${sourcePrefix} -> ${targetPrefix}`);
	await deleteReleasesPath(targetPrefix);
	await copyReleasesPath(sourcePrefix, targetPrefix);
}

/** S3-to-S3 copy from sandbox-agent/{commit}/{name}/ to sandbox-agent/{version}/{name}/ */
async function promotePath(
	opts: ReleaseOpts,
	sourceCommit: string,
	name: string,
) {
	console.log(`==> Promoting ${name} artifacts`);

	const sourcePrefix = `${PREFIX}/${sourceCommit}/${name}/`;
	const commitFiles = await listReleasesObjects(sourcePrefix);
	if (
		!Array.isArray(commitFiles?.Contents) ||
		commitFiles.Contents.length === 0
	) {
		throw new Error(`No files found under ${sourcePrefix}`);
	}

	await copyPath(sourcePrefix, `${PREFIX}/${opts.version}/${name}/`);
	if (opts.latest) {
		await copyPath(sourcePrefix, `${PREFIX}/latest/${name}/`);
		if (name === "binaries") {
			const binariesSourcePrefix = `${PREFIX}/${sourceCommit}/binaries/sandbox-agent-`;
			const sandboxAgentBinaries =
				await listReleasesObjects(binariesSourcePrefix);
			if (
				!Array.isArray(sandboxAgentBinaries?.Contents) ||
				sandboxAgentBinaries.Contents.length === 0
			) {
				throw new Error(
					`No sandbox-agent binaries found under ${binariesSourcePrefix}`,
				);
			}

			await copyPath(
				binariesSourcePrefix,
				`${PREFIX}/${opts.minorVersionChannel}/binaries/sandbox-agent-`,
			);
			return;
		}

		await copyPath(
			sourcePrefix,
			`${PREFIX}/${opts.minorVersionChannel}/${name}/`,
		);
	}
}
