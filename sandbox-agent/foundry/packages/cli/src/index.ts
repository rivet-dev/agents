#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { AgentTypeSchema, CreateTaskInputSchema, type TaskRecord } from "@sandbox-agent/foundry-shared";
import { readBackendMetadata, createBackendClientFromConfig, formatRelativeAge, groupTaskStatus, summarizeTasks } from "@sandbox-agent/foundry-client";
import { ensureBackendRunning, getBackendStatus, parseBackendPort, stopBackend } from "./backend/manager.js";
import { writeStderr, writeStdout } from "./io.js";
import { openEditorForTask } from "./task-editor.js";
import { spawnCreateTmuxWindow } from "./tmux.js";
import { loadConfig, resolveOrganization, saveConfig } from "./organization/config.js";

async function ensureBunRuntime(): Promise<void> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    return;
  }

  const preferred = process.env.HF_BUN?.trim();
  const candidates = [preferred, `${homedir()}/.bun/bin/bun`, "bun"].filter((item): item is string => Boolean(item && item.length > 0));

  for (const candidate of candidates) {
    const command = candidate;
    const canExec = command === "bun" || existsSync(command);
    if (!canExec) {
      continue;
    }

    const child = spawnSync(command, [process.argv[1] ?? "", ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
    });

    if (child.error) {
      continue;
    }

    const code = child.status ?? 1;
    process.exit(code);
  }

  throw new Error("hf requires Bun runtime. Set HF_BUN or install Bun at ~/.bun/bin/bun.");
}

async function runTuiCommand(config: ReturnType<typeof loadConfig>, organizationId: string): Promise<void> {
  const mod = await import("./tui.js");
  await mod.runTui(config, organizationId);
}

function readOption(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseIntOption(value: string | undefined, fallback: number, label: string): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (!item) {
      continue;
    }

    if (item.startsWith("--")) {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        i += 1;
      }
      continue;
    }
    out.push(item);
  }
  return out;
}

function normalizeRepoSelector(value: string): string {
  let normalized = value.trim();
  if (!normalized) {
    return "";
  }

  normalized = normalized.replace(/\/+$/, "");
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    return `https://github.com/${normalized}.git`;
  }

  if (/^(?:www\.)?github\.com\/.+/i.test(normalized)) {
    normalized = `https://${normalized.replace(/^www\./i, "")}`;
  }

  try {
    if (/^https?:\/\//i.test(normalized)) {
      const url = new URL(normalized);
      const hostname = url.hostname.replace(/^www\./i, "");
      if (hostname.toLowerCase() === "github.com") {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length >= 2) {
          return `${url.protocol}//${hostname}/${parts[0]}/${(parts[1] ?? "").replace(/\.git$/i, "")}.git`;
        }
      }
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    // Keep the selector as-is for matching below.
  }

  return normalized;
}

function githubRepoFullNameFromSelector(value: string): string | null {
  const normalized = normalizeRepoSelector(value);
  try {
    const url = new URL(normalized);
    if (url.hostname.replace(/^www\./i, "").toLowerCase() !== "github.com") {
      return null;
    }
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    return `${parts[0]}/${(parts[1] ?? "").replace(/\.git$/i, "")}`;
  } catch {
    return null;
  }
}

async function resolveImportedRepo(
  client: ReturnType<typeof createBackendClientFromConfig>,
  organizationId: string,
  repoSelector: string,
): Promise<Awaited<ReturnType<typeof client.listRepos>>[number]> {
  const selector = repoSelector.trim();
  if (!selector) {
    throw new Error("Missing required --repo <repo-id|git-remote|owner/repo>");
  }

  const normalizedSelector = normalizeRepoSelector(selector);
  const selectorFullName = githubRepoFullNameFromSelector(selector);
  const repos = await client.listRepos(organizationId);
  const match = repos.find((repo) => {
    if (repo.repoId === selector) {
      return true;
    }
    if (normalizeRepoSelector(repo.remoteUrl) === normalizedSelector) {
      return true;
    }
    const repoFullName = githubRepoFullNameFromSelector(repo.remoteUrl);
    return Boolean(selectorFullName && repoFullName && repoFullName === selectorFullName);
  });

  if (!match) {
    throw new Error(
      `Repo not available in organization ${organizationId}: ${repoSelector}. Create it in GitHub first, then sync repos in Foundry before running hf create.`,
    );
  }

  return match;
}

function printUsage(): void {
  writeStdout(`
Usage:
  hf backend start [--host HOST] [--port PORT]
  hf backend stop [--host HOST] [--port PORT]
  hf backend status
  hf backend inspect
  hf status [--organization ORG] [--json]
  hf history [--organization ORG] [--limit N] [--branch NAME] [--task ID] [--json]
  hf organization use <name>
  hf tui [--organization ORG]

  hf create [task] [--organization ORG] --repo <repo-id|git-remote|owner/repo> [--name NAME|--branch NAME] [--title TITLE] [--agent claude|codex] [--on BRANCH]
  hf list [--organization ORG] [--format table|json] [--full]
  hf switch [task-id | -] [--organization ORG]
  hf attach <task-id> [--organization ORG]
  hf merge <task-id> [--organization ORG]
  hf archive <task-id> [--organization ORG]
  hf push <task-id> [--organization ORG]
  hf sync <task-id> [--organization ORG]
  hf kill <task-id> [--organization ORG] [--delete-branch] [--abandon]
  hf prune [--organization ORG] [--dry-run] [--yes]
  hf statusline [--organization ORG] [--format table|claude-code]
  hf db path
  hf db nuke

Tips:
  hf status --help    Show status output format and examples
  hf history --help   Show history output format and examples
  hf switch -         Switch to most recently updated task
`);
}

function printStatusUsage(): void {
  writeStdout(`
Usage:
  hf status [--organization ORG] [--json]

Text Output:
  organization=<organization-id>
  backend running=<true|false> pid=<pid|unknown> version=<version|unknown>
  tasks total=<number>
  status queued=<n> running=<n> idle=<n> archived=<n> killed=<n> error=<n>
  sandboxProviders <provider-id>=<count> ...
  sandboxProviders -

JSON Output:
  {
    "organizationId": "default",
    "backend": { ...backend status object... },
    "tasks": {
      "total": 4,
      "byStatus": { "queued": 0, "running": 1, "idle": 2, "archived": 1, "killed": 0, "error": 0 },
      "byProvider": { "local": 4 }
    }
  }
`);
}

function printHistoryUsage(): void {
  writeStdout(`
Usage:
  hf history [--organization ORG] [--limit N] [--branch NAME] [--task ID] [--json]

Text Output:
  <iso8601>\t<event-kind>\t<branch|task|repo|->\t<payload-json>
  <iso8601>\t<event-kind>\t<branch|task|repo|->\t<payload-json...>
  no events

Notes:
  - payload is truncated to 120 characters in text mode.
  - --limit defaults to 20.

JSON Output:
  [
    {
      "id": "...",
      "organizationId": "default",
      "kind": "task.created",
      "taskId": "...",
      "repoId": "...",
      "branchName": "feature/foo",
      "payloadJson": "{\\"sandboxProviderId\\":\\"local\\"}",
      "createdAt": 1770607522229
    }
  ]
`);
}

async function listDetailedTasks(client: ReturnType<typeof createBackendClientFromConfig>, organizationId: string): Promise<TaskRecord[]> {
  const rows = await client.listTasks(organizationId);
  return await Promise.all(rows.map(async (row) => await client.getTask(organizationId, row.taskId)));
}

async function handleBackend(args: string[]): Promise<void> {
  const sub = args[0] ?? "start";
  const config = loadConfig();
  const host = readOption(args, "--host") ?? config.backend.host;
  const port = parseBackendPort(readOption(args, "--port"), config.backend.port);
  const backendConfig = {
    ...config,
    backend: {
      ...config.backend,
      host,
      port,
    },
  };

  if (sub === "start") {
    await ensureBackendRunning(backendConfig);
    const status = await getBackendStatus(host, port);
    const pid = status.pid ?? "unknown";
    const version = status.version ?? "unknown";
    const stale = status.running && !status.versionCurrent ? " [outdated]" : "";
    writeStdout(`running=true pid=${pid} version=${version}${stale} log=${status.logPath}`);
    return;
  }

  if (sub === "stop") {
    await stopBackend(host, port);
    writeStdout(`running=false host=${host} port=${port}`);
    return;
  }

  if (sub === "status") {
    const status = await getBackendStatus(host, port);
    const pid = status.pid ?? "unknown";
    const version = status.version ?? "unknown";
    const stale = status.running && !status.versionCurrent ? " [outdated]" : "";
    writeStdout(`running=${status.running} pid=${pid} version=${version}${stale} host=${host} port=${port} log=${status.logPath}`);
    return;
  }

  if (sub === "inspect") {
    await ensureBackendRunning(backendConfig);
    const metadata = await readBackendMetadata({
      endpoint: `http://${host}:${port}/v1/rivet`,
      timeoutMs: 4_000,
    });
    const managerEndpoint = metadata.clientEndpoint ?? `http://${host}:${port}`;
    const inspectorUrl = `https://inspect.rivet.dev?u=${encodeURIComponent(managerEndpoint)}`;
    const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
    spawnSync(openCmd, [inspectorUrl], { stdio: "ignore" });
    writeStdout(inspectorUrl);
    return;
  }

  throw new Error(`Unknown backend subcommand: ${sub}`);
}

async function handleOrganization(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "use") {
    throw new Error("Usage: hf organization use <name>");
  }

  const name = args[1];
  if (!name) {
    throw new Error("Missing organization name");
  }

  const config = loadConfig();
  config.organization.default = name;
  saveConfig(config);

  const client = createBackendClientFromConfig(config);
  try {
    await client.useOrganization(name);
  } catch {
    // Backend may not be running yet. Config is already updated.
  }

  writeStdout(`organization=${name}`);
}

async function handleList(args: string[]): Promise<void> {
  const config = loadConfig();
  const organizationId = resolveOrganization(readOption(args, "--organization"), config);
  const format = readOption(args, "--format") ?? "table";
  const full = hasFlag(args, "--full");
  const client = createBackendClientFromConfig(config);
  const rows = await listDetailedTasks(client, organizationId);

  if (format === "json") {
    writeStdout(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    writeStdout("no tasks");
    return;
  }

  for (const row of rows) {
    const age = formatRelativeAge(row.updatedAt);
    let line = `${row.taskId}\t${row.branchName}\t${row.status}\t${row.sandboxProviderId}\t${age}`;
    if (full) {
      const preview = row.task.length > 60 ? `${row.task.slice(0, 57)}...` : row.task;
      line += `\t${row.title}\t${preview}\t${row.activeSessionId ?? "-"}\t${row.activeSandboxId ?? "-"}`;
    }
    writeStdout(line);
  }
}

async function handlePush(args: string[]): Promise<void> {
  const taskId = positionals(args)[0];
  if (!taskId) {
    throw new Error("Missing task id for push");
  }
  const config = loadConfig();
  const organizationId = resolveOrganization(readOption(args, "--organization"), config);
  const client = createBackendClientFromConfig(config);
  await client.runAction(organizationId, taskId, "push");
  writeStdout("ok");
}

async function handleSync(args: string[]): Promise<void> {
  const taskId = positionals(args)[0];
  if (!taskId) {
    throw new Error("Missing task id for sync");
  }
  const config = loadConfig();
  const organizationId = resolveOrganization(readOption(args, "--organization"), config);
  const client = createBackendClientFromConfig(config);
  await client.runAction(organizationId, taskId, "sync");
  writeStdout("ok");
}

async function handleKill(args: string[]): Promise<void> {
  const taskId = positionals(args)[0];
  if (!taskId) {
    throw new Error("Missing task id for kill");
  }
  const config = loadConfig();
  const organizationId = resolveOrganization(readOption(args, "--organization"), config);
  const deleteBranch = hasFlag(args, "--delete-branch");
  const abandon = hasFlag(args, "--abandon");

  if (deleteBranch) {
    writeStdout("info: --delete-branch flag set, branch will be deleted after kill");
  }
  if (abandon) {
    writeStdout("info: --abandon flag set, Graphite abandon will be attempted");
  }

  const client = createBackendClientFromConfig(config);
  await client.runAction(organizationId, taskId, "kill");
  writeStdout("ok");
}

async function handlePrune(args: string[]): Promise<void> {
  const config = loadConfig();
  const organizationId = resolveOrganization(readOption(args, "--organization"), config);
  const dryRun = hasFlag(args, "--dry-run");
  const yes = hasFlag(args, "--yes");
  const client = createBackendClientFromConfig(config);
  const rows = await listDetailedTasks(client, organizationId);
  const prunable = rows.filter((r) => r.status === "archived" || r.status === "killed");

  if (prunable.length === 0) {
    writeStdout("nothing to prune");
    return;
  }

  for (const row of prunable) {
    const age = formatRelativeAge(row.updatedAt);
    writeStdout(`${dryRun ? "[dry-run] " : ""}${row.taskId}\t${row.branchName}\t${row.status}\t${age}`);
  }

  if (dryRun) {
    writeStdout(`\n${prunable.length} task(s) would be pruned`);
    return;
  }

  if (!yes) {
    writeStdout("\nnot yet implemented: auto-pruning requires confirmation");
    return;
  }

  writeStdout(`\n${prunable.length} task(s) would be pruned (pruning not yet implemented)`);
}

async function handleStatusline(args: string[]): Promise<void> {
  const config = loadConfig();
  const organizationId = resolveOrganization(readOption(args, "--organization"), config);
  const format = readOption(args, "--format") ?? "table";
  const client = createBackendClientFromConfig(config);
  const rows = await listDetailedTasks(client, organizationId);
  const summary = summarizeTasks(rows);
  const running = summary.byStatus.running;
  const idle = summary.byStatus.idle;
  const errorCount = summary.byStatus.error;

  if (format === "claude-code") {
    writeStdout(`hf:${running}R/${idle}I/${errorCount}E`);
    return;
  }

  writeStdout(`running=${running} idle=${idle} error=${errorCount}`);
}

async function handleDb(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "path") {
    const config = loadConfig();
    const dbPath = config.backend.dbPath.replace(/^~/, homedir());
    writeStdout(dbPath);
    return;
  }

  if (sub === "nuke") {
    writeStdout("WARNING: hf db nuke would delete the entire database. This is a placeholder and does not delete anything.");
    return;
  }

  throw new Error("Usage: hf db path | hf db nuke");
}

async function waitForTaskReady(
  client: ReturnType<typeof createBackendClientFromConfig>,
  organizationId: string,
  taskId: string,
  timeoutMs: number,
): Promise<TaskRecord> {
  const start = Date.now();
  let delayMs = 250;

  for (;;) {
    const record = await client.getTask(organizationId, taskId);
    const hasName = Boolean(record.branchName && record.title);
    const hasSandbox = Boolean(record.activeSandboxId);

    if (record.status === "error") {
      throw new Error(`task entered error state while provisioning: ${taskId}`);
    }
    if (hasName && hasSandbox) {
      return record;
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for task provisioning: ${taskId}`);
    }

    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(Math.round(delayMs * 1.5), 2_000);
  }
}

async function handleCreate(args: string[]): Promise<void> {
  const config = loadConfig();
  const organizationId = resolveOrganization(readOption(args, "--organization"), config);

  const repoSelector = readOption(args, "--repo");
  if (!repoSelector) {
    throw new Error("Missing required --repo <repo-id|git-remote|owner/repo>");
  }
  const explicitBranchName = readOption(args, "--name") ?? readOption(args, "--branch");
  const explicitTitle = readOption(args, "--title");

  const agentRaw = readOption(args, "--agent");
  const agentType = agentRaw ? AgentTypeSchema.parse(agentRaw) : undefined;
  const onBranch = readOption(args, "--on");

  const taskFromArgs = positionals(args).join(" ").trim();
  const taskPrompt = taskFromArgs || openEditorForTask();

  const client = createBackendClientFromConfig(config);
  const repo = await resolveImportedRepo(client, organizationId, repoSelector);

  const payload = CreateTaskInputSchema.parse({
    organizationId,
    repoId: repo.repoId,
    task: taskPrompt,
    explicitTitle: explicitTitle || undefined,
    explicitBranchName: explicitBranchName || undefined,
    agentType,
    onBranch,
  });

  const created = await client.createTask(payload);
  const createdTask = await waitForTaskReady(client, organizationId, created.taskId, 180_000);
  const switched = await client.switchTask(organizationId, createdTask.taskId);
  const attached = await client.attachTask(organizationId, createdTask.taskId);

  writeStdout(`Branch:   ${createdTask.branchName ?? "-"}`);
  writeStdout(`Task:  ${createdTask.taskId}`);
  writeStdout(`Provider: ${createdTask.sandboxProviderId}`);
  writeStdout(`Session:  ${attached.sessionId ?? "none"}`);
  writeStdout(`Target:   ${switched.switchTarget || attached.target}`);
  writeStdout(`Title:    ${createdTask.title ?? "-"}`);

  const tmuxResult = spawnCreateTmuxWindow({
    branchName: createdTask.branchName ?? createdTask.taskId,
    targetPath: switched.switchTarget || attached.target,
    sessionId: attached.sessionId,
  });

  if (tmuxResult.created) {
    writeStdout(`Window:   created (${createdTask.branchName})`);
    return;
  }

  writeStdout("");
  writeStdout(`Run: hf switch ${createdTask.taskId}`);
  if ((switched.switchTarget || attached.target).startsWith("/")) {
    writeStdout(`cd ${switched.switchTarget || attached.target}`);
  }
}

async function handleTui(args: string[]): Promise<void> {
  const config = loadConfig();
  const organizationId = resolveOrganization(readOption(args, "--organization"), config);
  await runTuiCommand(config, organizationId);
}

async function handleStatus(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printStatusUsage();
    return;
  }

  const config = loadConfig();
  const organizationId = resolveOrganization(readOption(args, "--organization"), config);
  const client = createBackendClientFromConfig(config);
  const backendStatus = await getBackendStatus(config.backend.host, config.backend.port);
  const rows = await listDetailedTasks(client, organizationId);
  const summary = summarizeTasks(rows);

  if (hasFlag(args, "--json")) {
    writeStdout(
      JSON.stringify(
        {
          organizationId,
          backend: backendStatus,
          tasks: {
            total: summary.total,
            byStatus: summary.byStatus,
            byProvider: summary.byProvider,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  writeStdout(`organization=${organizationId}`);
  writeStdout(`backend running=${backendStatus.running} pid=${backendStatus.pid ?? "unknown"} version=${backendStatus.version ?? "unknown"}`);
  writeStdout(`tasks total=${summary.total}`);
  writeStdout(
    `status queued=${summary.byStatus.queued} running=${summary.byStatus.running} idle=${summary.byStatus.idle} archived=${summary.byStatus.archived} killed=${summary.byStatus.killed} error=${summary.byStatus.error}`,
  );
  const providerSummary = Object.entries(summary.byProvider)
    .map(([provider, count]) => `${provider}=${count}`)
    .join(" ");
  writeStdout(`sandboxProviders ${providerSummary || "-"}`);
}

async function handleHistory(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printHistoryUsage();
    return;
  }

  const config = loadConfig();
  const organizationId = resolveOrganization(readOption(args, "--organization"), config);
  const limit = parseIntOption(readOption(args, "--limit"), 20, "limit");
  const branch = readOption(args, "--branch");
  const taskId = readOption(args, "--task");
  const client = createBackendClientFromConfig(config);
  const rows = await client.listHistory({
    organizationId,
    limit,
    branch: branch || undefined,
    taskId: taskId || undefined,
  });

  if (hasFlag(args, "--json")) {
    writeStdout(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    writeStdout("no events");
    return;
  }

  for (const row of rows) {
    const ts = new Date(row.createdAt).toISOString();
    const target = row.branchName || row.taskId || row.repoId || "-";
    let payload = row.payloadJson;
    if (payload.length > 120) {
      payload = `${payload.slice(0, 117)}...`;
    }
    writeStdout(`${ts}\t${row.kind}\t${target}\t${payload}`);
  }
}

async function handleSwitchLike(cmd: string, args: string[]): Promise<void> {
  let taskId = positionals(args)[0];
  if (!taskId && cmd === "switch") {
    await handleTui(args);
    return;
  }

  if (!taskId) {
    throw new Error(`Missing task id for ${cmd}`);
  }

  const config = loadConfig();
  const organizationId = resolveOrganization(readOption(args, "--organization"), config);
  const client = createBackendClientFromConfig(config);

  if (cmd === "switch" && taskId === "-") {
    const rows = await listDetailedTasks(client, organizationId);
    const active = rows.filter((r) => {
      const group = groupTaskStatus(r.status);
      return group === "running" || group === "idle" || group === "queued";
    });
    const sorted = active.sort((a, b) => b.updatedAt - a.updatedAt);
    const target = sorted[0];
    if (!target) {
      throw new Error("No active tasks to switch to");
    }
    taskId = target.taskId;
  }

  if (cmd === "switch") {
    const result = await client.switchTask(organizationId, taskId);
    writeStdout(`cd ${result.switchTarget}`);
    return;
  }

  if (cmd === "attach") {
    const result = await client.attachTask(organizationId, taskId);
    writeStdout(`target=${result.target} session=${result.sessionId ?? "none"}`);
    return;
  }

  if (cmd === "merge" || cmd === "archive") {
    await client.runAction(organizationId, taskId, cmd);
    writeStdout("ok");
    return;
  }

  throw new Error(`Unsupported action: ${cmd}`);
}

async function main(): Promise<void> {
  await ensureBunRuntime();

  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage();
    return;
  }

  if (cmd === "backend") {
    await handleBackend(rest);
    return;
  }

  const config = loadConfig();
  await ensureBackendRunning(config);

  if (!cmd || cmd.startsWith("--")) {
    await handleTui(args);
    return;
  }

  if (cmd === "organization") {
    await handleOrganization(rest);
    return;
  }

  if (cmd === "create") {
    await handleCreate(rest);
    return;
  }

  if (cmd === "list") {
    await handleList(rest);
    return;
  }

  if (cmd === "tui") {
    await handleTui(rest);
    return;
  }

  if (cmd === "status") {
    await handleStatus(rest);
    return;
  }

  if (cmd === "history") {
    await handleHistory(rest);
    return;
  }

  if (cmd === "push") {
    await handlePush(rest);
    return;
  }

  if (cmd === "sync") {
    await handleSync(rest);
    return;
  }

  if (cmd === "kill") {
    await handleKill(rest);
    return;
  }

  if (cmd === "prune") {
    await handlePrune(rest);
    return;
  }

  if (cmd === "statusline") {
    await handleStatusline(rest);
    return;
  }

  if (cmd === "db") {
    await handleDb(rest);
    return;
  }

  if (["switch", "attach", "merge", "archive"].includes(cmd)) {
    await handleSwitchLike(cmd, rest);
    return;
  }

  printUsage();
  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  writeStderr(msg);
  process.exit(1);
});
