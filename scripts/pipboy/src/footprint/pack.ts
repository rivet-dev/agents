import { dirname, join } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import {
	BUILD_ENV,
	PACK_VERSION,
	PACKAGE_PARENTS,
	REGISTRY_PINNED,
} from "../config.ts";
import { run } from "../exec.ts";
import { PackManifest } from "../schema/footprint.ts";

export class PackFailed extends Schema.TaggedError<PackFailed>()("PackFailed", {
	packageName: Schema.String,
	expected: Schema.String,
}) {
	override get message() {
		return `pnpm pack did not produce ${this.expected} for ${this.packageName}`;
	}
}

const PackageJson = Schema.Struct({
	name: Schema.String,
	private: Schema.optionalKey(Schema.Boolean),
});

interface Package {
	readonly name: string;
	readonly dir: string;
	/** Root of the pnpm workspace the package belongs to. */
	readonly workspace: string;
}

/** Packages the release publishes from the checkout at `root`, minus registry-pinned ones. */
const packablePackages = Effect.fn("Footprint.packablePackages")(function* (
	root: string,
) {
	const fs = yield* FileSystem.FileSystem;
	const packages: Array<Package> = [];
	for (const parent of PACKAGE_PARENTS) {
		for (const child of (yield* fs.readDirectory(join(root, parent))).sort()) {
			const dir = join(root, parent, child);
			const manifest = join(dir, "package.json");
			if (
				(yield* fs.stat(dir)).type !== "Directory" ||
				!(yield* fs.exists(manifest))
			)
				continue;
			const pkg = yield* fs
				.readFileString(manifest)
				.pipe(
					Effect.flatMap(
						Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJson)),
					),
				);
			if (pkg.private === true || REGISTRY_PINNED.includes(pkg.name)) continue;
			packages.push({
				name: pkg.name,
				dir,
				workspace: yield* workspaceRoot(dir, root),
			});
		}
	}
	return packages;
});

/** The nearest directory at or above `dir` with a `pnpm-workspace.yaml`, stopping at `root`. */
const workspaceRoot = Effect.fn("Footprint.workspaceRoot")(function* (
	dir: string,
	root: string,
) {
	const fs = yield* FileSystem.FileSystem;
	for (
		let current = dir;
		current.startsWith(root);
		current = dirname(current)
	) {
		if (yield* fs.exists(join(current, "pnpm-workspace.yaml"))) return current;
	}
	return root;
});

/**
 * Builds and packs every publishable workspace package of the checkout at
 * `root` into `outDir`, the way `npm publish` would. All packages get
 * `PACK_VERSION` so `workspace:*` references between them resolve to these
 * tarballs. Original `package.json` files are restored afterwards, even on
 * failure. Registry-pinned packages and their binaries come from the registry.
 */
export const pack = Effect.fn("Footprint.pack")(function* (
	root: string,
	outDir: string,
) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(outDir, { recursive: true });
	const packages = yield* packablePackages(root);

	// Each package and its workspace dependencies build in their own workspace, as the release does.
	for (const workspace of new Set(packages.map((pkg) => pkg.workspace))) {
		const filters = packages
			.filter((pkg) => pkg.workspace === workspace)
			.flatMap((pkg) => ["--filter", `${pkg.name}...`]);
		yield* run("pnpm", [...filters, "run", "build"], {
			cwd: workspace,
			env: BUILD_ENV,
		});
	}

	const originals = yield* Effect.forEach(packages, (pkg) =>
		fs
			.readFileString(join(pkg.dir, "package.json"))
			.pipe(Effect.map((text) => ({ pkg, text }))),
	);
	const restore = Effect.forEach(
		originals,
		({ pkg, text }) => fs.writeFileString(join(pkg.dir, "package.json"), text),
		{ discard: true },
	).pipe(Effect.orDie);

	const tarballs = yield* Effect.acquireUseRelease(
		Effect.forEach(
			originals,
			({ pkg, text }) =>
				fs.writeFileString(
					join(pkg.dir, "package.json"),
					`${JSON.stringify({ ...JSON.parse(text), version: PACK_VERSION }, null, "\t")}\n`,
				),
			{ discard: true },
		),
		() =>
			Effect.forEach(
				packages,
				(pkg) =>
					Effect.gen(function* () {
						yield* run("pnpm", ["pack", "--pack-destination", outDir], {
							cwd: pkg.dir,
						});
						// pnpm names tarballs `<scope>-<name>-<version>.tgz`. Prepack scripts can
						// print to stdout, so the name is derived rather than parsed.
						const file = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${PACK_VERSION}.tgz`;
						if (!(yield* fs.exists(join(outDir, file)))) {
							return yield* new PackFailed({
								packageName: pkg.name,
								expected: file,
							});
						}
						return [pkg.name, file] as const;
					}),
				{ concurrency: 4 },
			),
		() => restore,
	);

	const manifest: PackManifest = {
		version: PACK_VERSION,
		tarballs: Object.fromEntries(tarballs),
	};
	yield* fs.writeFileString(
		join(outDir, "manifest.json"),
		JSON.stringify(manifest, null, 2),
	);
	return manifest;
});

/** The manifest `pack` writes next to the tarballs. */
export const readPackManifest = Effect.fn("Footprint.readPackManifest")(
	function* (dir: string) {
		const fs = yield* FileSystem.FileSystem;
		return yield* Schema.decodeUnknownEffect(
			Schema.fromJsonString(PackManifest),
		)(yield* fs.readFileString(join(dir, "manifest.json")));
	},
);
