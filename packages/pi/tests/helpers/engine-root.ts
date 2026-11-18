import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One directory for the engine data of every test file in this run, removed when the run ends. */
export default function setup(): () => void {
	const root = mkdtempSync(join(tmpdir(), "rivet-pi-test-"));
	// Test files run in child processes, which inherit this.
	process.env.RIVET_PI_TEST_ROOT = root;
	return () => rmSync(root, { recursive: true, force: true });
}
