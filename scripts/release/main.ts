#!/usr/bin/env tsx

import * as path from "node:path";
import * as url from "node:url";
import { program } from "commander";
import { $ } from "execa";
import * as semver from "semver";
import { buildJsArtifacts } from "./build-artifacts";
import { tagDocker } from "./docker";
import {
	commitAndPush,
	configureVcs,
	createAndPushTag,
	createGitHubRelease,
	getCurrentBookmark,
	getCurrentRevision,
	validateGit,
} from "./git";
import { promoteArtifacts } from "./promote-artifacts";
import {
	publishCrates,
	publishNpmCli,
	publishNpmLibraries,
	publishRootPackage,
} from "./sdk";
import {
	parseReleaseTarget,
	RELEASE_TARGETS,
	type ReleaseTarget,
	releaseTag,
	rootPackage,
	tagPrefix,
} from "./target";
import { updateVersion } from "./update_version";
import {
	assert,
	assertEquals,
	fetchGitRef,
	versionOrCommitToRef,
} from "./utils";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// The release script lives at the repository root and releases one target per
// run: Sandbox Agent, or one root package. Sandbox Agent keeps its own
// workspace (Cargo, pnpm, Docker) under `sandbox-agent/`.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SANDBOX_AGENT_ROOT = path.join(REPO_ROOT, "sandbox-agent");

export interface ReleaseOpts {
	/** Repository root. Git operations and root workspace packages resolve here. */
	repoRoot: string;
	/** Sandbox Agent workspace root: Cargo, `sdks/`, Docker, and its docs. */
	sandboxAgentRoot: string;
	/** What this run releases. */
	target: ReleaseTarget;
	version: string;
	latest: boolean;
	minorVersionChannel: string;
	/** Commit to publish release for. */
	commit: string;
	/** Optional version to reuse artifacts and Docker images from instead of building. */
	reuseEngineVersion?: string;
}

/** Released versions of `target`, newest first, read from its git tags. */
async function getAllGitVersions(target: ReleaseTarget): Promise<string[]> {
	try {
		// Fetch tags to ensure we have the latest
		// Use --force to overwrite local tags that conflict with remote
		try {
			await $`git fetch --tags --force --quiet`;
		} catch (_fetchError) {
			console.warn(
				"Warning: Could not fetch remote tags, using local tags only",
			);
		}

		// Get all version tags of this target
		const prefix = tagPrefix(target);
		const result = await $`git tag -l ${`${prefix}*`}`;
		const tags = result.stdout.trim().split("\n").filter(Boolean);

		if (tags.length === 0) {
			return [];
		}

		// Parse and sort all versions (newest first)
		const versions = tags
			.map((tag) => tag.slice(prefix.length))
			.filter((v) => semver.valid(v))
			.sort((a, b) => semver.rcompare(a, b));

		return versions;
	} catch (error) {
		console.warn("Warning: Could not get git tags:", error);
		return [];
	}
}

async function getLatestGitVersion(
	target: ReleaseTarget,
): Promise<string | null> {
	const versions = await getAllGitVersions(target);

	if (versions.length === 0) {
		return null;
	}

	// Find the latest version (excluding prereleases)
	const stableVersions = versions.filter((v) => {
		const parsed = semver.parse(v);
		return parsed && parsed.prerelease.length === 0;
	});

	return stableVersions[0] || null;
}

async function shouldTagAsLatest(
	newVersion: string,
	target: ReleaseTarget,
): Promise<boolean> {
	// Check if version has prerelease identifier
	const parsedVersion = semver.parse(newVersion);
	if (!parsedVersion) {
		throw new Error(`Invalid semantic version: ${newVersion}`);
	}

	// If it has a prerelease identifier, it's not latest
	if (parsedVersion.prerelease.length > 0) {
		return false;
	}

	// Get the latest version from git tags
	const latestGitVersion = await getLatestGitVersion(target);

	// If no previous versions exist, this is the latest
	if (!latestGitVersion) {
		return true;
	}

	// Check if new version is greater than the latest git version
	return semver.gt(newVersion, latestGitVersion);
}

async function validateReuseVersion(version: string): Promise<void> {
	console.log(`Validating that ${version} exists...`);

	const ref = versionOrCommitToRef(version);
	await fetchGitRef(ref);

	// Get short commit from ref
	let shortCommit: string;
	try {
		const result = await $`git rev-parse ${ref}`;
		const fullCommit = result.stdout.trim();
		shortCommit = fullCommit.slice(0, 7);
		console.log(`✅ Found ${ref} (commit ${shortCommit})`);
	} catch (_error) {
		throw new Error(
			`${version} does not exist in git. Make sure ${ref} exists in the repository.`,
		);
	}

	// Check Docker images exist (optional - warn if not found)
	console.log(`Checking Docker images for ${shortCommit}...`);
	try {
		await $({
			stdio: "inherit",
		})`docker manifest inspect rivetdev/sandbox-agent:${shortCommit}-amd64`;
		await $({
			stdio: "inherit",
		})`docker manifest inspect rivetdev/sandbox-agent:${shortCommit}-arm64`;
		console.log("✅ Docker images exist");
	} catch (_error) {
		console.log(
			`⚠️ Docker images for ${shortCommit} not found - skipping Docker validation`,
		);
		console.log("  (Docker images will need to be built before publishing)");
	}

	// Check S3 artifacts exist
	console.log(`Checking S3 artifacts for ${shortCommit}...`);
	const endpointUrl =
		"https://2a94c6a0ced8d35ea63cddc86c2681e7.r2.cloudflarestorage.com";

	// Get credentials
	let awsAccessKeyId = process.env.R2_RELEASES_ACCESS_KEY_ID;
	if (!awsAccessKeyId) {
		const result =
			await $`op read "op://Engineering/rivet-releases R2 Upload/username"`;
		awsAccessKeyId = result.stdout.trim();
	}
	let awsSecretAccessKey = process.env.R2_RELEASES_SECRET_ACCESS_KEY;
	if (!awsSecretAccessKey) {
		const result =
			await $`op read "op://Engineering/rivet-releases R2 Upload/password"`;
		awsSecretAccessKey = result.stdout.trim();
	}

	const awsEnv = {
		AWS_ACCESS_KEY_ID: awsAccessKeyId,
		AWS_SECRET_ACCESS_KEY: awsSecretAccessKey,
		AWS_DEFAULT_REGION: "auto",
	};

	const commitPrefix = `sandbox-agent/${shortCommit}/`;
	const listResult = await $({
		env: awsEnv,
		shell: true,
		stdio: ["pipe", "pipe", "inherit"],
	})`aws s3api list-objects --bucket rivet-releases --prefix ${commitPrefix} --endpoint-url ${endpointUrl}`;
	const files = JSON.parse(listResult.stdout);

	if (!Array.isArray(files?.Contents) || files.Contents.length === 0) {
		throw new Error(
			`No S3 artifacts found for version ${version} (commit ${shortCommit}) under ${commitPrefix}`,
		);
	}

	console.log(`✅ S3 artifacts exist (${files.Contents.length} files found)`);
}

/**
 * Build and type-check the root workspace packages (for example @rivet-dev/pi).
 * They import each other's build output, so the build runs first.
 */
async function checkRootPackages(opts: ReleaseOpts) {
	console.log("Running root workspace build and type check...");
	try {
		await $({ stdio: "inherit", cwd: opts.repoRoot })`pnpm build`;
		await $({ stdio: "inherit", cwd: opts.repoRoot })`pnpm check-types`;
		console.log("✅ Root workspace type check passed");
	} catch (err) {
		console.error("❌ Root workspace type check failed");
		throw err;
	}
}

async function runLocalChecks(opts: ReleaseOpts) {
	console.log("Running local checks...");

	if (rootPackage(opts.target)) {
		await checkRootPackages(opts);
		console.log("✅ All local checks passed");
		return;
	}

	// Cargo check
	console.log("Running cargo check...");
	try {
		await $({ stdio: "inherit", cwd: opts.sandboxAgentRoot })`cargo check`;
		console.log("✅ Cargo check passed");
	} catch (err) {
		console.error("❌ Cargo check failed");
		throw err;
	}

	// Cargo fmt check
	console.log("Running cargo fmt --check...");
	try {
		await $({
			stdio: "inherit",
			cwd: opts.sandboxAgentRoot,
		})`cargo fmt --check`;
		console.log("✅ Cargo fmt check passed");
	} catch (err) {
		console.error("❌ Cargo fmt check failed");
		throw err;
	}

	// TypeScript type check
	console.log("Running TypeScript type check...");
	try {
		await $({ stdio: "inherit", cwd: opts.sandboxAgentRoot })`pnpm typecheck`;
		console.log("✅ TypeScript type check passed");
	} catch (err) {
		console.error("❌ TypeScript type check failed");
		throw err;
	}

	console.log("✅ All local checks passed");
}

async function runCiChecks(opts: ReleaseOpts) {
	console.log("Running CI checks...");

	if (rootPackage(opts.target)) {
		await checkRootPackages(opts);
		console.log("✅ All CI checks passed");
		return;
	}

	// TypeScript type check
	console.log("Running TypeScript type check...");
	try {
		await $({ stdio: "inherit", cwd: opts.sandboxAgentRoot })`pnpm typecheck`;
		console.log("✅ TypeScript type check passed");
	} catch (err) {
		console.error("❌ TypeScript type check failed");
		throw err;
	}

	console.log("✅ All CI checks passed");
}

async function getVersionFromArgs(
	target: ReleaseTarget,
	opts: {
		version?: string;
		major?: boolean;
		minor?: boolean;
		patch?: boolean;
	},
): Promise<string> {
	// Check if explicit version is provided via --version flag
	if (opts.version) {
		return opts.version;
	}

	// Check for version bump flags
	if (!opts.major && !opts.minor && !opts.patch) {
		throw new Error(
			"Must provide either --version, --major, --minor, or --patch",
		);
	}

	// Get latest version from git tags and calculate new one
	const latestVersion = await getLatestGitVersion(target);
	if (!latestVersion) {
		throw new Error(
			"No existing version tags found. Use --version to set an explicit version.",
		);
	}
	console.log(`Latest git version: ${latestVersion}`);

	let newVersion: string | null = null;

	if (opts.major) {
		newVersion = semver.inc(latestVersion, "major");
	} else if (opts.minor) {
		newVersion = semver.inc(latestVersion, "minor");
	} else if (opts.patch) {
		newVersion = semver.inc(latestVersion, "patch");
	}

	if (!newVersion) {
		throw new Error("Failed to calculate new version");
	}

	return newVersion;
}

// Available steps
const STEPS = [
	"confirm-release",
	"update-version",
	"run-local-checks",
	"git-commit",
	"git-push",
	"trigger-workflow",
	"validate-reuse-version",
	"run-ci-checks",
	"build-js-artifacts",
	"publish-crates",
	"publish-npm-libraries",
	"publish-npm-cli",
	"publish-npm-package",
	"tag-docker",
	"promote-artifacts",
	"push-tag",
	"create-github-release",
] as const;

const PHASES = ["setup-local", "setup-ci", "complete-ci"] as const;

type Step = (typeof STEPS)[number];
type Phase = (typeof PHASES)[number];

// Map Sandbox Agent's phases to individual steps
const SANDBOX_AGENT_PHASES: Record<Phase, Step[]> = {
	// These steps modify the source code, so they need to be ran & committed
	// locally. CI cannot push commits.
	//
	// run-local-checks runs cargo check, cargo fmt, and type checks to fail
	// fast before committing/pushing.
	"setup-local": [
		"confirm-release",
		"update-version",
		"run-local-checks",
		"git-commit",
		"git-push",
		"trigger-workflow",
	],
	// These steps validate the repository and build JS artifacts before
	// triggering release.
	"setup-ci": ["validate-reuse-version", "run-ci-checks", "build-js-artifacts"],
	// These steps run after the required artifacts have been successfully built.
	// Note: update-version is included here to ensure Cargo.toml versions are
	// updated before publishing when using --reuse-engine-version.
	"complete-ci": [
		"update-version",
		"publish-crates",
		"publish-npm-libraries",
		"publish-npm-cli",
		"tag-docker",
		"promote-artifacts",
		"push-tag",
		"create-github-release",
	],
};

// A root package builds and publishes only itself, so it has no artifacts,
// crates, or Docker images.
const ROOT_PACKAGE_PHASES: Record<Phase, Step[]> = {
	"setup-local": [
		"confirm-release",
		"update-version",
		"run-local-checks",
		"git-commit",
		"git-push",
		"trigger-workflow",
	],
	"setup-ci": ["run-ci-checks"],
	"complete-ci": ["publish-npm-package", "push-tag", "create-github-release"],
};

async function main() {
	if (await configureVcs(REPO_ROOT)) {
		const { stdout } = await $({ cwd: REPO_ROOT })`jj git root`;
		// Git metadata and gh must use this workspace's backing repository,
		// while revision and bookmark selection use jj explicitly.
		process.env.GIT_DIR = stdout.trim();
	}
	// Setup commander
	program
		.name("release")
		.description("Release Sandbox Agent or one root package")
		.argument("<target>", `What to release: ${RELEASE_TARGETS.join(", ")}`)
		.option("--major", "Bump major version")
		.option("--minor", "Bump minor version")
		.option("--patch", "Bump patch version")
		.option("--version <version>", "Set specific version")
		.option(
			"--override-commit <commit>",
			"Override the commit to pull artifacts from (defaults to current commit)",
		)
		.option(
			"--reuse-engine-version <version-or-commit>",
			"Reuse artifacts and Docker images from a previous version (e.g., 0.1.0) or git revision (e.g., bb7f292)",
		)
		.option("--latest", "Tag version as the latest version", true)
		.option("--no-latest", "Do not tag version as the latest version")
		.option("--no-validate-git", "Skip git validation (for testing)")
		.option(
			"--only-steps <steps>",
			`Run specific steps (comma-separated). Available: ${STEPS.join(", ")}`,
		)
		.option(
			"--phase <phase>",
			`Run a release phase (comma-separated). Available: ${PHASES.join(", ")}`,
		)
		.parse();

	const opts = program.opts();
	const target = parseReleaseTarget(program.args[0]);
	const phaseMap = rootPackage(target)
		? ROOT_PACKAGE_PHASES
		: SANDBOX_AGENT_PHASES;
	const targetSteps = new Set(Object.values(phaseMap).flat());

	// Parse requested steps
	if (!opts.phase && !opts.onlySteps) {
		opts.phase = "setup-local";
	}

	if (opts.phase && opts.onlySteps) {
		throw new Error("Cannot use both --phase and --only-steps together");
	}

	const requestedSteps = new Set<Step>();
	if (opts.onlySteps) {
		const steps = opts.onlySteps.split(",").map((s: string) => s.trim());
		for (const step of steps) {
			if (!STEPS.includes(step as Step)) {
				throw new Error(
					`Invalid step: ${step}. Available steps: ${STEPS.join(", ")}`,
				);
			}
			if (!targetSteps.has(step as Step)) {
				throw new Error(`Step ${step} does not apply to ${target}`);
			}
			requestedSteps.add(step as Step);
		}
	} else if (opts.phase) {
		const phases = opts.phase.split(",").map((s: string) => s.trim());
		for (const phase of phases) {
			if (!PHASES.includes(phase as Phase)) {
				throw new Error(
					`Invalid phase: ${phase}. Available phases: ${PHASES.join(", ")}`,
				);
			}
			const steps = phaseMap[phase as Phase];
			for (const step of steps) {
				requestedSteps.add(step);
			}
		}
	}

	// Helper function to check if a step should run
	const shouldRunStep = (step: Step): boolean => {
		return requestedSteps.has(step);
	};

	// Get version from arguments or calculate based on flags
	const version = await getVersionFromArgs(target, {
		version: opts.version,
		major: opts.major,
		minor: opts.minor,
		patch: opts.patch,
	});

	assert(
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/.test(
			version,
		),
		"version must be a valid semantic version",
	);

	// Automatically determine if this should be tagged as latest
	// Can be overridden by --latest or --no-latest flags
	let isLatest: boolean;
	if (opts.latest !== undefined) {
		// User explicitly set the flag
		isLatest = opts.latest;
	} else {
		// Auto-determine based on version
		isLatest = await shouldTagAsLatest(version, target);
		console.log(
			`Auto-determined latest flag: ${isLatest} (version: ${version})`,
		);
	}

	const parsedVersion = semver.parse(version);
	assert(parsedVersion !== null, "version must be parseable");
	const minorVersionChannel = `${parsedVersion.major}.${parsedVersion.minor}.x`;

	// Setup opts
	let commit: string;
	if (opts.overrideCommit) {
		// Manually override commit
		commit = opts.overrideCommit;
	} else {
		// Read commit
		commit = await getCurrentRevision(REPO_ROOT);
	}

	const releaseOpts: ReleaseOpts = {
		repoRoot: REPO_ROOT,
		sandboxAgentRoot: SANDBOX_AGENT_ROOT,
		target,
		version: version,
		latest: isLatest,
		minorVersionChannel,
		commit,
		reuseEngineVersion: opts.reuseEngineVersion,
	};

	if (releaseOpts.commit.length === 40) {
		releaseOpts.commit = releaseOpts.commit.slice(0, 7);
	}

	assertEquals(releaseOpts.commit.length, 7, "must use 7 char short commit");

	if (opts.validateGit && !shouldRunStep("run-ci-checks")) {
		// HACK: Skip setup-ci because for some reason there's changes in the setup step but only in GitHub Actions
		await validateGit(releaseOpts);
	}

	if (shouldRunStep("confirm-release")) {
		console.log("==> Release Confirmation");
		console.log(`\nRelease Details:`);
		console.log(`  Target: ${releaseOpts.target}`);
		const pkg = rootPackage(releaseOpts.target);
		console.log(
			`  Publishes: ${pkg ? `${pkg.name}@${releaseOpts.version}` : `Sandbox Agent ${releaseOpts.version} (crates, binaries, Docker images, npm packages)`}`,
		);
		console.log(
			`  Tag: ${releaseTag(releaseOpts.target, releaseOpts.version)}`,
		);
		console.log(`  Version: ${releaseOpts.version}`);
		console.log(`  Latest: ${releaseOpts.latest}`);
		console.log(`  Minor channel: ${releaseOpts.minorVersionChannel}`);
		console.log(`  Commit: ${releaseOpts.commit}`);
		if (releaseOpts.reuseEngineVersion) {
			console.log(
				`  Reusing engine version: ${releaseOpts.reuseEngineVersion}`,
			);
		}

		// Get current branch
		const branch = await getCurrentBookmark(REPO_ROOT);
		console.log(`  Branch: ${branch}`);

		// Get and display recent versions
		const allVersions = await getAllGitVersions(releaseOpts.target);

		if (allVersions.length > 0) {
			// Find the latest stable version (excluding prereleases)
			const stableVersions = allVersions.filter((v) => {
				const parsed = semver.parse(v);
				return parsed && parsed.prerelease.length === 0;
			});
			const latestStableVersion = stableVersions[0] || null;

			console.log(`\nRecent versions:`);
			const recentVersions = allVersions.slice(0, 10);
			for (const version of recentVersions) {
				const isLatest = version === latestStableVersion;
				const marker = isLatest ? " (latest)" : "";
				console.log(`  - ${version}${marker}`);
			}
		}

		// Prompt for confirmation
		const readline = await import("node:readline");
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		const answer = await new Promise<string>((resolve) => {
			rl.question("\nProceed with release? (yes/no): ", resolve);
		});
		rl.close();

		if (answer.toLowerCase() !== "yes" && answer.toLowerCase() !== "y") {
			console.log("Release cancelled");
			process.exit(0);
		}

		console.log("✅ Release confirmed");
	}

	if (shouldRunStep("update-version")) {
		console.log("==> Updating Version");
		await updateVersion(releaseOpts);
	}

	if (shouldRunStep("run-local-checks")) {
		console.log("==> Running Local Checks");
		await runLocalChecks(releaseOpts);
	}

	if (shouldRunStep("git-commit")) {
		assert(opts.validateGit, "cannot commit without git validation");
		console.log("==> Committing Changes");
		await commitAndPush(releaseOpts, false);
	}

	if (shouldRunStep("git-push")) {
		assert(opts.validateGit, "cannot push without git validation");
		console.log("==> Pushing Commits");
		await commitAndPush(releaseOpts, true);
	}

	if (shouldRunStep("trigger-workflow")) {
		console.log("==> Triggering Workflow");
		const branch = await getCurrentBookmark(REPO_ROOT);
		const latestFlag = releaseOpts.latest ? "true" : "false";

		// Build workflow command
		let workflowCmd = `gh workflow run .github/workflows/release.yaml -f target=${releaseOpts.target} -f version=${releaseOpts.version} -f latest=${latestFlag}`;
		if (releaseOpts.reuseEngineVersion) {
			workflowCmd += ` -f reuse_engine_version=${releaseOpts.reuseEngineVersion}`;
		}
		workflowCmd += ` --ref ${branch}`;

		await $({ stdio: "inherit", shell: true })`${workflowCmd}`;

		// Get repository info and print workflow link
		const repoResult =
			await $`gh repo view --json nameWithOwner -q .nameWithOwner`;
		const repo = repoResult.stdout.trim();
		console.log(
			`\nWorkflow triggered: https://github.com/${repo}/actions/workflows/release.yaml`,
		);
		console.log(`View all runs: https://github.com/${repo}/actions`);
	}

	if (shouldRunStep("validate-reuse-version")) {
		if (releaseOpts.reuseEngineVersion) {
			console.log("==> Validating Reuse Version");
			await validateReuseVersion(releaseOpts.reuseEngineVersion);
		}
	}

	if (shouldRunStep("run-ci-checks")) {
		console.log("==> Running CI Checks");
		await runCiChecks(releaseOpts);
	}

	if (shouldRunStep("build-js-artifacts")) {
		console.log("==> Building JS Artifacts");
		await buildJsArtifacts(releaseOpts);
	}

	if (shouldRunStep("publish-crates")) {
		console.log("==> Publishing Crates");
		await publishCrates(releaseOpts);
	}

	if (shouldRunStep("publish-npm-libraries")) {
		console.log("==> Publishing NPM Libraries");
		await publishNpmLibraries(releaseOpts);
	}

	if (shouldRunStep("publish-npm-cli")) {
		console.log("==> Publishing NPM CLI");
		await publishNpmCli(releaseOpts);
	}

	if (shouldRunStep("publish-npm-package")) {
		console.log("==> Publishing NPM Package");
		await publishRootPackage(releaseOpts);
	}

	if (shouldRunStep("tag-docker")) {
		console.log("==> Tagging Docker");
		await tagDocker(releaseOpts);
	}

	if (shouldRunStep("promote-artifacts")) {
		console.log("==> Promoting Artifacts");
		await promoteArtifacts(releaseOpts);
	}

	if (shouldRunStep("push-tag")) {
		console.log("==> Pushing Tag");
		await createAndPushTag(releaseOpts);
	}

	if (shouldRunStep("create-github-release")) {
		console.log("==> Creating GitHub Release");
		await createGitHubRelease(releaseOpts);
	}

	console.log("==> Complete");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
