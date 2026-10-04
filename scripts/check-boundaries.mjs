// Checks package boundaries and the shared release line for the root
// workspace packages. Runs in CI before packing.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url);

async function read(path) {
	return readFile(new URL(path, root), "utf8");
}

async function readJson(path) {
	return JSON.parse(await read(path));
}

async function walk(path) {
	const entries = await readdir(new URL(path, root), { withFileTypes: true });
	return (
		await Promise.all(
			entries.map(async (entry) => {
				const child = join(path, entry.name);
				return entry.isDirectory() ? walk(`${child}/`) : [child];
			}),
		)
	).flat();
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const piPackage = await readJson("packages/pi/package.json");
const adapterPackage = await readJson("packages/sandbox-adapter/package.json");

// One release line: every published package in the repository carries the
// Sandbox Agent workspace version, which `just release` bumps everywhere.
const cargo = await read("sandbox-agent/Cargo.toml");
const cargoVersion = cargo.match(
	/\[workspace\.package\]\nversion = "([^"]+)"/,
)?.[1];
assert(
	cargoVersion,
	"could not read the workspace version from sandbox-agent/Cargo.toml",
);
for (const manifest of [piPackage, adapterPackage]) {
	assert(
		manifest.version === cargoVersion,
		`${manifest.name}@${manifest.version} is off the release line (${cargoVersion})`,
	);
}

// pi runs inside the user's registry, so it must share their RivetKit.
assert(
	!piPackage.dependencies?.rivetkit,
	"@rivet-dev/pi must not depend on rivetkit directly",
);
assert(
	piPackage.peerDependencies?.rivetkit,
	"@rivet-dev/pi must declare rivetkit as a peer dependency",
);
assert(
	piPackage.devDependencies?.rivetkit,
	"@rivet-dev/pi must pin rivetkit as a dev dependency for tests",
);
assert(
	piPackage.dependencies?.["@rivet-dev/sandbox-adapter"] === "workspace:*",
	"@rivet-dev/pi must depend on the workspace sandbox adapter so publishing pins the release version",
);

// The sandbox adapter is runtime-agnostic and must not pull in RivetKit.
for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
	assert(
		!adapterPackage[field]?.rivetkit,
		`@rivet-dev/sandbox-adapter must not list rivetkit in ${field}`,
	);
}
for (const path of await walk("packages/sandbox-adapter/src/")) {
	if (!path.endsWith(".ts")) continue;
	assert(
		!/from ["']rivetkit(?:\/[^"']*)?["']/.test(await read(path)),
		`${path} imports RivetKit`,
	);
}

for (const [directory, manifest] of [
	["packages/pi", piPackage],
	["packages/sandbox-adapter", adapterPackage],
]) {
	assert(
		manifest.repository?.url === "https://github.com/rivet-dev/agents.git" &&
			manifest.repository?.directory === directory,
		`${manifest.name} must point repository.directory at ${directory}`,
	);
}

console.log("Agent package boundaries are valid.");
