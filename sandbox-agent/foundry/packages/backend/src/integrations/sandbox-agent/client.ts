import type { AgentType } from "@sandbox-agent/foundry-shared";
import type {
  ListEventsRequest,
  ListPage,
  ListPageRequest,
  ProcessCreateRequest,
  ProcessInfo,
  ProcessLogFollowQuery,
  ProcessLogsResponse,
  ProcessSignalQuery,
  SessionEvent,
  SessionPersistDriver,
  SessionRecord,
} from "sandbox-agent";
import { SandboxAgent } from "sandbox-agent";

export type AgentId = AgentType | "opencode";

export interface SandboxSession {
  id: string;
  status: "running" | "idle" | "error";
}

export interface SandboxSessionCreateRequest {
  prompt?: string;
  cwd?: string;
  agent?: AgentId;
}

export interface SandboxSessionPromptRequest {
  sessionId: string;
  prompt: string;
  notification?: boolean;
}

export interface SandboxAgentClientOptions {
  endpoint: string;
  token?: string;
  agent?: AgentId;
  persist?: SessionPersistDriver;
}

const DEFAULT_AGENT: AgentId = "codex";

function modeIdForAgent(agent: AgentId): string | null {
  switch (agent) {
    case "codex":
      return "full-access";
    case "claude":
      return "acceptEdits";
    default:
      return null;
  }
}

function normalizeStatusFromMessage(payload: unknown): SandboxSession["status"] | null {
  if (payload && typeof payload === "object") {
    const envelope = payload as {
      error?: unknown;
      method?: unknown;
      result?: unknown;
    };

    const maybeError = envelope.error;
    if (maybeError) {
      return "error";
    }

    if (envelope.result && typeof envelope.result === "object") {
      const stopReason = (envelope.result as { stopReason?: unknown }).stopReason;
      if (typeof stopReason === "string" && stopReason.length > 0) {
        return "idle";
      }
    }

    const method = envelope.method;
    if (typeof method === "string") {
      const lowered = method.toLowerCase();
      if (lowered.includes("error") || lowered.includes("failed")) {
        return "error";
      }
      if (lowered.includes("ended") || lowered.includes("complete") || lowered.includes("stopped")) {
        return "idle";
      }
    }
  }

  return null;
}

export class SandboxAgentClient {
  readonly endpoint: string;
  readonly token?: string;
  readonly agent: AgentId;
  readonly persist?: SessionPersistDriver;
  private sdkPromise?: Promise<SandboxAgent>;
  private readonly statusBySessionId = new Map<string, SandboxSession["status"]>();

  constructor(options: SandboxAgentClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.token = options.token;
    this.agent = options.agent ?? DEFAULT_AGENT;
    this.persist = options.persist;
  }

  private async sdk(): Promise<SandboxAgent> {
    if (!this.sdkPromise) {
      this.sdkPromise = SandboxAgent.connect({
        baseUrl: this.endpoint,
        token: this.token,
        persist: this.persist,
      });
    }

    return this.sdkPromise;
  }

  private setStatus(sessionId: string, status: SandboxSession["status"]): void {
    this.statusBySessionId.set(sessionId, status);
  }

  private isLikelyPromptTimeout(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    const lowered = message.toLowerCase();
    // sandbox-agent server times out long-running ACP prompts and returns a 504-like error.
    return lowered.includes("timeout waiting for agent response") || lowered.includes("timed out waiting for agent response") || lowered.includes("504");
  }

  async createSession(request: string | SandboxSessionCreateRequest): Promise<SandboxSession> {
    const normalized: SandboxSessionCreateRequest = typeof request === "string" ? { prompt: request } : request;
    const sdk = await this.sdk();
    // Do not wrap createSession in a local Promise.race timeout. The underlying SDK
    // call is not abortable, so local timeout races create overlapping ACP requests and
    // can produce duplicate/orphaned sessions while the original request is still running.
    const session = await sdk.createSession({
      agent: normalized.agent ?? this.agent,
      sessionInit: {
        cwd: normalized.cwd ?? "/",
        mcpServers: [],
      },
    });
    const modeId = modeIdForAgent(normalized.agent ?? this.agent);

    // Codex defaults to a restrictive "read-only" preset in some environments.
    // Foundry automation needs edits, command execution, and network access.
    // access (git push / PR creation). Use full-access where supported.
    //
    // If the agent doesn't support session modes, ignore.
    //
    // Do this in the background: ACP mode updates can occasionally time out (504),
    // and waiting here can stall session creation long enough to trip task init
    // step timeouts even though the session itself was created.
    if (modeId) {
      void session.rawSend("session/set_mode", { modeId }).catch(() => {
        // ignore
      });
    }

    const prompt = normalized.prompt?.trim();
    if (!prompt) {
      this.setStatus(session.id, "idle");
      return {
        id: session.id,
        status: "idle",
      };
    }

    // Fire the first turn in the background. We intentionally do not await this:
    // session creation must remain fast, and we observe completion via events/stopReason.
    //
    // Note: sandbox-agent's ACP adapter for Codex may take >2 minutes to respond.
    // sandbox-agent can return a timeout error (504) even though the agent continues
    // running. Treat that timeout as non-fatal and keep polling events.
    void session
      .prompt([{ type: "text", text: prompt }])
      .then(() => {
        this.setStatus(session.id, "idle");
      })
      .catch((err) => {
        if (this.isLikelyPromptTimeout(err)) {
          this.setStatus(session.id, "running");
          return;
        }
        this.setStatus(session.id, "error");
      });

    this.setStatus(session.id, "running");
    return {
      id: session.id,
      status: "running",
    };
  }

  async createSessionNoTask(dir: string): Promise<SandboxSession> {
    return this.createSession({
      cwd: dir,
    });
  }

  async listSessions(request: ListPageRequest = {}): Promise<ListPage<SessionRecord>> {
    const sdk = await this.sdk();
    const page = await sdk.listSessions(request);
    return {
      items: page.items.map((session) => session.toRecord()),
      nextCursor: page.nextCursor,
    };
  }

  async listEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>> {
    const sdk = await this.sdk();
    return sdk.getEvents(request);
  }

  async createProcess(request: ProcessCreateRequest): Promise<ProcessInfo> {
    const sdk = await this.sdk();
    return await sdk.createProcess(request);
  }

  async listProcesses(): Promise<{ processes: ProcessInfo[] }> {
    const sdk = await this.sdk();
    return await sdk.listProcesses();
  }

  async getProcessLogs(processId: string, query: ProcessLogFollowQuery = {}): Promise<ProcessLogsResponse> {
    const sdk = await this.sdk();
    return await sdk.getProcessLogs(processId, query);
  }

  async stopProcess(processId: string, query?: ProcessSignalQuery): Promise<ProcessInfo> {
    const sdk = await this.sdk();
    return await sdk.stopProcess(processId, query);
  }

  async killProcess(processId: string, query?: ProcessSignalQuery): Promise<ProcessInfo> {
    const sdk = await this.sdk();
    return await sdk.killProcess(processId, query);
  }

  async deleteProcess(processId: string): Promise<void> {
    const sdk = await this.sdk();
    await sdk.deleteProcess(processId);
  }

  async sendPrompt(request: SandboxSessionPromptRequest): Promise<void> {
    const sdk = await this.sdk();
    const existing = await sdk.getSession(request.sessionId);
    if (!existing) {
      throw new Error(`session '${request.sessionId}' not found`);
    }

    const session = await sdk.resumeSession(request.sessionId);
    const modeId = modeIdForAgent(this.agent);
    // Keep mode update best-effort and non-blocking for the same reason as createSession.
    if (modeId) {
      void session.rawSend("session/set_mode", { modeId }).catch(() => {
        // ignore
      });
    }
    const text = request.prompt.trim();
    if (!text) return;

    // sandbox-agent's Session.send(notification=true) forwards an extNotification with
    // method "session/prompt", which some agents (e.g. codex-acp) do not implement.
    // Use Session.prompt and treat notification=true as "fire-and-forget".
    const fireAndForget = request.notification ?? true;
    if (fireAndForget) {
      void session
        .prompt([{ type: "text", text }])
        .then(() => {
          this.setStatus(request.sessionId, "idle");
        })
        .catch((err) => {
          if (this.isLikelyPromptTimeout(err)) {
            this.setStatus(request.sessionId, "running");
            return;
          }
          this.setStatus(request.sessionId, "error");
        });
    } else {
      try {
        await session.prompt([{ type: "text", text }]);
        this.setStatus(request.sessionId, "idle");
      } catch (err) {
        if (this.isLikelyPromptTimeout(err)) {
          this.setStatus(request.sessionId, "running");
          return;
        }
        throw err;
      }
    }
    this.setStatus(request.sessionId, "running");
  }

  async cancelSession(sessionId: string): Promise<void> {
    const sdk = await this.sdk();
    const existing = await sdk.getSession(sessionId);
    if (!existing) {
      throw new Error(`session '${sessionId}' not found`);
    }

    const session = await sdk.resumeSession(sessionId);
    await session.rawSend("session/cancel", {});
    this.setStatus(sessionId, "idle");
  }

  async destroySession(sessionId: string): Promise<void> {
    const sdk = await this.sdk();
    await sdk.destroySession(sessionId);
    this.setStatus(sessionId, "idle");
  }

  async sessionStatus(sessionId: string): Promise<SandboxSession> {
    const cached = this.statusBySessionId.get(sessionId);
    if (cached && cached !== "running") {
      return { id: sessionId, status: cached };
    }

    const sdk = await this.sdk();
    const session = await sdk.getSession(sessionId);

    if (!session) {
      this.setStatus(sessionId, "error");
      return { id: sessionId, status: "error" };
    }

    const record = session.toRecord();
    if (record.destroyedAt) {
      this.setStatus(sessionId, "idle");
      return { id: sessionId, status: "idle" };
    }

    const events = await sdk.getEvents({
      sessionId,
      limit: 25,
    });

    for (let i = events.items.length - 1; i >= 0; i--) {
      const item = events.items[i];
      if (!item) continue;
      const status = normalizeStatusFromMessage(item.payload);
      if (status) {
        this.setStatus(sessionId, status);
        return { id: sessionId, status };
      }
    }

    this.setStatus(sessionId, "running");
    return { id: sessionId, status: "running" };
  }

  async killSessionsInDirectory(dir: string): Promise<void> {
    const sdk = await this.sdk();
    let cursor: string | undefined;

    do {
      const page = await sdk.listSessions({
        cursor,
        limit: 100,
      });

      for (const session of page.items) {
        const initCwd = session.toRecord().sessionInit?.cwd;
        if (initCwd !== dir) {
          continue;
        }
        await sdk.destroySession(session.id);
        this.statusBySessionId.delete(session.id);
      }

      cursor = page.nextCursor;
    } while (cursor);
  }

  async generateCommitMessage(dir: string, spec: string, task: string): Promise<string> {
    const prompt = [
      "Generate a conventional commit message for the following changes.",
      "Return ONLY the commit message, no explanation or markdown formatting.",
      "",
      `Task: ${task}`,
      "",
      `Spec/diff:\n${spec}`,
    ].join("\n");

    const sdk = await this.sdk();
    const session = await sdk.createSession({
      agent: this.agent,
      sessionInit: {
        cwd: dir,
        mcpServers: [],
      },
    });

    await session.prompt([{ type: "text", text: prompt }]);
    this.setStatus(session.id, "idle");

    const events = await sdk.getEvents({
      sessionId: session.id,
      limit: 100,
    });

    for (let i = events.items.length - 1; i >= 0; i--) {
      const event = events.items[i];
      if (!event) continue;
      if (event.sender !== "agent") continue;

      const payload = event.payload as Record<string, unknown>;
      const params = payload.params;
      if (!params || typeof params !== "object") continue;

      const text = (params as { text?: unknown }).text;
      if (typeof text === "string" && text.trim().length > 0) {
        return text.trim();
      }
    }

    throw new Error("sandbox-agent commit message response was empty");
  }
}
