// Packs the root workspace packages and installs them into a scratch project
// the way a user would, then imports every entrypoint except the ones that
// need a sandbox provider's SDK. Run after `pnpm build`.
import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(new URL("../", import.meta.url).pathname);
const packDirectory = join(repositoryRoot, ".pack");

await rm(packDirectory, { recursive: true, force: true });
await mkdir(packDirectory, { recursive: true });
for (const packagePath of ["packages/sandbox-adapter", "packages/pi"]) {
	await execFileAsync(
		"pnpm",
		["--dir", packagePath, "pack", "--pack-destination", packDirectory],
		{
			cwd: repositoryRoot,
		},
	);
}

const tarballs = await readdir(packDirectory);
function tarball(prefix) {
	const name = tarballs.find((file) => file.startsWith(prefix));
	if (!name) throw new Error(`missing tarball ${prefix}*`);
	return join(packDirectory, name);
}
const piTarball = tarball("rivet-dev-pi-");
const adapterTarball = tarball("rivet-dev-sandbox-adapter-");

const piManifest = JSON.parse(
	await readFile(join(repositoryRoot, "packages/pi/package.json"), "utf8"),
);
const piDevDependencies = piManifest.devDependencies;

const fixture = await mkdtemp(join(tmpdir(), "rivet-agents-packed-"));
await writeFile(
	join(fixture, "package.json"),
	JSON.stringify({
		private: true,
		type: "module",
		dependencies: {
			"@rivet-dev/pi": `file:${piTarball}`,
			"@rivet-dev/sandbox-adapter": `file:${adapterTarball}`,
			rivetkit: piDevDependencies.rivetkit,
			// The peers of `@rivet-dev/pi`.
			"@earendil-works/chord": piDevDependencies["@earendil-works/chord"],
			"@earendil-works/pi-durable":
				piDevDependencies["@earendil-works/pi-durable"],
		},
	}),
);
await execFileAsync(
	"npm",
	["install", "--no-audit", "--no-fund", "--loglevel=error"],
	{ cwd: fixture },
);

for (const name of ["@rivet-dev/pi", "@rivet-dev/sandbox-adapter"]) {
	const manifest = JSON.parse(
		await readFile(join(fixture, "node_modules", name, "package.json"), "utf8"),
	);
	const serialized = JSON.stringify(manifest);
	if (serialized.includes("workspace:") || serialized.includes("catalog:")) {
		throw new Error(`${name} contains an unpublished dependency specifier`);
	}
	if (manifest.version !== piManifest.version) {
		throw new Error(
			`${name}@${manifest.version} is off the release line (${piManifest.version})`,
		);
	}
}

const packedPi = JSON.parse(
	await readFile(
		join(fixture, "node_modules/@rivet-dev/pi/package.json"),
		"utf8",
	),
);
if (
	packedPi.dependencies["@rivet-dev/sandbox-adapter"] !== piManifest.version
) {
	throw new Error(
		"packed @rivet-dev/pi must pin the sandbox adapter to the release version",
	);
}

// The e2b and daytona entrypoints need optional peer SDKs, so only check that
// they were packed.
const adapterFiles = await readdir(
	join(fixture, "node_modules/@rivet-dev/sandbox-adapter/dist"),
);
for (const entry of ["index.js", "agentos.js", "e2b.js", "daytona.js"]) {
	if (!adapterFiles.includes(entry))
		throw new Error(`packed sandbox adapter is missing dist/${entry}`);
}

const script = [
	'const pi = await import("@rivet-dev/pi");',
	'if (typeof pi.pi !== "function") throw new Error("@rivet-dev/pi does not export pi()");',
	'const durable = await import("@rivet-dev/pi/durable");',
	'if (durable.piDurable !== pi.pi) throw new Error("@rivet-dev/pi/durable does not export piDurable() as pi()");',
	'const adapter = await import("@rivet-dev/sandbox-adapter");',
	'if (typeof adapter.runRemoteProcess !== "function") throw new Error("@rivet-dev/sandbox-adapter does not export runRemoteProcess()");',
].join("\n");
await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
	cwd: fixture,
});

await rm(fixture, { recursive: true, force: true });
console.log(`Verified ${tarballs.join(", ")}.`);
