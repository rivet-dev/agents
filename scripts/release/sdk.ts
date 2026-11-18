import * as fs from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { $ } from "execa";
import { glob } from "glob";
import type { ReleaseOpts } from "./main";
import { downloadFromReleases, PREFIX } from "./utils";

// ─── Platform binary mapping (npm package → Rust target) ────────────────────
// Maps CLI platform packages to their Rust build targets.
// Keep in sync when adding new target platforms.
const CLI_PLATFORM_MAP: Record<
	string,
	{ target: string; binaryExt: string; binaryName: string }
> = {
	"@sandbox-agent/cli-linux-x64": {
		target: "x86_64-unknown-linux-musl",
		binaryExt: "",
		binaryName: "sandbox-agent",
	},
	"@sandbox-agent/cli-linux-arm64": {
		target: "aarch64-unknown-linux-musl",
		binaryExt: "",
		binaryName: "sandbox-agent",
	},
	"@sandbox-agent/cli-win32-x64": {
		target: "x86_64-pc-windows-gnu",
		binaryExt: ".exe",
		binaryName: "sandbox-agent",
	},
	"@sandbox-agent/cli-darwin-x64": {
		target: "x86_64-apple-darwin",
		binaryExt: "",
		binaryName: "sandbox-agent",
	},
	"@sandbox-agent/cli-darwin-arm64": {
		target: "aarch64-apple-darwin",
		binaryExt: "",
		binaryName: "sandbox-agent",
	},
	"@sandbox-agent/gigacode-linux-x64": {
		target: "x86_64-unknown-linux-musl",
		binaryExt: "",
		binaryName: "gigacode",
	},
	"@sandbox-agent/gigacode-linux-arm64": {
		target: "aarch64-unknown-linux-musl",
		binaryExt: "",
		binaryName: "gigacode",
	},
	"@sandbox-agent/gigacode-win32-x64": {
		target: "x86_64-pc-windows-gnu",
		binaryExt: ".exe",
		binaryName: "gigacode",
	},
	"@sandbox-agent/gigacode-darwin-x64": {
		target: "x86_64-apple-darwin",
		binaryExt: "",
		binaryName: "gigacode",
	},
	"@sandbox-agent/gigacode-darwin-arm64": {
		target: "aarch64-apple-darwin",
		binaryExt: "",
		binaryName: "gigacode",
	},
};

// ─── Shared helpers ─────────────────────────────────────────────────────────

async function npmVersionExists(
	packageName: string,
	version: string,
): Promise<boolean> {
	console.log(`==> Checking if NPM version exists: ${packageName}@${version}`);
	try {
		await $({
			stdout: "ignore",
			stderr: "pipe",
		})`npm view ${packageName}@${version} version`;
		return true;
	} catch (error: any) {
		if (error.stderr) {
			const stderr = error.stderr;
			// Expected errors when version or package doesn't exist
			const expected =
				stderr.includes(`No match found for version ${version}`) ||
				stderr.includes(
					`'${packageName}@${version}' is not in this registry.`,
				) ||
				stderr.includes("404 Not Found") ||
				stderr.includes("is not in the npm registry");
			if (!expected) {
				throw new Error(`unexpected npm view version output: ${stderr}`);
			}
		}
		return false;
	}
}

async function crateVersionExists(
	crateName: string,
	version: string,
): Promise<boolean> {
	console.log(`==> Checking if crate version exists: ${crateName}@${version}`);
	try {
		const result = await $({
			stdout: "pipe",
			stderr: "pipe",
		})`cargo search ${crateName} --limit 1`;
		const output = result.stdout;
		const match = output.match(new RegExp(`^${crateName}\\s*=\\s*"([^"]+)"`));
		if (match && match[1] === version) {
			return true;
		}
		return false;
	} catch (_error: any) {
		return false;
	}
}

// ─── Package discovery ──────────────────────────────────────────────────────

interface NpmPackageInfo {
	name: string;
	dir: string;
	/** pnpm workspace root that owns the package. Builds run from here. */
	workspaceRoot: string;
	hasBuildScript: boolean;
	localDeps: string[];
}

/**
 * Discover non-private npm packages matching the given glob patterns.
 */
async function discoverNpmPackages(
	root: string,
	patterns: string[],
): Promise<NpmPackageInfo[]> {
	const packages: NpmPackageInfo[] = [];

	for (const pattern of patterns) {
		const matches = await glob(pattern, { cwd: root });
		for (const match of matches) {
			const fullPath = join(root, match);
			const pkg = JSON.parse(await fs.readFile(fullPath, "utf-8"));
			if (pkg.private) continue;

			const allDeps = { ...pkg.dependencies, ...pkg.peerDependencies };
			const localDeps = Object.entries(allDeps || {})
				.filter(([_, v]) => String(v).startsWith("workspace:"))
				.map(([k]) => k);

			packages.push({
				name: pkg.name,
				dir: dirname(fullPath),
				workspaceRoot: root,
				hasBuildScript: !!pkg.scripts?.build,
				localDeps,
			});
		}
	}

	return packages;
}

/**
 * Topologically sort packages so dependencies are published before dependents.
 */
function topoSort(packages: NpmPackageInfo[]): NpmPackageInfo[] {
	const byName = new Map(packages.map((p) => [p.name, p]));
	const visited = new Set<string>();
	const result: NpmPackageInfo[] = [];

	function visit(pkg: NpmPackageInfo) {
		if (visited.has(pkg.name)) return;
		visited.add(pkg.name);
		for (const dep of pkg.localDeps) {
			const d = byName.get(dep);
			if (d) visit(d);
		}
		result.push(pkg);
	}

	for (const pkg of packages) visit(pkg);
	return result;
}

interface CrateInfo {
	name: string;
	dir: string;
}

/**
 * Discover workspace crates via `cargo metadata` and return them in dependency order.
 */
async function discoverCrates(root: string): Promise<CrateInfo[]> {
	const result = await $({
		cwd: root,
		stdout: "pipe",
	})`cargo metadata --no-deps --format-version 1`;
	const metadata = JSON.parse(result.stdout);

	const memberIds = new Set<string>(metadata.workspace_members);
	const workspacePackages = metadata.packages.filter((p: any) =>
		memberIds.has(p.id),
	);

	// Build name→package map for topo sort
	const byName = new Map<string, any>(
		workspacePackages.map((p: any) => [p.name, p]),
	);

	const visited = new Set<string>();
	const sorted: CrateInfo[] = [];

	function visit(pkg: any) {
		if (visited.has(pkg.name)) return;
		visited.add(pkg.name);
		for (const dep of pkg.dependencies) {
			const internal = byName.get(dep.name);
			if (internal) visit(internal);
		}
		sorted.push({
			name: pkg.name,
			dir: dirname(pkg.manifest_path),
		});
	}

	for (const pkg of workspacePackages) visit(pkg);
	return sorted;
}

// ─── Crate publishing ───────────────────────────────────────────────────────

export async function publishCrates(opts: ReleaseOpts) {
	console.log("==> Discovering workspace crates");
	const crates = await discoverCrates(opts.sandboxAgentRoot);

	console.log(`Found ${crates.length} crates to publish:`);
	for (const c of crates) console.log(`  - ${c.name}`);

	for (const crate of crates) {
		const versionExists = await crateVersionExists(crate.name, opts.version);
		if (versionExists) {
			console.log(
				`Version ${opts.version} of ${crate.name} already exists on crates.io. Skipping...`,
			);
			continue;
		}

		console.log(`==> Publishing to crates.io: ${crate.name}@${opts.version}`);

		try {
			await $({
				stdout: "pipe",
				stderr: "pipe",
				cwd: crate.dir,
			})`cargo publish --allow-dirty --no-verify`;
			console.log(`✅ Published ${crate.name}@${opts.version}`);
		} catch (err: any) {
			if (err.stderr?.includes("already exists")) {
				console.log(
					`Version ${opts.version} of ${crate.name} already exists on crates.io. Skipping...`,
				);
				continue;
			}
			console.error(`❌ Failed to publish ${crate.name}`);
			console.error(err.stderr || err.message);
			throw err;
		}

		console.log("Waiting for crates.io to index...");
		await new Promise((resolve) => setTimeout(resolve, 30000));
	}

	console.log("✅ All crates published");
}

// ─── NPM library publishing ────────────────────────────────────────────────

/**
 * Discover and publish all non-private library packages under sdks/.
 * Excludes CLI/gigacode wrapper and platform packages (handled by publishNpmCli).
 * Publishes in dependency order via topological sort.
 */
export async function publishNpmLibraries(opts: ReleaseOpts) {
	console.log("==> Discovering library packages");
	const sandboxAgentSdks = await discoverNpmPackages(opts.sandboxAgentRoot, [
		"sdks/*/package.json",
	]);

	// Exclude CLI and gigacode directories (handled by publishNpmCli)
	const sandboxAgentLibraries = sandboxAgentSdks.filter((p) => {
		const rel = relative(opts.sandboxAgentRoot, p.dir);
		return (
			!(rel === "sdks/cli" || rel.startsWith("sdks/cli/")) &&
			!(rel === "sdks/gigacode" || rel.startsWith("sdks/gigacode/"))
		);
	});

	// Root workspace packages (for example @rivet-dev/pi) ship on the same
	// version line.
	const rootLibraries = await discoverNpmPackages(opts.repoRoot, [
		"packages/*/package.json",
	]);

	const libraries = [...sandboxAgentLibraries, ...rootLibraries];

	const sorted = topoSort(libraries);

	console.log(`Found ${sorted.length} library packages to publish:`);
	for (const pkg of sorted) console.log(`  - ${pkg.name}`);

	const isReleaseCandidate = opts.version.includes("-rc.");
	const tag = isReleaseCandidate
		? "rc"
		: opts.latest
			? "latest"
			: opts.minorVersionChannel;

	for (const pkg of sorted) {
		const versionExists = await npmVersionExists(pkg.name, opts.version);
		if (versionExists) {
			console.log(
				`Version ${opts.version} of ${pkg.name} already exists. Skipping...`,
			);
			continue;
		}

		// A skipped package is never built here, but a dependent's build reads
		// its build output, so each build includes its workspace dependencies.
		if (pkg.hasBuildScript) {
			console.log(`==> Building ${pkg.name} and its workspace dependencies`);
			await $({
				stdio: "inherit",
				cwd: pkg.workspaceRoot,
			})`pnpm --filter ${`${pkg.name}...`} build`;
		}

		console.log(`==> Publishing to NPM: ${pkg.name}@${opts.version}`);
		try {
			await $({
				stdio: "inherit",
				cwd: pkg.dir,
			})`pnpm publish --access public --tag ${tag} --no-git-checks`;
			console.log(`✅ Published ${pkg.name}@${opts.version}`);
		} catch (err: any) {
			if (
				err.stderr?.includes(
					"You cannot publish over the previously published versions",
				)
			) {
				console.log(
					`⚠️ ${pkg.name}@${opts.version} already published (npm registry). Skipping.`,
				);
			} else {
				throw err;
			}
		}
	}

	console.log("✅ All library packages published");
}

// ─── NPM CLI publishing ────────────────────────────────────────────────────

/**
 * Discover and publish CLI wrapper and platform packages.
 * Platform packages get their binaries downloaded from R2 before publishing.
 */
export async function publishNpmCli(opts: ReleaseOpts) {
	console.log("==> Discovering CLI packages");
	const packages = await discoverNpmPackages(opts.sandboxAgentRoot, [
		"sdks/cli/package.json",
		"sdks/cli/platforms/*/package.json",
		"sdks/gigacode/package.json",
		"sdks/gigacode/platforms/*/package.json",
	]);

	console.log(`Found ${packages.length} CLI packages to publish:`);
	for (const pkg of packages) console.log(`  - ${pkg.name}`);

	// Determine which commit to use for downloading binaries
	let sourceCommit = opts.commit;
	if (opts.reuseEngineVersion) {
		const ref = opts.reuseEngineVersion.includes(".")
			? `v${opts.reuseEngineVersion}`
			: opts.reuseEngineVersion;
		const result = await $`git rev-parse ${ref}`;
		sourceCommit = result.stdout.trim().slice(0, 7);
		console.log(`Using binaries from commit: ${sourceCommit}`);
	}

	for (const pkg of packages) {
		const versionExists = await npmVersionExists(pkg.name, opts.version);
		if (versionExists) {
			console.log(
				`Version ${opts.version} of ${pkg.name} already exists. Skipping...`,
			);
			continue;
		}

		// Download binary for platform-specific packages
		const platformInfo = CLI_PLATFORM_MAP[pkg.name];
		if (platformInfo) {
			const binDir = join(pkg.dir, "bin");
			const binaryName = `${platformInfo.binaryName}${platformInfo.binaryExt}`;
			const localBinaryPath = join(binDir, binaryName);
			const remoteBinaryPath = `${PREFIX}/${sourceCommit}/binaries/${platformInfo.binaryName}-${platformInfo.target}${platformInfo.binaryExt}`;

			console.log(`==> Downloading binary for ${pkg.name}`);
			console.log(`    From: ${remoteBinaryPath}`);
			console.log(`    To: ${localBinaryPath}`);

			await fs.mkdir(binDir, { recursive: true });
			await downloadFromReleases(remoteBinaryPath, localBinaryPath);

			if (!platformInfo.binaryExt) {
				await fs.chmod(localBinaryPath, 0o755);
			}
		}

		// Publish
		console.log(`==> Publishing to NPM: ${pkg.name}@${opts.version}`);

		const isReleaseCandidate = opts.version.includes("-rc.");
		const tag = getCliPackageNpmTag({
			packageName: pkg.name,
			isReleaseCandidate,
			latest: opts.latest,
			minorVersionChannel: opts.minorVersionChannel,
		});

		try {
			await $({
				stdio: "inherit",
				cwd: pkg.dir,
			})`pnpm publish --access public --tag ${tag} --no-git-checks`;
			console.log(`✅ Published ${pkg.name}@${opts.version}`);
		} catch (err: any) {
			if (
				err.stderr?.includes(
					"You cannot publish over the previously published versions",
				)
			) {
				console.log(
					`⚠️ ${pkg.name}@${opts.version} already published (npm registry). Skipping.`,
				);
			} else {
				console.error(`❌ Failed to publish ${pkg.name}`);
				throw err;
			}
		}
	}

	console.log("✅ All CLI packages published");
}

function getCliPackageNpmTag(opts: {
	packageName: string;
	isReleaseCandidate: boolean;
	latest: boolean;
	minorVersionChannel: string;
}): string {
	if (opts.isReleaseCandidate) {
		return "rc";
	}

	if (opts.latest) {
		return "latest";
	}

	return opts.minorVersionChannel;
}
