import * as fs from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";
import * as semver from "semver";
import type { ReleaseOpts } from "./main";

function assert(condition: any, message?: string): asserts condition {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

// Files containing version references that need channel/image tag updates,
// relative to the repository root.
// Keep in sync with sandbox-agent/CLAUDE.md "Install Version References" section.
const VERSION_REFERENCE_FILES = [
	"sandbox-agent/README.md",
	"sandbox-agent/docs/content/docs/cli.mdx",
	"sandbox-agent/docs/content/docs/quickstart.mdx",
	"sandbox-agent/docs/content/docs/sdk-overview.mdx",
	"sandbox-agent/docs/content/docs/react-components.mdx",
	"sandbox-agent/docs/content/docs/session-persistence.mdx",
	"sandbox-agent/docs/content/docs/architecture.mdx",
	"sandbox-agent/docs/content/docs/deploy/local.mdx",
	"sandbox-agent/docs/content/docs/deploy/cloudflare.mdx",
	"sandbox-agent/docs/content/docs/deploy/vercel.mdx",
	"sandbox-agent/docs/content/docs/deploy/daytona.mdx",
	"sandbox-agent/docs/content/docs/deploy/agentcomputer.mdx",
	"sandbox-agent/docs/content/docs/deploy/e2b.mdx",
	"sandbox-agent/docs/content/docs/deploy/docker.mdx",
	"sandbox-agent/docs/content/docs/deploy/boxlite.mdx",
	"sandbox-agent/docs/content/docs/deploy/modal.mdx",
	"sandbox-agent/docs/content/docs/deploy/computesdk.mdx",
	"sandbox-agent/frontend/packages/website/src/components/GetStarted.tsx",
	"sandbox-agent/.claude/commands/post-release-testing.md",
	"sandbox-agent/examples/cloudflare/Dockerfile",
	"sandbox-agent/examples/boxlite/Dockerfile",
	"sandbox-agent/examples/boxlite-python/Dockerfile",
	"sandbox-agent/examples/daytona/src/index.ts",
	"sandbox-agent/examples/shared/src/docker.ts",
	"sandbox-agent/examples/docker/src/index.ts",
	"sandbox-agent/examples/e2b/src/index.ts",
	"sandbox-agent/examples/vercel/src/index.ts",
	"sandbox-agent/sdks/typescript/src/providers/shared.ts",
	"scripts/release/main.ts",
	"scripts/release/promote-artifacts.ts",
	"scripts/release/sdk.ts",
];

export async function updateVersion(opts: ReleaseOpts) {
	// 1. Read current version from Cargo.toml before overwriting
	const cargoTomlPath = join(opts.sandboxAgentRoot, "Cargo.toml");
	let cargoContent = await fs.readFile(cargoTomlPath, "utf-8");

	const oldVersionMatch = cargoContent.match(
		/\[workspace\.package\]\nversion = "([^"]+)"/,
	);
	assert(
		oldVersionMatch,
		"Could not find workspace.package version in Cargo.toml",
	);
	const oldVersion = oldVersionMatch[1];
	const oldParsed = semver.parse(oldVersion);
	assert(oldParsed, `Could not parse old version: ${oldVersion}`);
	const oldMinorChannel = `${oldParsed.major}.${oldParsed.minor}.x`;

	// Update [workspace.package] version
	cargoContent = cargoContent.replace(
		/\[workspace\.package\]\nversion = ".*"/,
		`[workspace.package]\nversion = "${opts.version}"`,
	);

	// Discover internal crates from [workspace.dependencies] by matching
	// lines with both `version = "..."` and `path = "..."` (internal path deps)
	const internalCratePattern =
		/^(\S+)\s*=\s*\{[^}]*version\s*=\s*"[^"]+"\s*,[^}]*path\s*=/gm;
	const internalCrates = [...cargoContent.matchAll(internalCratePattern)].map(
		(match) => match[1],
	);

	console.log(
		`Discovered ${internalCrates.length} internal crates to version-bump:`,
	);
	for (const crate of internalCrates) console.log(`  - ${crate}`);

	for (const crate of internalCrates) {
		const pattern = new RegExp(
			`(${crate.replace(/-/g, "-")} = \\{ version = ")[^"]+(",)`,
			"g",
		);
		cargoContent = cargoContent.replace(pattern, `$1${opts.version}$2`);
	}

	await fs.writeFile(cargoTomlPath, cargoContent);

	// 2. Discover and update every non-private package.json on the release line:
	// the Sandbox Agent SDKs. The root packages in `packages/` carry their own
	// versions, set below.
	const packageJsonPaths = await glob(["sandbox-agent/sdks/**/package.json"], {
		cwd: opts.repoRoot,
		ignore: ["**/node_modules/**"],
	});

	// Filter to non-private packages only
	const toUpdate: string[] = [];
	for (const relPath of packageJsonPaths.sort()) {
		const fullPath = join(opts.repoRoot, relPath);
		const content = await fs.readFile(fullPath, "utf-8");
		const pkg = JSON.parse(content);
		if (pkg.private) continue;
		toUpdate.push(relPath);
	}

	console.log(
		`Discovered ${toUpdate.length} package.json files to version-bump:`,
	);
	for (const relPath of toUpdate) console.log(`  - ${relPath}`);

	for (const relPath of toUpdate) {
		const fullPath = join(opts.repoRoot, relPath);
		const content = await fs.readFile(fullPath, "utf-8");

		const versionPattern = /"version": ".*"/;
		assert(versionPattern.test(content), `No version field in ${relPath}`);

		const updated = content.replace(
			versionPattern,
			`"version": "${opts.version}"`,
		);
		await fs.writeFile(fullPath, updated);
	}

	// 3. Set the root packages' own versions, when given.
	for (const [relPath, version] of [
		["packages/pi/package.json", opts.piVersion],
		["packages/sandbox-adapter/package.json", opts.sandboxAdapterVersion],
	] as const) {
		if (!version) continue;
		const fullPath = join(opts.repoRoot, relPath);
		const content = await fs.readFile(fullPath, "utf-8");
		const versionPattern = /"version": ".*"/;
		assert(versionPattern.test(content), `No version field in ${relPath}`);
		await fs.writeFile(
			fullPath,
			content.replace(versionPattern, `"version": "${version}"`),
		);
		console.log(`Set ${relPath} to ${version}`);
	}

	// 4. Update version references across docs, examples, and code
	await updateVersionReferences(opts, oldVersion, oldMinorChannel);
}

async function updateVersionReferences(
	opts: ReleaseOpts,
	_oldVersion: string,
	oldMinorChannel: string,
) {
	const newMinorChannel = opts.minorVersionChannel;

	console.log(`\nUpdating version references:`);
	console.log(`  Old minor channel: ${oldMinorChannel}`);
	console.log(`  New minor channel: ${newMinorChannel}`);
	console.log(`  New Docker tag: ${opts.version}-full`);

	const modifiedFiles: string[] = [];

	for (const relPath of VERSION_REFERENCE_FILES) {
		const fullPath = join(opts.repoRoot, relPath);

		let content: string;
		try {
			content = await fs.readFile(fullPath, "utf-8");
		} catch (err: any) {
			if (err.code === "ENOENT") {
				console.log(`  ⚠️  Skipping ${relPath} (file not found)`);
				continue;
			}
			throw err;
		}

		const original = content;

		// Replace minor channel references (e.g. sandbox-agent@0.5.x -> sandbox-agent@0.5.x)
		content = content.replaceAll(
			`sandbox-agent@${oldMinorChannel}`,
			`sandbox-agent@${newMinorChannel}`,
		);
		content = content.replaceAll(
			`@sandbox-agent/cli@${oldMinorChannel}`,
			`@sandbox-agent/cli@${newMinorChannel}`,
		);
		content = content.replaceAll(
			`@sandbox-agent/react@${oldMinorChannel}`,
			`@sandbox-agent/react@${newMinorChannel}`,
		);

		// Replace install script URL channel
		content = content.replaceAll(
			`releases.rivet.dev/sandbox-agent/${oldMinorChannel}/`,
			`releases.rivet.dev/sandbox-agent/${newMinorChannel}/`,
		);

		// If references drifted (for example Cargo.toml version was bumped without updating docs),
		// normalize any other pinned minor-channel references to the release's channel.
		content = content.replaceAll(
			/sandbox-agent@0\.\d+\.x/g,
			`sandbox-agent@${newMinorChannel}`,
		);
		content = content.replaceAll(
			/@sandbox-agent\/cli@0\.\d+\.x/g,
			`@sandbox-agent/cli@${newMinorChannel}`,
		);
		content = content.replaceAll(
			/@sandbox-agent\/react@0\.\d+\.x/g,
			`@sandbox-agent/react@${newMinorChannel}`,
		);
		content = content.replaceAll(
			/releases\.rivet\.dev\/sandbox-agent\/0\.\d+\.x\//g,
			`releases.rivet.dev/sandbox-agent/${newMinorChannel}/`,
		);

		// Replace Docker image tags (rivetdev/sandbox-agent:<anything>-full -> rivetdev/sandbox-agent:<version>-full)
		content = content.replaceAll(
			/rivetdev\/sandbox-agent:[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?-full/g,
			`rivetdev/sandbox-agent:${opts.version}-full`,
		);

		// Replace standalone version-full references in prose (e.g. "The `0.3.2-full` tag pins...")
		// Match backtick-wrapped version-full patterns
		content = content.replaceAll(
			/`[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?-full`/g,
			`\`${opts.version}-full\``,
		);

		if (content !== original) {
			await fs.writeFile(fullPath, content);
			modifiedFiles.push(relPath);
			console.log(`  ✅ ${relPath}`);
		}
	}

	if (modifiedFiles.length > 0) {
		console.log(
			`\nUpdated ${modifiedFiles.length} files with version references.`,
		);
	} else {
		console.log(`\nNo version reference files needed updates.`);
	}
}
