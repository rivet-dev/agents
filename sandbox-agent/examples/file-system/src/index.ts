import { SandboxAgent } from "sandbox-agent";
import { detectAgent, buildInspectorUrl } from "@sandbox-agent/example-shared";
import { startDockerSandbox } from "@sandbox-agent/example-shared/docker";
import * as tar from "tar";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("Starting sandbox...");
const { baseUrl, cleanup } = await startDockerSandbox({ port: 3003 });

console.log("Creating sample files...");
const tmpDir = path.resolve(__dirname, "../.tmp-upload");
const projectDir = path.join(tmpDir, "my-project");
fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
fs.writeFileSync(path.join(projectDir, "README.md"), "# My Project\n\nUploaded via batch tar.\n");
fs.writeFileSync(path.join(projectDir, "src", "index.ts"), 'console.log("hello from uploaded project");\n');
fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "my-project", version: "1.0.0" }, null, 2) + "\n");
console.log("  Created 3 files in my-project/");

console.log("Uploading files via batch tar...");
const client = await SandboxAgent.connect({ baseUrl });

const tarPath = path.join(tmpDir, "upload.tar");
await tar.create({ file: tarPath, cwd: tmpDir }, ["my-project"]);
const tarBuffer = await fs.promises.readFile(tarPath);
const uploadResult = await client.uploadFsBatch(tarBuffer, { path: "/opt" });
console.log(`  Uploaded ${uploadResult.paths.length} files: ${uploadResult.paths.join(", ")}`);

// Cleanup temp files
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("Verifying uploaded files...");
const entries = await client.listFsEntries({ path: "/opt/my-project" });
console.log(`  Found ${entries.length} entries in /opt/my-project`);
for (const entry of entries) {
  console.log(`    ${entry.entryType === "directory" ? "d" : "-"} ${entry.name}`);
}

const readmeBytes = await client.readFsFile({ path: "/opt/my-project/README.md" });
const readmeText = new TextDecoder().decode(readmeBytes);
console.log(`  README.md content: ${readmeText.trim()}`);

console.log("Creating session...");
const session = await client.createSession({ agent: detectAgent(), cwd: "/opt/my-project" });
const sessionId = session.id;
console.log(`  UI: ${buildInspectorUrl({ baseUrl, sessionId })}`);
console.log('  Try: "read the README in /opt/my-project"');
console.log("  Press Ctrl+C to stop.");

const keepAlive = setInterval(() => {}, 60_000);
process.on("SIGINT", () => {
  clearInterval(keepAlive);
  cleanup().then(() => process.exit(0));
});
