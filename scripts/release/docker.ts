import { $ } from "execa";
import type { ReleaseOpts } from "./main";
import { fetchGitRef, versionOrCommitToRef } from "./utils";

const IMAGE = "rivetdev/sandbox-agent";

export async function tagDocker(opts: ReleaseOpts) {
	// Determine which commit to use for source images
	let sourceCommit = opts.commit;
	if (opts.reuseEngineVersion) {
		console.log(`==> Reusing Docker images from ${opts.reuseEngineVersion}`);
		const ref = versionOrCommitToRef(opts.reuseEngineVersion);
		await fetchGitRef(ref);
		const result = await $`git rev-parse ${ref}`;
		sourceCommit = result.stdout.trim().slice(0, 7);
		console.log(`==> Source commit: ${sourceCommit}`);
	}

	try {
		await ensureArchImagesExist(sourceCommit, "");
	} catch (_error) {
		console.warn(
			`⚠️ Docker images ${IMAGE}:${sourceCommit}-{amd64,arm64} not found - skipping Docker tagging`,
		);
		console.warn(
			`   To enable Docker tagging, build and push images first, then retry the release.`,
		);
		return;
	}

	await createManifest(sourceCommit, opts.version);
	if (opts.latest) {
		await createManifest(sourceCommit, "latest");
		await createManifest(sourceCommit, opts.minorVersionChannel);
	}

	try {
		await ensureArchImagesExist(sourceCommit, "-full");
		await createManifest(sourceCommit, `${opts.version}-full`, "-full");
		if (opts.latest) {
			await createManifest(
				sourceCommit,
				`${opts.minorVersionChannel}-full`,
				"-full",
			);
			await createManifest(sourceCommit, "full", "-full");
		}
	} catch (_error) {
		console.warn(
			`⚠️ Full Docker images ${IMAGE}:${sourceCommit}-full-{amd64,arm64} not found - skipping full Docker tagging`,
		);
		console.warn(
			`   To enable full Docker tagging, build and push full images first, then retry the release.`,
		);
	}
}

async function ensureArchImagesExist(
	sourceCommit: string,
	variantSuffix: "" | "-full",
) {
	console.log(
		`==> Checking images exist: ${IMAGE}:${sourceCommit}${variantSuffix}-{amd64,arm64}`,
	);
	console.log(`==> Inspecting ${IMAGE}:${sourceCommit}${variantSuffix}-amd64`);
	await $({
		stdio: "inherit",
	})`docker manifest inspect ${IMAGE}:${sourceCommit}${variantSuffix}-amd64`;
	console.log(`==> Inspecting ${IMAGE}:${sourceCommit}${variantSuffix}-arm64`);
	await $({
		stdio: "inherit",
	})`docker manifest inspect ${IMAGE}:${sourceCommit}${variantSuffix}-arm64`;
	console.log(`==> Both images exist`);
}

async function createManifest(
	from: string,
	to: string,
	variantSuffix: "" | "-full" = "",
) {
	console.log(
		`==> Creating manifest: ${IMAGE}:${to} from ${IMAGE}:${from}${variantSuffix}-{amd64,arm64}`,
	);

	await $({
		stdio: "inherit",
	})`docker buildx imagetools create --tag ${IMAGE}:${to} ${IMAGE}:${from}${variantSuffix}-amd64 ${IMAGE}:${from}${variantSuffix}-arm64`;
}
