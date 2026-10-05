/**
 * What one `just release` run releases. Sandbox Agent releases its crates,
 * binaries, Docker images, and npm packages; each root package releases only
 * itself. A target never publishes another target's packages.
 */
export const RELEASE_TARGETS = [
	"sandbox-agent",
	"pi",
	"sandbox-adapter",
] as const;

export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

/** A root workspace package that releases on its own. */
export interface RootPackage {
	name: string;
	/** Directory relative to the repository root. */
	dir: string;
}

export const ROOT_PACKAGES: Record<
	Exclude<ReleaseTarget, "sandbox-agent">,
	RootPackage
> = {
	pi: { name: "@rivet-dev/pi", dir: "packages/pi" },
	"sandbox-adapter": {
		name: "@rivet-dev/sandbox-adapter",
		dir: "packages/sandbox-adapter",
	},
};

export function parseReleaseTarget(value: string): ReleaseTarget {
	if (!RELEASE_TARGETS.includes(value as ReleaseTarget)) {
		throw new Error(
			`Unknown release target ${value}. Available: ${RELEASE_TARGETS.join(", ")}`,
		);
	}
	return value as ReleaseTarget;
}

/** The root package a target releases, or undefined for Sandbox Agent. */
export function rootPackage(target: ReleaseTarget): RootPackage | undefined {
	return target === "sandbox-agent" ? undefined : ROOT_PACKAGES[target];
}

/** Sandbox Agent tags `v<version>`; a root package tags `<target>-v<version>`. */
export function tagPrefix(target: ReleaseTarget): string {
	return target === "sandbox-agent" ? "v" : `${target}-v`;
}

export function releaseTag(target: ReleaseTarget, version: string): string {
	return `${tagPrefix(target)}${version}`;
}

/** The GitHub release title: the version for Sandbox Agent, `<package> <version>` for a root package. */
export function releaseTitle(target: ReleaseTarget, version: string): string {
	const pkg = rootPackage(target);
	return pkg ? `${pkg.name} ${version}` : version;
}
