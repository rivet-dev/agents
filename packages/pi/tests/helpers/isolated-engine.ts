import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test file runs in its own process and starts its own engine. An engine
// from the previous file can still hold its data directory while it shuts
// down, and a new engine that finds it locked exits. So each file gets its own
// data directory (under HOME) and port.
// `engine-root.ts` removes the run's directory when the run ends.
process.env.HOME = mkdtempSync(
	join(process.env.RIVET_PI_TEST_ROOT ?? tmpdir(), "home-"),
);
process.env.RIVET_RUN_ENGINE_PORT = String(await freePort());

/** A free port with room above it, because the engine also listens on the next ports. */
async function freePort(): Promise<number> {
	for (;;) {
		const port = 20_000 + Math.floor(Math.random() * 400) * 100;
		if (await isFree(port)) return port;
	}
}

function isFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
	});
}
