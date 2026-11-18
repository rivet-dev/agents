// @ts-nocheck
import { actor, queue } from "rivetkit";
import { workflow, Loop } from "rivetkit/workflow";
import { e2b, sandboxActor } from "rivetkit/sandbox";
import { existsSync } from "node:fs";
import Dockerode from "dockerode";
import { DEFAULT_WORKSPACE_MODEL_GROUPS, workspaceModelGroupsFromSandboxAgents, type WorkspaceModelGroup } from "@sandbox-agent/foundry-shared";
import { SandboxAgent } from "sandbox-agent";
import { getActorRuntimeContext } from "../context.js";
import { organizationKey } from "../keys.js";
import { selfTaskSandbox } from "../handles.js";
import { logActorWarning, resolveErrorMessage } from "../logging.js";
import { expectQueueResponse } from "../../services/queue.js";
import { resolveSandboxProviderId } from "../../sandbox-config.js";

/**
 * Default repo CWD inside the sandbox. The actual path is resolved dynamically
 * via `$HOME/repo` because different sandbox providers run as different users
 * (e.g. E2B uses `/home/user`, local Docker uses `/home/sandbox`).
 */
const DEFAULT_SANDBOX_REPO_CWD = "/home/user/repo";
const DEFAULT_LOCAL_SANDBOX_IMAGE = "rivetdev/sandbox-agent:foundry-base-latest";
const DEFAULT_LOCAL_SANDBOX_PORT = 2468;
const dockerClient = new Dockerode({ socketPath: "/var/run/docker.sock" });

function parseTaskSandboxKey(key: readonly string[]): { organizationId: string; taskId: string } {
  if (key.length !== 4 || key[0] !== "org" || key[2] !== "sandbox") {
    throw new Error(`Invalid task sandbox key: ${JSON.stringify(key)}`);
  }

  return {
    organizationId: key[1]!,
    taskId: key[3]!,
  };
}

function preferredDockerHost(): string {
  if (process.env.FOUNDRY_DOCKER_HOST?.trim()) {
    return process.env.FOUNDRY_DOCKER_HOST.trim();
  }

  return existsSync("/.dockerenv") ? "host.docker.internal" : "127.0.0.1";
}

function preferredPublicDockerHost(): string {
  if (process.env.FOUNDRY_PUBLIC_SANDBOX_HOST?.trim()) {
    return process.env.FOUNDRY_PUBLIC_SANDBOX_HOST.trim();
  }

  return "127.0.0.1";
}

function localSandboxAgentPort(): number {
  const raw = process.env.FOUNDRY_LOCAL_SANDBOX_PORT?.trim() ?? process.env.HF_LOCAL_SANDBOX_PORT?.trim() ?? "";
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }
  return DEFAULT_LOCAL_SANDBOX_PORT;
}

function sandboxEnvPairs(): string[] {
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const entries = [
    ["ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY],
    ["CLAUDE_API_KEY", process.env.CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY],
    ["OPENAI_API_KEY", openAiApiKey],
    // Codex ACP prefers CODEX_API_KEY when present. In dev we want that to be the
    // actual OpenAI API key, not an unrelated local Codex auth token.
    ["CODEX_API_KEY", openAiApiKey ?? process.env.CODEX_API_KEY],
    ["GH_TOKEN", process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN],
    ["GITHUB_TOKEN", process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN],
    ["E2B_API_KEY", process.env.E2B_API_KEY],
  ];

  return entries
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
    .map(([key, value]) => `${key}=${value}`);
}

function sandboxEnvObject(): Record<string, string> {
  return Object.fromEntries(
    sandboxEnvPairs().map((entry) => {
      const [key, ...rest] = entry.split("=");
      return [key!, rest.join("=")];
    }),
  );
}

function modeIdForAgent(agent?: string | null): string | null {
  switch (agent) {
    case "codex":
      return "full-access";
    case "claude":
      return "acceptEdits";
    default:
      return null;
  }
}

async function getPublishedDockerPort(sandboxId: string, containerPort: number): Promise<number> {
  const info = await dockerClient.getContainer(sandboxId).inspect();
  const hostPort = info.NetworkSettings?.Ports?.[`${containerPort}/tcp`]?.[0]?.HostPort;
  if (!hostPort) {
    throw new Error(`docker sandbox-agent port ${containerPort} is not published`);
  }
  return Number(hostPort);
}

function createLocalSandboxProvider(image: string): any {
  const agentPort = localSandboxAgentPort();
  const backendHost = preferredDockerHost();
  const publicHost = preferredPublicDockerHost();

  return {
    name: "docker",

    async create(_context: any): Promise<string> {
      const container = await dockerClient.createContainer({
        Image: image,
        Cmd: ["server", "--no-token", "--host", "0.0.0.0", "--port", String(agentPort)],
        Env: sandboxEnvPairs(),
        ExposedPorts: {
          [`${agentPort}/tcp`]: {},
        },
        HostConfig: {
          AutoRemove: true,
          PortBindings: {
            [`${agentPort}/tcp`]: [{ HostPort: "0" }],
          },
        },
      });

      await container.start();
      return container.id;
    },

    async destroy(sandboxId: string): Promise<void> {
      const container = dockerClient.getContainer(sandboxId);
      try {
        await container.stop({ t: 5 });
      } catch {}
      try {
        await container.remove({ force: true });
      } catch {}
    },

    async getUrl(sandboxId: string): Promise<string> {
      const hostPort = await getPublishedDockerPort(sandboxId, agentPort);
      return `http://${publicHost}:${hostPort}`;
    },

    async connectAgent(sandboxId: string, connectOptions: any): Promise<any> {
      const hostPort = await getPublishedDockerPort(sandboxId, agentPort);
      return await SandboxAgent.connect({
        baseUrl: `http://${backendHost}:${hostPort}`,
        ...connectOptions,
      });
    },
  };
}

function sanitizeActorResult(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "function" || value === undefined) {
    return undefined;
  }

  if (value && typeof value === "object") {
    const maybeToRecord = (value as { toRecord?: unknown }).toRecord;
    if (typeof maybeToRecord === "function") {
      return sanitizeActorResult(maybeToRecord.call(value), seen);
    }
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeActorResult(entry, seen)).filter((entry) => entry !== undefined);
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const sanitized = sanitizeActorResult(entry, seen);
    if (sanitized !== undefined) {
      next[key] = sanitized;
    }
  }
  return next;
}

const baseTaskSandbox = sandboxActor({
  createProvider: async (c) => {
    const { config } = getActorRuntimeContext();
    const { organizationId, taskId } = parseTaskSandboxKey(c.key);
    const organization = await c.client().organization.getOrCreate(organizationKey(organizationId), {
      createWithInput: organizationId,
    });
    const task = await organization.getTask({ organizationId, taskId });
    const sandboxProviderId = resolveSandboxProviderId(config, task.sandboxProviderId);

    if (sandboxProviderId === "e2b") {
      return e2b({
        create: () => ({
          template: config.sandboxProviders.e2b.template ?? "sandbox-agent-full-0.5.x",
          envs: sandboxEnvObject(),
          // TEMPORARY: Default E2B timeout is 5 minutes which is too short.
          // Set to 1 hour as a stopgap. Remove this once the E2B provider in
          // sandbox-agent uses betaCreate + autoPause (see
          // .context/proposal-rivetkit-sandbox-resilience.md). At that point
          // the provider handles timeout/pause lifecycle and this override is
          // unnecessary.
          timeoutMs: 60 * 60 * 1000,
        }),
        installAgents: ["claude", "codex"],
      });
    }

    return createLocalSandboxProvider(config.sandboxProviders.local.image ?? process.env.HF_LOCAL_SANDBOX_IMAGE ?? DEFAULT_LOCAL_SANDBOX_IMAGE);
  },
});

async function broadcastProcesses(c: any, actions: Record<string, (...args: any[]) => Promise<any>>): Promise<void> {
  try {
    const listed = await actions.listProcesses(c);
    c.broadcast("processesUpdated", {
      type: "processesUpdated",
      processes: listed.processes ?? [],
    });
  } catch (error) {
    // Process broadcasts are best-effort. Callers still receive the primary action result.
    logActorWarning("taskSandbox", "broadcastProcesses failed", {
      sandboxId: c.state?.sandboxId,
      error: resolveErrorMessage(error),
    });
  }
}

async function providerForConnection(c: any): Promise<any | null> {
  if (c.state.sandboxDestroyed || !c.state.sandboxId) {
    return null;
  }

  if (c.vars.provider) {
    return c.vars.provider;
  }

  const providerFactory = baseTaskSandbox.config.actions as Record<string, unknown>;
  void providerFactory;
  const { config } = getActorRuntimeContext();
  const { organizationId, taskId } = parseTaskSandboxKey(c.key);
  const organization = await c.client().organization.getOrCreate(organizationKey(organizationId), {
    createWithInput: organizationId,
  });
  const task = await organization.getTask({ organizationId, taskId });
  const sandboxProviderId = resolveSandboxProviderId(config, task.sandboxProviderId);

  const provider =
    sandboxProviderId === "e2b"
      ? e2b({
          create: () => ({
            template: config.sandboxProviders.e2b.template ?? "sandbox-agent-full-0.5.x",
            envs: sandboxEnvObject(),
          }),
          installAgents: ["claude", "codex"],
        })
      : createLocalSandboxProvider(config.sandboxProviders.local.image ?? process.env.HF_LOCAL_SANDBOX_IMAGE ?? DEFAULT_LOCAL_SANDBOX_IMAGE);

  c.vars.provider = provider;
  return provider;
}

async function listWorkspaceModelGroupsForSandbox(c: any): Promise<WorkspaceModelGroup[]> {
  const provider = await providerForConnection(c);
  if (!provider || !c.state.sandboxId || typeof provider.connectAgent !== "function") {
    return DEFAULT_WORKSPACE_MODEL_GROUPS;
  }

  try {
    const client = await provider.connectAgent(c.state.sandboxId, {
      waitForHealth: {
        timeoutMs: 15_000,
      },
    });
    const listed = await client.listAgents({ config: true });
    const groups = workspaceModelGroupsFromSandboxAgents(Array.isArray(listed?.agents) ? listed.agents : []);
    return groups.length > 0 ? groups : DEFAULT_WORKSPACE_MODEL_GROUPS;
  } catch {
    return DEFAULT_WORKSPACE_MODEL_GROUPS;
  }
}

const baseActions = baseTaskSandbox.config.actions as Record<string, (c: any, ...args: any[]) => Promise<any>>;

// ---------------------------------------------------------------------------
// Dynamic repo CWD resolution
// ---------------------------------------------------------------------------

let cachedRepoCwd: string | null = null;

/**
 * Resolve the repo CWD inside the sandbox by querying `$HOME`.
 * Different providers run as different users (E2B: `/home/user`, local Docker:
 * `/home/sandbox`), so the path must be resolved dynamically. The result is
 * cached for the lifetime of this sandbox actor instance.
 */
async function resolveRepoCwd(c: any): Promise<string> {
  if (cachedRepoCwd) return cachedRepoCwd;

  try {
    const result = await baseActions.runProcess(c, {
      command: "bash",
      args: ["-lc", "echo $HOME"],
      cwd: "/",
      timeoutMs: 10_000,
    });
    const home = (result.stdout ?? result.result ?? "").trim();
    if (home && home.startsWith("/")) {
      cachedRepoCwd = `${home}/repo`;
      return cachedRepoCwd;
    }
  } catch (error) {
    logActorWarning("taskSandbox", "failed to resolve $HOME, using default", {
      error: resolveErrorMessage(error),
    });
  }

  cachedRepoCwd = DEFAULT_SANDBOX_REPO_CWD;
  return cachedRepoCwd;
}

// ---------------------------------------------------------------------------
// Queue names for sandbox actor
// ---------------------------------------------------------------------------

const SANDBOX_QUEUE_NAMES = [
  "sandbox.command.createSession",
  "sandbox.command.resumeOrCreateSession",
  "sandbox.command.destroySession",
  "sandbox.command.createProcess",
  "sandbox.command.stopProcess",
  "sandbox.command.killProcess",
  "sandbox.command.deleteProcess",
] as const;

type SandboxQueueName = (typeof SANDBOX_QUEUE_NAMES)[number];

function sandboxWorkflowQueueName(name: SandboxQueueName): SandboxQueueName {
  return name;
}

// ---------------------------------------------------------------------------
// Mutation handlers — executed inside the workflow command loop
// ---------------------------------------------------------------------------

async function createSessionMutation(c: any, request: any): Promise<any> {
  const session = await baseActions.createSession(c, request);
  const sessionId = typeof request?.id === "string" && request.id.length > 0 ? request.id : session?.id;
  const modeId = modeIdForAgent(request?.agent);
  if (sessionId && modeId) {
    try {
      await baseActions.rawSendSessionMethod(c, sessionId, "session/set_mode", { modeId });
    } catch {
      // Session mode updates are best-effort.
    }
  }
  return sanitizeActorResult(session);
}

async function resumeOrCreateSessionMutation(c: any, request: any): Promise<any> {
  return sanitizeActorResult(await baseActions.resumeOrCreateSession(c, request));
}

async function destroySessionMutation(c: any, sessionId: string): Promise<any> {
  return sanitizeActorResult(await baseActions.destroySession(c, sessionId));
}

async function createProcessMutation(c: any, request: any): Promise<any> {
  const created = await baseActions.createProcess(c, request);
  await broadcastProcesses(c, baseActions);
  return created;
}

async function runProcessMutation(c: any, request: any): Promise<any> {
  const result = await baseActions.runProcess(c, request);
  await broadcastProcesses(c, baseActions);
  return result;
}

async function stopProcessMutation(c: any, processId: string, query?: any): Promise<any> {
  const stopped = await baseActions.stopProcess(c, processId, query);
  await broadcastProcesses(c, baseActions);
  return stopped;
}

async function killProcessMutation(c: any, processId: string, query?: any): Promise<any> {
  const killed = await baseActions.killProcess(c, processId, query);
  await broadcastProcesses(c, baseActions);
  return killed;
}

async function deleteProcessMutation(c: any, processId: string): Promise<void> {
  await baseActions.deleteProcess(c, processId);
  await broadcastProcesses(c, baseActions);
}

// ---------------------------------------------------------------------------
// Workflow command loop
// ---------------------------------------------------------------------------

type SandboxWorkflowHandler = (loopCtx: any, body: any) => Promise<any>;

const SANDBOX_COMMAND_HANDLERS: Record<SandboxQueueName, SandboxWorkflowHandler> = {
  "sandbox.command.createSession": async (c, body) => createSessionMutation(c, body),
  "sandbox.command.resumeOrCreateSession": async (c, body) => resumeOrCreateSessionMutation(c, body),
  "sandbox.command.destroySession": async (c, body) => destroySessionMutation(c, body?.sessionId),
  "sandbox.command.createProcess": async (c, body) => createProcessMutation(c, body),
  "sandbox.command.stopProcess": async (c, body) => stopProcessMutation(c, body?.processId, body?.query),
  "sandbox.command.killProcess": async (c, body) => killProcessMutation(c, body?.processId, body?.query),
  "sandbox.command.deleteProcess": async (c, body) => {
    await deleteProcessMutation(c, body?.processId);
    return { ok: true };
  },
};

async function runSandboxWorkflow(ctx: any): Promise<void> {
  await ctx.loop("sandbox-command-loop", async (loopCtx: any) => {
    const msg = await loopCtx.queue.next("next-sandbox-command", {
      names: [...SANDBOX_QUEUE_NAMES],
      completable: true,
    });

    if (!msg) {
      return Loop.continue(undefined);
    }

    const handler = SANDBOX_COMMAND_HANDLERS[msg.name as SandboxQueueName];
    if (!handler) {
      logActorWarning("taskSandbox", "unknown sandbox command", { command: msg.name });
      await msg.complete({ error: `Unknown command: ${msg.name}` }).catch(() => {});
      return Loop.continue(undefined);
    }

    try {
      // Wrap in a step so c.state and c.db are accessible inside mutation functions.
      const result = await loopCtx.step({
        name: msg.name,
        timeout: 10 * 60_000,
        run: async () => handler(loopCtx, msg.body),
      });
      try {
        await msg.complete(result);
      } catch (completeError) {
        logActorWarning("taskSandbox", "sandbox workflow failed completing response", {
          command: msg.name,
          error: resolveErrorMessage(completeError),
        });
      }
    } catch (error) {
      const message = resolveErrorMessage(error);
      logActorWarning("taskSandbox", "sandbox workflow command failed", {
        command: msg.name,
        error: message,
      });
      await msg.complete({ error: message }).catch(() => {});
    }

    return Loop.continue(undefined);
  });
}

// ---------------------------------------------------------------------------
// Actor definition
// ---------------------------------------------------------------------------

export const taskSandbox = actor({
  ...baseTaskSandbox.config,
  queues: Object.fromEntries(SANDBOX_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    ...baseTaskSandbox.config.options,
    actionTimeout: 10 * 60_000,
  },
  actions: {
    ...baseActions,

    // Read actions — direct (no queue)
    async resumeSession(c: any, sessionId: string): Promise<any> {
      return sanitizeActorResult(await baseActions.resumeSession(c, sessionId));
    },

    async getSession(c: any, sessionId: string): Promise<any> {
      return sanitizeActorResult(await baseActions.getSession(c, sessionId));
    },

    async listSessions(c: any, query?: any): Promise<any> {
      return sanitizeActorResult(await baseActions.listSessions(c, query));
    },

    async listProcesses(c: any): Promise<any> {
      try {
        return await baseActions.listProcesses(c);
      } catch (error) {
        // Sandbox may be gone (E2B timeout, destroyed, etc.) — degrade to empty
        logActorWarning("taskSandbox", "listProcesses failed, sandbox may be expired", {
          sandboxId: c.state.sandboxId,
          error: resolveErrorMessage(error),
        });
        return { processes: [] };
      }
    },

    async sandboxAgentConnection(c: any): Promise<{ endpoint: string; token?: string }> {
      const provider = await providerForConnection(c);
      if (!provider || !c.state.sandboxId) {
        return { endpoint: "mock://terminal-unavailable" };
      }

      try {
        return {
          endpoint: await provider.getUrl(c.state.sandboxId),
        };
      } catch {
        return { endpoint: "mock://terminal-unavailable" };
      }
    },

    async listWorkspaceModelGroups(c: any): Promise<WorkspaceModelGroup[]> {
      return await listWorkspaceModelGroupsForSandbox(c);
    },

    async providerState(c: any): Promise<{ sandboxProviderId: "e2b" | "local"; sandboxId: string; state: string; at: number }> {
      const { config } = getActorRuntimeContext();
      const { taskId } = parseTaskSandboxKey(c.key);
      const at = Date.now();
      const sandboxProviderId = resolveSandboxProviderId(config, c.state.providerName === "e2b" ? "e2b" : c.state.providerName === "docker" ? "local" : null);

      if (c.state.sandboxDestroyed) {
        return { sandboxProviderId, sandboxId: taskId, state: "destroyed", at };
      }

      if (!c.state.sandboxId) {
        return { sandboxProviderId, sandboxId: taskId, state: "pending", at };
      }

      try {
        const health = await baseActions.getHealth(c);
        return {
          sandboxProviderId,
          sandboxId: taskId,
          state: health.status === "ok" ? "running" : "degraded",
          at,
        };
      } catch {
        return {
          sandboxProviderId,
          sandboxId: taskId,
          state: "error",
          at,
        };
      }
    },

    async repoCwd(c: any): Promise<{ cwd: string }> {
      const resolved = await resolveRepoCwd(c);
      return { cwd: resolved };
    },

    // Long-running action — kept as direct action to avoid blocking the
    // workflow loop (prompt responses can take minutes).
    async sendPrompt(c: any, request: { sessionId: string; prompt: string }): Promise<any> {
      const text = typeof request?.prompt === "string" ? request.prompt.trim() : "";
      if (!text) {
        return null;
      }

      const session = await baseActions.resumeSession(c, request.sessionId);
      if (!session || typeof session.prompt !== "function") {
        throw new Error(`session '${request.sessionId}' not found`);
      }

      return sanitizeActorResult(await session.prompt([{ type: "text", text }]));
    },

    // Mutation actions — self-send to queue for workflow history
    async createSession(c: any, request: any): Promise<any> {
      const self = selfTaskSandbox(c);
      return expectQueueResponse(await self.send(sandboxWorkflowQueueName("sandbox.command.createSession"), request ?? {}, { wait: true, timeout: 10_000 }));
    },

    async resumeOrCreateSession(c: any, request: any): Promise<any> {
      const self = selfTaskSandbox(c);
      return expectQueueResponse(
        await self.send(sandboxWorkflowQueueName("sandbox.command.resumeOrCreateSession"), request ?? {}, { wait: true, timeout: 10_000 }),
      );
    },

    async destroySession(c: any, sessionId: string): Promise<any> {
      const self = selfTaskSandbox(c);
      return expectQueueResponse(await self.send(sandboxWorkflowQueueName("sandbox.command.destroySession"), { sessionId }, { wait: true, timeout: 10_000 }));
    },

    async createProcess(c: any, request: any): Promise<any> {
      const self = selfTaskSandbox(c);
      return expectQueueResponse(await self.send(sandboxWorkflowQueueName("sandbox.command.createProcess"), request ?? {}, { wait: true, timeout: 10_000 }));
    },

    // runProcess kept as direct action — response can exceed 128KB queue limit
    async runProcess(c: any, request: any): Promise<any> {
      const result = await baseActions.runProcess(c, request);
      await broadcastProcesses(c, baseActions);
      return result;
    },

    async stopProcess(c: any, processId: string, query?: any): Promise<any> {
      const self = selfTaskSandbox(c);
      return expectQueueResponse(
        await self.send(sandboxWorkflowQueueName("sandbox.command.stopProcess"), { processId, query }, { wait: true, timeout: 10_000 }),
      );
    },

    async killProcess(c: any, processId: string, query?: any): Promise<any> {
      const self = selfTaskSandbox(c);
      return expectQueueResponse(
        await self.send(sandboxWorkflowQueueName("sandbox.command.killProcess"), { processId, query }, { wait: true, timeout: 10_000 }),
      );
    },

    async deleteProcess(c: any, processId: string): Promise<void> {
      const self = selfTaskSandbox(c);
      await self.send(sandboxWorkflowQueueName("sandbox.command.deleteProcess"), { processId }, { wait: false });
    },
  },
  run: workflow(runSandboxWorkflow),
});

export { DEFAULT_SANDBOX_REPO_CWD, resolveRepoCwd };
