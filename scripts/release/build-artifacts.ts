import * as path from "node:path";
import { $ } from "execa";
import type { ReleaseOpts } from "./main";
import { assertDirExists, PREFIX, uploadDirToReleases } from "./utils";

export async function buildJsArtifacts(opts: ReleaseOpts) {
	await buildAndUploadTypescriptSdk(opts);
}

async function buildAndUploadTypescriptSdk(opts: ReleaseOpts) {
	console.log(`==> Building TypeScript SDK`);

	// Build TypeScript SDK
	await $({
		stdio: "inherit",
		cwd: opts.sandboxAgentRoot,
	})`pnpm --filter sandbox-agent build`;

	console.log(`✅ TypeScript SDK built successfully`);

	// Upload TypeScript SDK to R2
	console.log(`==> Uploading TypeScript SDK Artifacts`);

	const sdkDistPath = path.resolve(
		opts.sandboxAgentRoot,
		"sdks/typescript/dist",
	);

	await assertDirExists(sdkDistPath);

	// Upload to commit directory
	console.log(
		`Uploading TypeScript SDK to ${PREFIX}/${opts.commit}/typescript/`,
	);
	await uploadDirToReleases(
		sdkDistPath,
		`${PREFIX}/${opts.commit}/typescript/`,
	);

	console.log(`✅ TypeScript SDK artifacts uploaded successfully`);
}
