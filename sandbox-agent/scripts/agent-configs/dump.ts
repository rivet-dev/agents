/**
 * Fetches model/mode/thought-level lists from agent backends and writes them
 * to resources/.
 *
 * Usage:
 *   npx tsx dump.ts                      # Dump all agents
 *   npx tsx dump.ts --agent claude       # Dump only Claude
 *   npx tsx dump.ts --agent opencode --opencode-url http://127.0.0.1:4096
 *
 * Sources:
 *   Claude  — Anthropic API (GET /v1/models?beta=true). Extracts API key from
 *             ANTHROPIC_API_KEY env. Falls back to aliases (default, sonnet, opus, haiku)
 *             on 401/403 or missing credentials.
 *             Modes are hardcoded (discovered by ACP session/set_mode probing).
 *             Claude does not implement session/set_config_option at all.
 *   Codex   — Codex app-server JSON-RPC (model/list over stdio, paginated).
 *             Modes and thought levels are hardcoded (discovered from Codex's
 *             ACP session/new configOptions response).
 *   OpenCode — OpenCode HTTP server (GET {base_url}/config/providers, fallback /provider).
 *             Model IDs formatted as {provider_id}/{model_id}. Modes hardcoded.
 *   Cursor  — `cursor-agent models` CLI command. Parses the text output.
 *
 * Derivation of hardcoded values:
 *   When agents don't expose modes/thought levels through their model listing
 *   APIs, we discover them by ACP probing against a running sandbox-agent server:
 *   1. Create an ACP session via session/new and inspect the configOptions and
 *      modes fields in the response.
 *   2. Test session/set_mode with candidate mode IDs.
 *   3. Test session/set_config_option with candidate config IDs and values.
 *   See /tmp/probe-agents.sh or /tmp/probe-agents.ts for example probe scripts.
 *
 * Output goes to resources/ alongside this script. These JSON files are committed
 * to the repo and included in the sandbox-agent binary at compile time via include_str!.
 */

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ModelEntry {
  id: string;
  name: string;
}

interface ModeEntry {
  id: string;
  name: string;
  description?: string;
}

interface ThoughtLevelEntry {
  id: string;
  name: string;
  description?: string;
}

interface AgentModelList {
  defaultModel: string;
  models: ModelEntry[];
  defaultMode?: string;
  modes?: ModeEntry[];
  defaultThoughtLevel?: string;
  thoughtLevels?: ThoughtLevelEntry[];
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const agentFilter: string[] = [];
let opencodeUrl: string | undefined;
let codexPath: string | undefined;
let cursorPath: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--agent" && args[i + 1]) {
    agentFilter.push(args[++i]);
  } else if (args[i] === "--opencode-url" && args[i + 1]) {
    opencodeUrl = args[++i];
  } else if (args[i] === "--codex-path" && args[i + 1]) {
    codexPath = args[++i];
  } else if (args[i] === "--cursor-path" && args[i + 1]) {
    cursorPath = args[++i];
  }
}

const RESOURCES_DIR = path.join(__dirname, "resources");
const agents = agentFilter.length ? agentFilter : ["claude", "codex", "opencode", "cursor"];

async function main() {
  fs.mkdirSync(RESOURCES_DIR, { recursive: true });

  for (const agent of agents) {
    try {
      switch (agent) {
        case "claude":
          await dumpClaude();
          break;
        case "codex":
          await dumpCodex();
          break;
        case "opencode":
          await dumpOpencode();
          break;
        case "cursor":
          await dumpCursor();
          break;
        default:
          console.error(`Unknown agent: ${agent}`);
      }
    } catch (err) {
      console.error(`  Error for ${agent}: ${err}`);
    }
  }
}

function writeList(agent: string, list: AgentModelList) {
  const filePath = path.join(RESOURCES_DIR, `${agent}.json`);
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2) + "\n");
  const modeCount = list.modes?.length ?? 0;
  const thoughtCount = list.thoughtLevels?.length ?? 0;
  const extras = [modeCount ? `${modeCount} modes` : null, thoughtCount ? `${thoughtCount} thought levels` : null].filter(Boolean).join(", ");
  console.log(`  Wrote ${list.models.length} models${extras ? `, ${extras}` : ""} to ${filePath} (default: ${list.defaultModel})`);
}

// ─── Claude ───────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/models?beta=true";
const ANTHROPIC_VERSION = "2023-06-01";

// Claude v0.20.0 (@zed-industries/claude-agent-acp) returns configOptions and
// modes from session/new. Models and modes below match the ACP adapter source.
// Note: `opus` is gated by subscription — it may not appear in session/new for
// all credentials, but exists in the SDK model list. Thought levels are supported
// by the Claude SDK (effort levels: low/medium/high/max for opus-4-6 and
// sonnet-4-6) but the ACP adapter does not expose them as configOptions yet.
const CLAUDE_FALLBACK: AgentModelList = {
  defaultModel: "default",
  models: [
    { id: "default", name: "Default" },
    { id: "sonnet", name: "Sonnet" },
    { id: "opus", name: "Opus" },
    { id: "haiku", name: "Haiku" },
  ],
  defaultMode: "default",
  modes: [
    { id: "default", name: "Default" },
    { id: "acceptEdits", name: "Accept Edits" },
    { id: "plan", name: "Plan" },
    { id: "dontAsk", name: "Don't Ask" },
    { id: "bypassPermissions", name: "Bypass Permissions" },
  ],
};

async function dumpClaude() {
  console.log("Fetching Claude models...");
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.log("  No ANTHROPIC_API_KEY set, using fallback aliases");
    writeList("claude", CLAUDE_FALLBACK);
    return;
  }

  const headers: Record<string, string> = {
    "anthropic-version": ANTHROPIC_VERSION,
    "x-api-key": apiKey,
  };

  const response = await fetch(ANTHROPIC_API_URL, { headers });
  if (response.status === 401 || response.status === 403) {
    console.log(`  API returned ${response.status}, using fallback aliases`);
    writeList("claude", CLAUDE_FALLBACK);
    return;
  }
  if (!response.ok) {
    throw new Error(`Anthropic API returned ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as {
    data?: Array<{
      id: string;
      display_name?: string;
      created_at?: string;
    }>;
  };
  const data = body.data ?? [];

  let defaultModel: string | undefined;
  let defaultCreated: string | undefined;
  const models: ModelEntry[] = [];

  for (const item of data) {
    models.push({
      id: item.id,
      name: item.display_name ?? item.id,
    });
    if (item.created_at) {
      if (!defaultCreated || item.created_at > defaultCreated) {
        defaultCreated = item.created_at;
        defaultModel = item.id;
      }
    }
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

  if (models.length === 0) {
    console.log("  API returned empty model list, using fallback aliases");
    writeList("claude", CLAUDE_FALLBACK);
    return;
  }

  writeList("claude", {
    defaultModel: defaultModel ?? models[0]?.id ?? "default",
    models,
    // Modes from Claude ACP adapter v0.20.0 session/new response.
    defaultMode: "default",
    modes: CLAUDE_FALLBACK.modes,
  });
}

// ─── Codex ────────────────────────────────────────────────────────────────────

async function dumpCodex() {
  console.log("Fetching Codex models...");
  const binary = codexPath ?? findBinary("codex");
  if (!binary) {
    throw new Error("codex binary not found (set --codex-path or add to PATH)");
  }
  console.log(`  Using binary: ${binary}`);

  const child = spawn(binary, ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
  });

  const rl = readline.createInterface({ input: child.stdout! });

  const models: ModelEntry[] = [];
  let defaultModel: string | undefined;
  const seen = new Set<string>();
  let cursor: string | null = null;
  let requestId = 1;

  try {
    // Initialize handshake (required before model/list)
    const initRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId++,
      method: "initialize",
      params: {
        clientInfo: {
          name: "agent-configs-dump",
          title: "agent-configs-dump",
          version: "1.0.0",
        },
      },
    });
    child.stdin!.write(initRequest + "\n");
    const initLine = await readLineWithTimeout(rl, 10_000);
    const initValue = JSON.parse(initLine);
    if (initValue.error) {
      throw new Error(`Codex initialize error: ${JSON.stringify(initValue.error)}`);
    }
    // Send initialized notification
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");

    while (true) {
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: requestId++,
        method: "model/list",
        params: { cursor, limit: null },
      });
      child.stdin!.write(request + "\n");

      const line = await readLineWithTimeout(rl, 10_000);
      const value = JSON.parse(line);

      if (value.error) {
        throw new Error(`Codex error: ${JSON.stringify(value.error)}`);
      }

      const result = value.result ?? value;
      const data = result.data ?? [];

      for (const item of data) {
        const modelId = item.model ?? item.id;
        if (!modelId || seen.has(modelId)) continue;
        seen.add(modelId);

        models.push({
          id: modelId,
          name: item.displayName ?? modelId,
        });

        if (!defaultModel && item.isDefault) {
          defaultModel = modelId;
        }
      }

      const nextCursor = result.nextCursor;
      if (!nextCursor) break;
      cursor = nextCursor;
    }
  } finally {
    child.kill();
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

  // Codex modes and thought levels come from its ACP session/new configOptions
  // response (category: "mode" and category: "thought_level"). The model/list
  // RPC only returns models, so modes/thought levels are hardcoded here based
  // on probing Codex's session/new response.
  writeList("codex", {
    defaultModel: defaultModel ?? models[0]?.id ?? "",
    models,
    defaultMode: "read-only",
    modes: [
      {
        id: "read-only",
        name: "Read Only",
        description: "Codex can read files in the current workspace. Approval is required to edit files or access the internet.",
      },
      {
        id: "auto",
        name: "Default",
        description:
          "Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files.",
      },
      {
        id: "full-access",
        name: "Full Access",
        description: "Codex can edit files outside this workspace and access the internet without asking for approval.",
      },
    ],
    defaultThoughtLevel: "high",
    thoughtLevels: [
      { id: "low", name: "Low", description: "Fast responses with lighter reasoning" },
      { id: "medium", name: "Medium", description: "Balances speed and reasoning depth for everyday tasks" },
      { id: "high", name: "High", description: "Greater reasoning depth for complex problems" },
      { id: "xhigh", name: "Xhigh", description: "Extra high reasoning depth for complex problems" },
    ],
  });
}

function readLineWithTimeout(rl: readline.Interface, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("readline timeout"));
    }, timeoutMs);
    rl.once("line", (line) => {
      clearTimeout(timer);
      resolve(line);
    });
    rl.once("close", () => {
      clearTimeout(timer);
      reject(new Error("readline closed"));
    });
  });
}

// ─── OpenCode ─────────────────────────────────────────────────────────────────

async function dumpOpencode() {
  const baseUrl = opencodeUrl ?? process.env.OPENCODE_URL;
  if (!baseUrl) {
    console.log("  Skipped: --opencode-url not provided (set OPENCODE_URL or pass --opencode-url)");
    return;
  }
  console.log(`Fetching OpenCode models from ${baseUrl}...`);

  const endpoints = [`${baseUrl}/config/providers`, `${baseUrl}/provider`];

  for (const url of endpoints) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.log(`  ${url} returned ${response.status}`);
        continue;
      }
      const value = await response.json();
      const list = parseOpencodeProviders(value as Record<string, unknown>);
      if (list) {
        writeList("opencode", list);
        return;
      }
      console.log(`  ${url} returned no parseable models`);
    } catch (err) {
      console.log(`  ${url} failed: ${err}`);
    }
  }

  throw new Error("OpenCode model endpoints unavailable");
}

function parseOpencodeProviders(value: Record<string, unknown>): AgentModelList | null {
  const providers = ((value.providers as unknown[]) ?? (value.all as unknown[])) as
    | Array<{
        id: string;
        name?: string;
        models?: Record<string, { id?: string; name?: string }>;
      }>
    | undefined;
  if (!providers) return null;

  const defaultMap = (value.default as Record<string, string>) ?? {};
  const models: ModelEntry[] = [];
  const providerOrder: string[] = [];

  for (const provider of providers) {
    if (!provider.id) continue;
    providerOrder.push(provider.id);
    if (!provider.models) continue;
    const providerName = provider.name ?? provider.id;
    for (const [key, model] of Object.entries(provider.models)) {
      const modelId = model.id ?? key;
      const modelName = model.name ?? modelId;
      models.push({
        id: `${provider.id}/${modelId}`,
        name: `${providerName}/${modelName}`,
      });
    }
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

  let defaultModel: string | undefined;
  for (const providerId of providerOrder) {
    if (defaultMap[providerId]) {
      defaultModel = `${providerId}/${defaultMap[providerId]}`;
      break;
    }
  }
  if (!defaultModel) {
    defaultModel = models[0]?.id;
  }

  return {
    defaultModel: defaultModel ?? "",
    models,
    // OpenCode modes are not available via /config/providers — hardcode known ones
    defaultMode: "build",
    modes: [
      {
        id: "build",
        name: "Build",
        description: "The default agent. Executes tools based on configured permissions.",
      },
      {
        id: "plan",
        name: "Plan",
        description: "Plan mode. Disallows all edit tools.",
      },
    ],
  };
}

// ─── Cursor ───────────────────────────────────────────────────────────────────

async function dumpCursor() {
  console.log("Fetching Cursor models...");
  const binary = cursorPath ?? findBinary("cursor-agent");
  if (!binary) {
    throw new Error("cursor-agent binary not found (set --cursor-path or add to PATH)");
  }
  console.log(`  Using binary: ${binary}`);

  const output = execSync(`${binary} models`, {
    encoding: "utf-8",
    timeout: 15_000,
  });

  const models: ModelEntry[] = [];
  let defaultModel: string | undefined;

  // Parse lines like: "model-id - Display Name  (current)" or "(default)"
  for (const rawLine of output.split("\n")) {
    // Strip ANSI escape codes
    const line = rawLine.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\[?[0-9;]*[A-Za-z]/g, "").trim();
    const match = line.match(/^(\S+)\s+-\s+(.+?)(?:\s+\((current|default)\))?$/);
    if (!match) continue;
    const [, id, name, tag] = match;
    models.push({ id, name: name.trim() });
    if (tag === "current" || tag === "default") {
      defaultModel = id;
    }
  }

  if (models.length === 0) {
    throw new Error("cursor-agent models returned no parseable models");
  }

  writeList("cursor", {
    defaultModel: defaultModel ?? models[0]?.id ?? "auto",
    models,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findBinary(name: string): string | null {
  // Check sandbox-agent install dir
  const installDir = path.join(process.env.HOME ?? "", ".local", "share", "sandbox-agent", "bin");
  const installed = path.join(installDir, name);
  if (fs.existsSync(installed)) return installed;

  // Search PATH
  try {
    return execSync(`which ${name}`, { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
