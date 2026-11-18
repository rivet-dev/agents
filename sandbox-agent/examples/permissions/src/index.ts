import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Command } from "commander";
import { SandboxAgent, type PermissionReply, type SessionPermissionRequest } from "sandbox-agent";
import { local } from "sandbox-agent/local";

const options = parseOptions();
const agent = options.agent.trim().toLowerCase();
const autoReply = parsePermissionReply(options.reply);
const promptText = options.prompt?.trim() || `Create ./permission-example.txt with the text 'hello from the ${agent} permissions example'.`;

const sdk = await SandboxAgent.start({
  sandbox: local({ log: "inherit" }),
});

try {
  await sdk.installAgent(agent);

  const agents = await sdk.listAgents({ config: true });
  const selectedAgent = agents.agents.find((entry) => entry.id === agent);
  const configOptions = Array.isArray(selectedAgent?.configOptions)
    ? (selectedAgent.configOptions as Array<{ category?: string; currentValue?: string; options?: unknown[] }>)
    : [];
  const modeOption = configOptions.find((option) => option.category === "mode");
  const availableModes = extractOptionValues(modeOption);
  const mode = options.mode?.trim() || (typeof modeOption?.currentValue === "string" ? modeOption.currentValue : "") || availableModes[0] || "";

  console.log(`Agent: ${agent}`);
  console.log(`Mode: ${mode || "(default)"}`);
  if (availableModes.length > 0) {
    console.log(`Available modes: ${availableModes.join(", ")}`);
  }
  console.log(`Working directory: ${process.cwd()}`);
  console.log(`Prompt: ${promptText}`);
  if (autoReply) {
    console.log(`Automatic permission reply: ${autoReply}`);
  } else {
    console.log("Interactive permission replies enabled.");
  }

  const session = await sdk.createSession({
    agent,
    ...(mode ? { mode } : {}),
    cwd: process.cwd(),
  });

  const rl = autoReply
    ? null
    : createInterface({
        input,
        output,
      });

  session.onPermissionRequest((request: SessionPermissionRequest) => {
    void handlePermissionRequest(session, request, autoReply, rl);
  });

  const response = await session.prompt([{ type: "text", text: promptText }]);
  console.log(`Prompt finished with stopReason=${response.stopReason}`);

  await rl?.close();
} finally {
  await sdk.dispose();
}

async function handlePermissionRequest(
  session: {
    respondPermission(permissionId: string, reply: PermissionReply): Promise<void>;
  },
  request: SessionPermissionRequest,
  auto: PermissionReply | null,
  rl: ReturnType<typeof createInterface> | null,
): Promise<void> {
  const reply = auto ?? (await promptForReply(request, rl));
  console.log(`Permission ${reply}: ${request.toolCall.title ?? request.toolCall.toolCallId}`);
  await session.respondPermission(request.id, reply);
}

async function promptForReply(request: SessionPermissionRequest, rl: ReturnType<typeof createInterface> | null): Promise<PermissionReply> {
  if (!rl) {
    return "reject";
  }

  const title = request.toolCall.title ?? request.toolCall.toolCallId;
  const available = request.availableReplies;
  console.log("");
  console.log(`Permission request: ${title}`);
  console.log(`Available replies: ${available.join(", ")}`);
  const answer = (await rl.question("Reply [once|always|reject]: ")).trim().toLowerCase();
  const parsed = parsePermissionReply(answer);
  if (parsed && available.includes(parsed)) {
    return parsed;
  }

  console.log("Invalid reply, defaulting to reject.");
  return "reject";
}

function extractOptionValues(option: { options?: unknown[] } | undefined): string[] {
  if (!option?.options) {
    return [];
  }

  const values: string[] = [];
  for (const entry of option.options) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const value = "value" in entry && typeof entry.value === "string" ? entry.value : null;
    if (value) {
      values.push(value);
      continue;
    }
    if (!("options" in entry) || !Array.isArray(entry.options)) {
      continue;
    }
    for (const nested of entry.options) {
      if (!nested || typeof nested !== "object") {
        continue;
      }
      const nestedValue = "value" in nested && typeof nested.value === "string" ? nested.value : null;
      if (nestedValue) {
        values.push(nestedValue);
      }
    }
  }

  return [...new Set(values)];
}

function parsePermissionReply(value: string | undefined): PermissionReply | null {
  if (!value) {
    return null;
  }

  switch (value.trim().toLowerCase()) {
    case "once":
      return "once";
    case "always":
      return "always";
    case "reject":
    case "deny":
      return "reject";
    default:
      return null;
  }
}

function parseOptions(): {
  agent: string;
  mode?: string;
  prompt?: string;
  reply?: string;
} {
  const argv = process.argv.slice(2);
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const program = new Command();
  program
    .name("permissions")
    .description("Run a permissions example against an agent session.")
    .requiredOption("--agent <agent>", "Agent to run, for example 'claude' or 'codex'")
    .option("--mode <mode>", "Mode to configure for the session (uses agent default if omitted)")
    .option("--prompt <text>", "Prompt to send after the session starts")
    .option("--reply <reply>", "Automatically answer permission prompts with once, always, or reject");

  program.parse(normalizedArgv, { from: "user" });
  return program.opts<{
    agent: string;
    mode?: string;
    prompt?: string;
    reply?: string;
  }>();
}
