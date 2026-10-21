/**
 * Hooks Example — writes agent hooks via the filesystem API, sends a prompt,
 * then verifies hooks fired by reading a shared log file.
 *
 * Usage:
 *   SANDBOX_AGENT_DEV=1 pnpm start   # from local source
 *   pnpm start                        # published image
 */

import { SandboxAgent } from "sandbox-agent";
import { buildInspectorUrl } from "@sandbox-agent/example-shared";
import { startDockerSandbox } from "@sandbox-agent/example-shared/docker";

process.on("unhandledRejection", (reason) => {
  console.error("  (background:", reason instanceof Error ? reason.message : JSON.stringify(reason), ")");
});

const HOOK_LOG = "/tmp/hooks.log";
const enc = new TextEncoder();
const dec = new TextDecoder();

async function writeText(client: SandboxAgent, path: string, content: string) {
  await client.writeFsFile({ path }, enc.encode(content));
}

// ---------------------------------------------------------------------------
// Per-agent hook setup — each writes to HOOK_LOG when triggered
// ---------------------------------------------------------------------------

async function setupClaudeHook(client: SandboxAgent) {
  // Claude reads hooks from ~/.claude/settings.json.
  // "Stop" fires every time Claude finishes a response.
  await client.mkdirFs({ path: "/root/.claude" });
  await writeText(client, "/root/.claude/settings.json", JSON.stringify({
    hooks: {
      Stop: [{
        matcher: "",
        hooks: [{ type: "command", command: `echo "claude-hook-fired" >> ${HOOK_LOG}` }],
      }],
    },
  }, null, 2));
}

async function setupCodexHook(client: SandboxAgent) {
  // Codex reads ~/.codex/config.toml.
  // "notify" runs an external program on agent-turn-complete.
  await client.mkdirFs({ path: "/root/.codex" });
  await writeText(client, "/root/.codex/config.toml",
    `notify = ["/root/.codex/notify-hook.sh"]\n`);
  await writeText(client, "/root/.codex/notify-hook.sh",
    `#!/bin/bash\necho "codex-hook-fired" >> ${HOOK_LOG}\n`);
  await client.runProcess({ command: "chmod", args: ["+x", "/root/.codex/notify-hook.sh"] });
}

async function setupOpencodeHook(client: SandboxAgent) {
  // OpenCode loads plugins listed in opencode.json.
  // The plugin appends to HOOK_LOG when loaded.
  const plugin = [
    `import { appendFileSync } from "node:fs";`,
    `export const HookPlugin = async () => {`,
    `  appendFileSync("${HOOK_LOG}", "opencode-hook-fired\\n");`,
    `  return {};`,
    `};`,
  ].join("\n");

  const config = JSON.stringify({ plugin: ["./plugins/hook.mjs"] }, null, 2);

  for (const dir of ["/root/.config/opencode", "/root/.opencode"]) {
    await client.mkdirFs({ path: `${dir}/plugins` });
    await writeText(client, `${dir}/plugins/hook.mjs`, plugin);
    await writeText(client, `${dir}/opencode.json`, config);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("Starting sandbox...");
const { baseUrl, cleanup } = await startDockerSandbox({ port: 3004 });
const client = await SandboxAgent.connect({ baseUrl });

const agents = ["claude", "codex", "opencode"] as const;
for (const agent of agents) {
  process.stdout.write(`Installing ${agent}... `);
  try { await client.installAgent(agent); console.log("done"); }
  catch { console.log("skipped"); }
}

console.log("\nWriting hooks...");
await setupClaudeHook(client);
await setupCodexHook(client);
await setupOpencodeHook(client);
await writeText(client, HOOK_LOG, "");

console.log("Sending prompts...\n");
for (const agent of agents) {
  process.stdout.write(`  ${agent.padEnd(9)}`);
  try {
    const session = await client.createSession({ agent, sessionInit: { cwd: "/root", mcpServers: [] } });
    console.log(buildInspectorUrl({ baseUrl, sessionId: session.id }));
    process.stdout.write(`           prompting... `);
    await session.prompt([{ type: "text", text: "Say exactly: hello world" }]);
    console.log("done");
  } catch (err: unknown) {
    console.log(err instanceof Error ? err.message : JSON.stringify(err));
  }
  await new Promise((r) => setTimeout(r, 2000));
}

console.log("\nHook log:");
try {
  const log = dec.decode(await client.readFsFile({ path: HOOK_LOG }));
  const lines = log.trim().split("\n").filter(Boolean);
  for (const line of lines) console.log(`  + ${line}`);
  if (!lines.length) console.log("  (empty)");

  const has = (s: string) => lines.some((l) => l.includes(s));
  console.log(`\n  Claude=${has("claude") ? "PASS" : "FAIL"}  Codex=${has("codex") ? "PASS" : "FAIL"}  OpenCode=${has("opencode") ? "PASS" : "FAIL"}`);
} catch {
  console.log("  (file not found)");
}

console.log("\nCtrl+C to stop.");
const keepAlive = setInterval(() => {}, 60_000);
process.on("SIGINT", () => { clearInterval(keepAlive); cleanup().then(() => process.exit(0)); });
