import {
  AcpHttpClient,
  AcpRpcError,
  PROTOCOL_VERSION,
  type AcpEnvelopeDirection,
  type AnyMessage,
  type AuthMethod,
  type CancelNotification,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
  type PermissionOptionKind,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SessionModeState,
  type SetSessionConfigOptionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionModeResponse,
  type SetSessionModeRequest,
} from "acp-http-client";
import type { SandboxProvider } from "./providers/types.ts";
import { DesktopStreamSession, type DesktopStreamConnectOptions } from "./desktop-stream.ts";
import {
  type AcpServerListResponse,
  type AgentInfo,
  type AgentInstallRequest,
  type AgentInstallResponse,
  type AgentListResponse,
  type DesktopActionResponse,
  type DesktopClipboardQuery,
  type DesktopClipboardResponse,
  type DesktopClipboardWriteRequest,
  type DesktopDisplayInfoResponse,
  type DesktopKeyboardDownRequest,
  type DesktopKeyboardPressRequest,
  type DesktopKeyboardTypeRequest,
  type DesktopLaunchRequest,
  type DesktopLaunchResponse,
  type DesktopMouseClickRequest,
  type DesktopMouseDownRequest,
  type DesktopMouseDragRequest,
  type DesktopMouseMoveRequest,
  type DesktopMousePositionResponse,
  type DesktopMouseScrollRequest,
  type DesktopMouseUpRequest,
  type DesktopKeyboardUpRequest,
  type DesktopOpenRequest,
  type DesktopOpenResponse,
  type DesktopRecordingInfo,
  type DesktopRecordingListResponse,
  type DesktopRecordingStartRequest,
  type DesktopRegionScreenshotQuery,
  type DesktopScreenshotQuery,
  type DesktopStartRequest,
  type DesktopStatusResponse,
  type DesktopStreamStatusResponse,
  type DesktopWindowInfo,
  type DesktopWindowListResponse,
  type DesktopWindowMoveRequest,
  type DesktopWindowResizeRequest,
  type FsActionResponse,
  type FsDeleteQuery,
  type FsEntriesQuery,
  type FsEntry,
  type FsMoveRequest,
  type FsMoveResponse,
  type FsPathQuery,
  type FsStat,
  type FsUploadBatchQuery,
  type FsUploadBatchResponse,
  type FsWriteResponse,
  type HealthResponse,
  InMemorySessionPersistDriver,
  type ListEventsRequest,
  type ListPage,
  type ListPageRequest,
  type McpConfigQuery,
  type McpServerConfig,
  type ProblemDetails,
  type ProcessConfig,
  type ProcessCreateRequest,
  type ProcessInfo,
  type ProcessInputRequest,
  type ProcessInputResponse,
  type ProcessListQuery,
  type ProcessListResponse,
  type ProcessOwner,
  type ProcessLogEntry,
  type ProcessLogsQuery,
  type ProcessLogsResponse,
  type ProcessRunRequest,
  type ProcessRunResponse,
  type ProcessSignalQuery,
  type ProcessTerminalClientFrame,
  type ProcessTerminalServerFrame,
  type ProcessTerminalResizeRequest,
  type ProcessTerminalResizeResponse,
  type SessionEvent,
  type SessionPersistDriver,
  type SessionRecord,
  type SkillsConfig,
  type SkillsConfigQuery,
  type TerminalErrorStatus,
  type TerminalExitStatus,
  type TerminalReadyStatus,
  type TerminalResizePayload,
} from "./types.ts";

const API_PREFIX = "/v1";
const FS_PATH = `${API_PREFIX}/fs`;
const DEFAULT_BASE_URL = "http://sandbox-agent";

const DEFAULT_REPLAY_MAX_EVENTS = 50;
const DEFAULT_REPLAY_MAX_CHARS = 12_000;
const EVENT_INDEX_SCAN_EVENTS_LIMIT = 500;
const MAX_EVENT_INDEX_INSERT_RETRIES = 3;
const SESSION_CANCEL_METHOD = "session/cancel";
const MANUAL_CANCEL_ERROR = "Manual session/cancel calls are not allowed. Use destroySession(sessionId) instead.";
const HEALTH_WAIT_MIN_DELAY_MS = 500;
const HEALTH_WAIT_MAX_DELAY_MS = 15_000;
const HEALTH_WAIT_LOG_AFTER_MS = 5_000;
const HEALTH_WAIT_LOG_EVERY_MS = 10_000;
const HEALTH_WAIT_ENSURE_SERVER_AFTER_FAILURES = 3;

export interface SandboxAgentHealthWaitOptions {
  timeoutMs?: number;
}

interface SandboxAgentConnectCommonOptions {
  headers?: HeadersInit;
  persist?: SessionPersistDriver;
  replayMaxEvents?: number;
  replayMaxChars?: number;
  signal?: AbortSignal;
  token?: string;
  skipHealthCheck?: boolean;
  /** @deprecated Use skipHealthCheck instead. */
  waitForHealth?: boolean | SandboxAgentHealthWaitOptions;
}

export type SandboxAgentConnectOptions =
  | (SandboxAgentConnectCommonOptions & {
      baseUrl: string;
      fetch?: typeof fetch;
    })
  | (SandboxAgentConnectCommonOptions & {
      fetch: typeof fetch;
      baseUrl?: string;
    });

export interface SandboxAgentStartOptions {
  sandbox: SandboxProvider;
  sandboxId?: string;
  skipHealthCheck?: boolean;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  persist?: SessionPersistDriver;
  replayMaxEvents?: number;
  replayMaxChars?: number;
  signal?: AbortSignal;
  token?: string;
}

export interface SessionCreateRequest {
  id?: string;
  agent: string;
  /** Shorthand for `sessionInit.cwd`. Ignored when `sessionInit` is provided. */
  cwd?: string;
  /** Full session init. When omitted, built from `cwd` (or default) with empty `mcpServers`. */
  sessionInit?: Omit<NewSessionRequest, "_meta">;
  model?: string;
  mode?: string;
  thoughtLevel?: string;
}

export interface SessionResumeOrCreateRequest {
  id: string;
  agent: string;
  /** Shorthand for `sessionInit.cwd`. Ignored when `sessionInit` is provided. */
  cwd?: string;
  /** Full session init. When omitted, built from `cwd` (or default) with empty `mcpServers`. */
  sessionInit?: Omit<NewSessionRequest, "_meta">;
  model?: string;
  mode?: string;
  thoughtLevel?: string;
}

export interface SessionSendOptions {
  notification?: boolean;
}

export type SessionEventListener = (event: SessionEvent) => void;
export type PermissionReply = "once" | "always" | "reject";
export type PermissionRequestListener = (request: SessionPermissionRequest) => void;
export type ProcessLogListener = (entry: ProcessLogEntry) => void;
export type ProcessLogFollowQuery = Omit<ProcessLogsQuery, "follow">;

export interface SessionPermissionRequestOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface SessionPermissionRequest {
  id: string;
  createdAt: number;
  sessionId: string;
  agentSessionId: string;
  availableReplies: PermissionReply[];
  options: SessionPermissionRequestOption[];
  toolCall: RequestPermissionRequest["toolCall"];
  rawRequest: RequestPermissionRequest;
}

export interface AgentQueryOptions {
  config?: boolean;
  noCache?: boolean;
}

export interface ProcessLogSubscription {
  close(): void;
  closed: Promise<void>;
}

export interface ProcessTerminalWebSocketUrlOptions {
  accessToken?: string;
}

export interface ProcessTerminalConnectOptions extends ProcessTerminalWebSocketUrlOptions {
  protocols?: string | string[];
  WebSocket?: typeof WebSocket;
}

export type ProcessTerminalSessionOptions = ProcessTerminalConnectOptions;
export type DesktopStreamSessionOptions = DesktopStreamConnectOptions;

export class SandboxAgentError extends Error {
  readonly status: number;
  readonly problem?: ProblemDetails;
  readonly response: Response;

  constructor(status: number, problem: ProblemDetails | undefined, response: Response) {
    super(problem?.title ?? `Request failed with status ${status}`);
    this.name = "SandboxAgentError";
    this.status = status;
    this.problem = problem;
    this.response = response;
  }
}

export class SandboxDestroyedError extends Error {
  readonly sandboxId: string;
  readonly provider: string;

  constructor(sandboxId: string, provider: string, options?: { cause?: unknown }) {
    super(`Sandbox '${provider}/${sandboxId}' no longer exists and cannot be reconnected.`, options);
    this.name = "SandboxDestroyedError";
    this.sandboxId = sandboxId;
    this.provider = provider;
  }
}

export class UnsupportedSessionCategoryError extends Error {
  readonly sessionId: string;
  readonly category: string;
  readonly availableCategories: string[];

  constructor(sessionId: string, category: string, availableCategories: string[]) {
    super(`Session '${sessionId}' does not support category '${category}'. Available categories: ${availableCategories.join(", ") || "(none)"}`);
    this.name = "UnsupportedSessionCategoryError";
    this.sessionId = sessionId;
    this.category = category;
    this.availableCategories = availableCategories;
  }
}

export class UnsupportedSessionValueError extends Error {
  readonly sessionId: string;
  readonly category: string;
  readonly configId: string;
  readonly requestedValue: string;
  readonly allowedValues: string[];

  constructor(sessionId: string, category: string, configId: string, requestedValue: string, allowedValues: string[]) {
    super(
      `Session '${sessionId}' does not support value '${requestedValue}' for category '${category}' (configId='${configId}'). Allowed values: ${allowedValues.join(", ") || "(none)"}`,
    );
    this.name = "UnsupportedSessionValueError";
    this.sessionId = sessionId;
    this.category = category;
    this.configId = configId;
    this.requestedValue = requestedValue;
    this.allowedValues = allowedValues;
  }
}

export class UnsupportedSessionConfigOptionError extends Error {
  readonly sessionId: string;
  readonly configId: string;
  readonly availableConfigIds: string[];

  constructor(sessionId: string, configId: string, availableConfigIds: string[]) {
    super(`Session '${sessionId}' does not expose config option '${configId}'. Available configIds: ${availableConfigIds.join(", ") || "(none)"}`);
    this.name = "UnsupportedSessionConfigOptionError";
    this.sessionId = sessionId;
    this.configId = configId;
    this.availableConfigIds = availableConfigIds;
  }
}

export class UnsupportedPermissionReplyError extends Error {
  readonly permissionId: string;
  readonly requestedReply: PermissionReply;
  readonly availableReplies: PermissionReply[];

  constructor(permissionId: string, requestedReply: PermissionReply, availableReplies: PermissionReply[]) {
    super(`Permission '${permissionId}' does not support reply '${requestedReply}'. Available replies: ${availableReplies.join(", ") || "(none)"}`);
    this.name = "UnsupportedPermissionReplyError";
    this.permissionId = permissionId;
    this.requestedReply = requestedReply;
    this.availableReplies = availableReplies;
  }
}

export class Session {
  private record: SessionRecord;
  private readonly sandbox: SandboxAgent;

  constructor(sandbox: SandboxAgent, record: SessionRecord) {
    this.sandbox = sandbox;
    this.record = { ...record };
  }

  get id(): string {
    return this.record.id;
  }

  get agent(): string {
    return this.record.agent;
  }

  get agentSessionId(): string {
    return this.record.agentSessionId;
  }

  get lastConnectionId(): string {
    return this.record.lastConnectionId;
  }

  get createdAt(): number {
    return this.record.createdAt;
  }

  get destroyedAt(): number | undefined {
    return this.record.destroyedAt;
  }

  async refresh(): Promise<Session> {
    const latest = await this.sandbox.getSession(this.id);
    if (!latest) {
      throw new Error(`session '${this.id}' no longer exists`);
    }
    this.apply(latest.toRecord());
    return this;
  }

  async rawSend(method: string, params: Record<string, unknown> = {}, options: SessionSendOptions = {}): Promise<unknown> {
    const updated = await this.sandbox.rawSendSessionMethod(this.id, method, params, options);
    this.apply(updated.session.toRecord());
    return updated.response;
  }

  async prompt(prompt: PromptRequest["prompt"]): Promise<PromptResponse> {
    const response = await this.rawSend("session/prompt", { prompt });
    return response as PromptResponse;
  }

  async setMode(modeId: string): Promise<SetSessionModeResponse | void> {
    const updated = await this.sandbox.setSessionMode(this.id, modeId);
    this.apply(updated.session.toRecord());
    return updated.response;
  }

  async setConfigOption(configId: string, value: string): Promise<SetSessionConfigOptionResponse> {
    const updated = await this.sandbox.setSessionConfigOption(this.id, configId, value);
    this.apply(updated.session.toRecord());
    return updated.response;
  }

  async setModel(model: string): Promise<SetSessionConfigOptionResponse> {
    const updated = await this.sandbox.setSessionModel(this.id, model);
    this.apply(updated.session.toRecord());
    return updated.response;
  }

  async setThoughtLevel(thoughtLevel: string): Promise<SetSessionConfigOptionResponse> {
    const updated = await this.sandbox.setSessionThoughtLevel(this.id, thoughtLevel);
    this.apply(updated.session.toRecord());
    return updated.response;
  }

  async getConfigOptions(): Promise<SessionConfigOption[]> {
    return this.sandbox.getSessionConfigOptions(this.id);
  }

  async getModes(): Promise<SessionModeState | null> {
    return this.sandbox.getSessionModes(this.id);
  }

  onEvent(listener: SessionEventListener): () => void {
    return this.sandbox.onSessionEvent(this.id, listener);
  }

  onPermissionRequest(listener: PermissionRequestListener): () => void {
    return this.sandbox.onPermissionRequest(this.id, listener);
  }

  async respondPermission(permissionId: string, reply: PermissionReply): Promise<void> {
    await this.sandbox.respondPermission(permissionId, reply);
  }

  async rawRespondPermission(permissionId: string, response: RequestPermissionResponse): Promise<void> {
    await this.sandbox.rawRespondPermission(permissionId, response);
  }

  toRecord(): SessionRecord {
    return { ...this.record };
  }

  apply(record: SessionRecord): void {
    this.record = { ...record };
  }
}

export class LiveAcpConnection {
  readonly connectionId: string;
  readonly agent: string;

  private readonly acp: AcpHttpClient;
  private readonly sessionByLocalId = new Map<string, string>();
  private readonly localByAgentSessionId = new Map<string, string>();
  private readonly pendingNewSessionLocals: string[] = [];
  private readonly pendingRequestSessionById = new Map<string, string>();
  private readonly pendingReplayByLocalSessionId = new Map<string, string>();
  private lastAdapterExit: { success: boolean; code: number | null } | null = null;
  private lastAdapterExitAt = 0;

  private readonly onObservedEnvelope: (
    connection: LiveAcpConnection,
    envelope: AnyMessage,
    direction: AcpEnvelopeDirection,
    localSessionId: string | null,
  ) => void;
  private readonly onPermissionRequest: (
    connection: LiveAcpConnection,
    localSessionId: string,
    agentSessionId: string,
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;

  private constructor(
    agent: string,
    connectionId: string,
    acp: AcpHttpClient,
    onObservedEnvelope: (connection: LiveAcpConnection, envelope: AnyMessage, direction: AcpEnvelopeDirection, localSessionId: string | null) => void,
    onPermissionRequest: (
      connection: LiveAcpConnection,
      localSessionId: string,
      agentSessionId: string,
      request: RequestPermissionRequest,
    ) => Promise<RequestPermissionResponse>,
  ) {
    this.agent = agent;
    this.connectionId = connectionId;
    this.acp = acp;
    this.onObservedEnvelope = onObservedEnvelope;
    this.onPermissionRequest = onPermissionRequest;
  }

  static async create(options: {
    baseUrl: string;
    token?: string;
    fetcher: typeof fetch;
    headers?: HeadersInit;
    agent: string;
    serverId: string;
    onObservedEnvelope: (connection: LiveAcpConnection, envelope: AnyMessage, direction: AcpEnvelopeDirection, localSessionId: string | null) => void;
    onPermissionRequest: (
      connection: LiveAcpConnection,
      localSessionId: string,
      agentSessionId: string,
      request: RequestPermissionRequest,
    ) => Promise<RequestPermissionResponse>;
  }): Promise<LiveAcpConnection> {
    const connectionId = randomId();

    let live: LiveAcpConnection | null = null;
    const acp = new AcpHttpClient({
      baseUrl: options.baseUrl,
      token: options.token,
      fetch: options.fetcher,
      headers: options.headers,
      transport: {
        path: `${API_PREFIX}/acp/${encodeURIComponent(options.serverId)}`,
        bootstrapQuery: { agent: options.agent },
      },
      client: {
        requestPermission: async (request: RequestPermissionRequest) => {
          if (!live) {
            return cancelledPermissionResponse();
          }
          return live.handlePermissionRequest(request);
        },
        sessionUpdate: async (_notification: SessionNotification) => {
          // Session updates are observed via envelope persistence.
        },
        extNotification: async (method: string, params: Record<string, unknown>) => {
          if (!live) return;
          live.handleAdapterNotification(method, params);
        },
      },
      onEnvelope: (envelope, direction) => {
        if (!live) {
          return;
        }
        live.handleEnvelope(envelope, direction);
      },
    });

    live = new LiveAcpConnection(options.agent, connectionId, acp, options.onObservedEnvelope, options.onPermissionRequest);

    const initResult = await acp.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: {
        name: "sandbox-agent-sdk",
        version: "v1",
      },
    });
    if (initResult.authMethods && initResult.authMethods.length > 0) {
      await autoAuthenticate(acp, initResult.authMethods);
    }
    return live;
  }

  async close(): Promise<void> {
    await this.acp.disconnect();
  }

  hasBoundSession(localSessionId: string, agentSessionId?: string): boolean {
    const bound = this.sessionByLocalId.get(localSessionId);
    if (!bound) {
      return false;
    }
    if (agentSessionId && bound !== agentSessionId) {
      return false;
    }
    return true;
  }

  bindSession(localSessionId: string, agentSessionId: string): void {
    this.sessionByLocalId.set(localSessionId, agentSessionId);
    this.localByAgentSessionId.set(agentSessionId, localSessionId);
  }

  queueReplay(localSessionId: string, replayText: string | null): void {
    if (!replayText) {
      this.pendingReplayByLocalSessionId.delete(localSessionId);
      return;
    }
    this.pendingReplayByLocalSessionId.set(localSessionId, replayText);
  }

  async createRemoteSession(localSessionId: string, sessionInit: Omit<NewSessionRequest, "_meta">): Promise<NewSessionResponse> {
    const createStartedAt = Date.now();
    this.pendingNewSessionLocals.push(localSessionId);

    try {
      const response = await this.acp.newSession(sessionInit);
      this.bindSession(localSessionId, response.sessionId);
      return response;
    } catch (error) {
      const index = this.pendingNewSessionLocals.indexOf(localSessionId);
      if (index !== -1) {
        this.pendingNewSessionLocals.splice(index, 1);
      }
      const adapterExit = this.lastAdapterExit;
      if (adapterExit && this.lastAdapterExitAt >= createStartedAt) {
        const suffix = adapterExit.code == null ? "" : ` (code ${adapterExit.code})`;
        throw new Error(`Agent process exited while creating session${suffix}`);
      }
      throw error;
    }
  }

  async sendSessionMethod(localSessionId: string, method: string, params: Record<string, unknown>, options: SessionSendOptions): Promise<unknown> {
    const agentSessionId = this.sessionByLocalId.get(localSessionId);
    if (!agentSessionId) {
      throw new Error(`session '${localSessionId}' is not bound to live ACP connection '${this.connectionId}'`);
    }

    const mappedParams = mapSessionParams(params, agentSessionId);

    if (method === "session/prompt") {
      const replayText = this.pendingReplayByLocalSessionId.get(localSessionId);
      if (replayText) {
        // TODO: Replace this synthesized replay text with ACP-native restore once standardized.
        this.pendingReplayByLocalSessionId.delete(localSessionId);
        injectReplayPrompt(mappedParams, replayText);
      }

      if (options.notification) {
        await this.acp.extNotification(method, mappedParams);
        return undefined;
      }

      return this.acp.prompt(mappedParams as PromptRequest);
    }

    if (method === "session/cancel") {
      await this.acp.cancel(mappedParams as CancelNotification);
      return undefined;
    }

    if (method === "session/set_mode") {
      return this.acp.setSessionMode(mappedParams as SetSessionModeRequest);
    }

    if (method === "session/set_config_option") {
      return this.acp.setSessionConfigOption(mappedParams as SetSessionConfigOptionRequest);
    }

    if (options.notification) {
      await this.acp.extNotification(method, mappedParams);
      return undefined;
    }

    return this.acp.extMethod(method, mappedParams);
  }

  private handleEnvelope(envelope: AnyMessage, direction: AcpEnvelopeDirection): void {
    const localSessionId = this.resolveSessionId(envelope, direction);
    this.onObservedEnvelope(this, envelope, direction, localSessionId);
  }

  private handleAdapterNotification(method: string, params: Record<string, unknown>): void {
    if (method !== "_adapter/agent_exited") {
      return;
    }
    this.lastAdapterExit = {
      success: params.success === true,
      code: typeof params.code === "number" ? params.code : null,
    };
    this.lastAdapterExitAt = Date.now();
  }

  private async handlePermissionRequest(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const agentSessionId = request.sessionId;
    const localSessionId = this.localByAgentSessionId.get(agentSessionId);
    if (!localSessionId) {
      return cancelledPermissionResponse();
    }

    return this.onPermissionRequest(this, localSessionId, agentSessionId, clonePermissionRequest(request));
  }

  private resolveSessionId(envelope: AnyMessage, direction: AcpEnvelopeDirection): string | null {
    const id = envelopeId(envelope);
    const method = envelopeMethod(envelope);

    if (direction === "outbound") {
      if (id && method === "session/new") {
        const localSessionId = this.pendingNewSessionLocals.shift() ?? null;
        if (localSessionId) {
          this.pendingRequestSessionById.set(id, localSessionId);
        }
        return localSessionId;
      }

      const localFromParams = this.localFromEnvelopeParams(envelope);
      if (id && localFromParams) {
        this.pendingRequestSessionById.set(id, localFromParams);
      }
      return localFromParams;
    }

    if (id) {
      const pending = this.pendingRequestSessionById.get(id) ?? null;
      if (pending) {
        this.pendingRequestSessionById.delete(id);
        const sessionIdFromResult = envelopeSessionIdFromResult(envelope);
        if (sessionIdFromResult) {
          this.bindSession(pending, sessionIdFromResult);
        }
        return pending;
      }
    }

    return this.localFromEnvelopeParams(envelope);
  }

  private localFromEnvelopeParams(envelope: AnyMessage): string | null {
    const agentSessionId = envelopeSessionIdFromParams(envelope);
    if (!agentSessionId) {
      return null;
    }
    return this.localByAgentSessionId.get(agentSessionId) ?? null;
  }
}

export class ProcessTerminalSession {
  readonly socket: WebSocket;
  readonly closed: Promise<void>;

  private readonly readyListeners = new Set<(status: TerminalReadyStatus) => void>();
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(status: TerminalExitStatus) => void>();
  private readonly errorListeners = new Set<(error: TerminalErrorStatus | Error) => void>();
  private readonly closeListeners = new Set<() => void>();

  private closeSignalSent = false;
  private closedResolve!: () => void;

  constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.binaryType = "arraybuffer";
    this.closed = new Promise<void>((resolve) => {
      this.closedResolve = resolve;
    });

    this.socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    this.socket.addEventListener("error", () => {
      this.emitError(new Error("Terminal websocket connection failed."));
    });
    this.socket.addEventListener("close", () => {
      this.closedResolve();
      for (const listener of this.closeListeners) {
        listener();
      }
    });
  }

  onReady(listener: (status: TerminalReadyStatus) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  onExit(listener: (status: TerminalExitStatus) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  onError(listener: (error: TerminalErrorStatus | Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  sendInput(data: string | ArrayBuffer | ArrayBufferView): void {
    const payload = encodeTerminalInput(data);
    this.sendFrame({
      type: "input",
      data: payload.data,
      encoding: payload.encoding,
    });
  }

  resize(payload: TerminalResizePayload): void {
    this.sendFrame({
      type: "resize",
      cols: payload.cols,
      rows: payload.rows,
    });
  }

  close(): void {
    if (this.socket.readyState === WS_READY_STATE_CONNECTING) {
      this.socket.addEventListener(
        "open",
        () => {
          this.close();
        },
        { once: true },
      );
      return;
    }

    if (this.socket.readyState === WS_READY_STATE_OPEN) {
      if (!this.closeSignalSent) {
        this.closeSignalSent = true;
        this.sendFrame({ type: "close" });
      }
      this.socket.close();
      return;
    }

    if (this.socket.readyState !== WS_READY_STATE_CLOSED) {
      this.socket.close();
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    try {
      if (typeof data === "string") {
        const frame = parseProcessTerminalServerFrame(data);
        if (!frame) {
          this.emitError(new Error("Received invalid terminal control frame."));
          return;
        }

        if (frame.type === "ready") {
          for (const listener of this.readyListeners) {
            listener(frame);
          }
          return;
        }

        if (frame.type === "exit") {
          for (const listener of this.exitListeners) {
            listener(frame);
          }
          return;
        }

        this.emitError(frame);
        return;
      }

      const bytes = await decodeTerminalBytes(data);
      for (const listener of this.dataListeners) {
        listener(bytes);
      }
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private sendFrame(frame: ProcessTerminalClientFrame): void {
    if (this.socket.readyState !== WS_READY_STATE_OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(frame));
  }

  private emitError(error: TerminalErrorStatus | Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}

const WS_READY_STATE_CONNECTING = 0;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSED = 3;

export class SandboxAgent {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetcher: typeof fetch;
  private readonly defaultHeaders?: HeadersInit;
  private readonly healthWait: NormalizedHealthWaitOptions;
  private readonly healthWaitAbortController = new AbortController();
  private sandboxProvider?: SandboxProvider;
  private sandboxProviderId?: string;
  private sandboxProviderRawId?: string;
  private sandboxInspectorUrl?: string;

  private readonly persist: SessionPersistDriver;
  private readonly replayMaxEvents: number;
  private readonly replayMaxChars: number;

  private healthPromise?: Promise<void>;
  private healthError?: Error;
  private disposed = false;

  private readonly liveConnections = new Map<string, LiveAcpConnection>();
  private readonly pendingLiveConnections = new Map<string, Promise<LiveAcpConnection>>();
  private readonly sessionHandles = new Map<string, Session>();
  private readonly eventListeners = new Map<string, Set<SessionEventListener>>();
  private readonly permissionListeners = new Map<string, Set<PermissionRequestListener>>();
  private readonly pendingPermissionRequests = new Map<string, PendingPermissionRequestState>();
  private readonly nextSessionEventIndexBySession = new Map<string, number>();
  private readonly seedSessionEventIndexBySession = new Map<string, Promise<void>>();
  private readonly pendingObservedEnvelopePersistenceBySession = new Map<string, Promise<void>>();

  constructor(options: SandboxAgentConnectOptions) {
    const baseUrl = options.baseUrl?.trim();
    if (!baseUrl && !options.fetch) {
      throw new Error("baseUrl is required unless fetch is provided.");
    }
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.token = options.token;
    const resolvedFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!resolvedFetch) {
      throw new Error("Fetch API is not available; provide a fetch implementation.");
    }
    this.fetcher = resolvedFetch;
    this.defaultHeaders = options.headers;
    this.healthWait = normalizeHealthWaitOptions(options.skipHealthCheck, options.waitForHealth, options.signal);
    this.persist = options.persist ?? new InMemorySessionPersistDriver();

    this.replayMaxEvents = normalizePositiveInt(options.replayMaxEvents, DEFAULT_REPLAY_MAX_EVENTS);
    this.replayMaxChars = normalizePositiveInt(options.replayMaxChars, DEFAULT_REPLAY_MAX_CHARS);

    this.startHealthWait();
  }

  static async connect(options: SandboxAgentConnectOptions): Promise<SandboxAgent> {
    return new SandboxAgent(options);
  }

  static async start(options: SandboxAgentStartOptions): Promise<SandboxAgent> {
    const provider = options.sandbox;
    if (!provider.getUrl && !provider.getFetch) {
      throw new Error(`Sandbox provider '${provider.name}' must implement getUrl() or getFetch().`);
    }

    const existingSandbox = options.sandboxId ? parseSandboxProviderId(options.sandboxId) : null;

    if (existingSandbox && existingSandbox.provider !== provider.name) {
      throw new Error(
        `SandboxAgent.start received sandboxId '${options.sandboxId}' for provider '${existingSandbox.provider}', but the configured provider is '${provider.name}'.`,
      );
    }

    const rawSandboxId = existingSandbox?.rawId ?? (await provider.create());
    const prefixedSandboxId = `${provider.name}/${rawSandboxId}`;
    const createdSandbox = !existingSandbox;

    if (existingSandbox) {
      await provider.reconnect?.(rawSandboxId);
      await provider.ensureServer?.(rawSandboxId);
    }

    try {
      const fetcher = await resolveProviderFetch(provider, rawSandboxId);
      const baseUrl = provider.getUrl ? await provider.getUrl(rawSandboxId) : undefined;
      const inspectorUrl = provider.getInspectorUrl ? await provider.getInspectorUrl(rawSandboxId, baseUrl) : undefined;
      const providerFetch = options.fetch ?? fetcher;
      const commonConnectOptions = {
        headers: options.headers,
        persist: options.persist,
        replayMaxEvents: options.replayMaxEvents,
        replayMaxChars: options.replayMaxChars,
        signal: options.signal,
        skipHealthCheck: options.skipHealthCheck,
        token: options.token ?? (await resolveProviderToken(provider, rawSandboxId)),
      };

      const client = providerFetch
        ? new SandboxAgent({
            ...commonConnectOptions,
            baseUrl,
            fetch: providerFetch,
          })
        : new SandboxAgent({
            ...commonConnectOptions,
            baseUrl: requireSandboxBaseUrl(baseUrl, provider.name),
          });

      client.sandboxProvider = provider;
      client.sandboxProviderId = prefixedSandboxId;
      client.sandboxProviderRawId = rawSandboxId;
      client.sandboxInspectorUrl = inspectorUrl;
      return client;
    } catch (error) {
      if (createdSandbox) {
        try {
          await provider.destroy(rawSandboxId);
        } catch {
          // Best-effort cleanup if connect fails after provisioning.
        }
      }
      throw error;
    }
  }

  get sandboxId(): string | undefined {
    return this.sandboxProviderId;
  }

  get sandbox(): SandboxProvider | undefined {
    return this.sandboxProvider;
  }

  get inspectorUrl(): string {
    return this.sandboxInspectorUrl ?? `${this.baseUrl.replace(/\/+$/, "")}/ui/`;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.healthWaitAbortController.abort(createAbortError("SandboxAgent was disposed."));

    for (const [permissionId, pending] of this.pendingPermissionRequests) {
      this.pendingPermissionRequests.delete(permissionId);
      pending.resolve(cancelledPermissionResponse());
    }

    const connections = [...this.liveConnections.values()];
    this.liveConnections.clear();
    const pending = [...this.pendingLiveConnections.values()];
    this.pendingLiveConnections.clear();
    this.pendingObservedEnvelopePersistenceBySession.clear();

    const pendingSettled = await Promise.allSettled(pending);
    for (const item of pendingSettled) {
      if (item.status === "fulfilled") {
        connections.push(item.value);
      }
    }

    await Promise.all(
      connections.map(async (connection) => {
        await connection.close();
      }),
    );
  }

  async destroySandbox(): Promise<void> {
    const provider = this.sandboxProvider;
    const rawSandboxId = this.sandboxProviderRawId;

    try {
      if (provider && rawSandboxId) {
        await provider.destroy(rawSandboxId);
      } else if (!provider || !rawSandboxId) {
        throw new Error("SandboxAgent is not attached to a provisioned sandbox.");
      }
    } finally {
      await this.dispose();
      this.sandboxProvider = undefined;
      this.sandboxProviderId = undefined;
      this.sandboxProviderRawId = undefined;
    }
  }

  async pauseSandbox(): Promise<void> {
    const provider = this.sandboxProvider;
    const rawSandboxId = this.sandboxProviderRawId;

    try {
      if (provider && rawSandboxId) {
        if (provider.pause) {
          await provider.pause(rawSandboxId);
        } else {
          await provider.destroy(rawSandboxId);
        }
      } else if (!provider || !rawSandboxId) {
        throw new Error("SandboxAgent is not attached to a provisioned sandbox.");
      }
    } finally {
      await this.dispose();
      this.sandboxProvider = undefined;
      this.sandboxProviderId = undefined;
      this.sandboxProviderRawId = undefined;
    }
  }

  async killSandbox(): Promise<void> {
    const provider = this.sandboxProvider;
    const rawSandboxId = this.sandboxProviderRawId;

    try {
      if (provider && rawSandboxId) {
        if (provider.kill) {
          await provider.kill(rawSandboxId);
        } else {
          await provider.destroy(rawSandboxId);
        }
      } else if (!provider || !rawSandboxId) {
        throw new Error("SandboxAgent is not attached to a provisioned sandbox.");
      }
    } finally {
      await this.dispose();
      this.sandboxProvider = undefined;
      this.sandboxProviderId = undefined;
      this.sandboxProviderRawId = undefined;
    }
  }

  async listSessions(request: ListPageRequest = {}): Promise<ListPage<Session>> {
    const page = await this.persist.listSessions(request);
    return {
      items: page.items.map((record) => this.upsertSessionHandle(record)),
      nextCursor: page.nextCursor,
    };
  }

  async getSession(id: string): Promise<Session | null> {
    const record = await this.persist.getSession(id);
    if (!record) {
      return null;
    }
    return this.upsertSessionHandle(record);
  }

  async getEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>> {
    return this.persist.listEvents(request);
  }

  async createSession(request: SessionCreateRequest): Promise<Session> {
    if (!request.agent.trim()) {
      throw new Error("createSession requires a non-empty agent");
    }

    const localSessionId = request.id?.trim() || randomId();
    const live = await this.getLiveConnection(request.agent.trim());
    const sessionInit = normalizeSessionInit(request.sessionInit, request.cwd, this.sandboxProvider?.defaultCwd);

    const response = await live.createRemoteSession(localSessionId, sessionInit);

    const record: SessionRecord = {
      id: localSessionId,
      agent: request.agent.trim(),
      agentSessionId: response.sessionId,
      lastConnectionId: live.connectionId,
      createdAt: nowMs(),
      sandboxId: this.sandboxProviderId,
      sessionInit,
      configOptions: cloneConfigOptions(response.configOptions),
      modes: cloneModes(response.modes),
    };

    await this.persist.updateSession(record);
    live.bindSession(record.id, record.agentSessionId);
    let session = this.upsertSessionHandle(record);

    try {
      if (request.mode) {
        session = (await this.setSessionMode(session.id, request.mode)).session;
      }
      if (request.model) {
        session = (await this.setSessionModel(session.id, request.model)).session;
      }
      if (request.thoughtLevel) {
        session = (await this.setSessionThoughtLevel(session.id, request.thoughtLevel)).session;
      }
    } catch (err) {
      try {
        await this.destroySession(session.id);
      } catch {
        // Best-effort cleanup
      }
      throw err;
    }

    return session;
  }

  async resumeSession(id: string): Promise<Session> {
    const existing = await this.persist.getSession(id);
    if (!existing) {
      throw new Error(`session '${id}' not found`);
    }

    const live = await this.getLiveConnection(existing.agent);
    if (existing.lastConnectionId === live.connectionId && live.hasBoundSession(id, existing.agentSessionId)) {
      return this.upsertSessionHandle(existing);
    }

    const replaySource = await this.collectReplayEvents(existing.id, this.replayMaxEvents);
    const replayText = buildReplayText(replaySource, this.replayMaxChars);

    const recreated = await live.createRemoteSession(existing.id, normalizeSessionInit(existing.sessionInit, undefined, this.sandboxProvider?.defaultCwd));

    const updated: SessionRecord = {
      ...existing,
      agentSessionId: recreated.sessionId,
      lastConnectionId: live.connectionId,
      destroyedAt: undefined,
      configOptions: cloneConfigOptions(recreated.configOptions),
      modes: cloneModes(recreated.modes),
    };

    await this.persist.updateSession(updated);
    live.bindSession(updated.id, updated.agentSessionId);
    live.queueReplay(updated.id, replayText);

    return this.upsertSessionHandle(updated);
  }

  async resumeOrCreateSession(request: SessionResumeOrCreateRequest): Promise<Session> {
    const existing = await this.persist.getSession(request.id);
    if (existing) {
      let session = await this.resumeSession(existing.id);
      if (request.mode) {
        session = (await this.setSessionMode(session.id, request.mode)).session;
      }
      if (request.model) {
        session = (await this.setSessionModel(session.id, request.model)).session;
      }
      if (request.thoughtLevel) {
        session = (await this.setSessionThoughtLevel(session.id, request.thoughtLevel)).session;
      }
      return session;
    }
    return this.createSession(request);
  }

  async destroySession(id: string): Promise<Session> {
    this.cancelPendingPermissionsForSession(id);

    try {
      await this.sendSessionMethodInternal(id, SESSION_CANCEL_METHOD, {}, {}, true);
    } catch {
      // Best-effort: agent may already be gone
    }
    const existing = await this.requireSessionRecord(id);

    const updated: SessionRecord = {
      ...existing,
      destroyedAt: nowMs(),
    };

    await this.persist.updateSession(updated);
    return this.upsertSessionHandle(updated);
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<{ session: Session; response: SetSessionModeResponse | void }> {
    const mode = modeId.trim();
    if (!mode) {
      throw new Error("setSessionMode requires a non-empty modeId");
    }

    const record = await this.requireSessionRecord(sessionId);
    const knownModeIds = extractKnownModeIds(record.modes);
    if (knownModeIds.length > 0 && !knownModeIds.includes(mode)) {
      throw new UnsupportedSessionValueError(sessionId, "mode", "mode", mode, knownModeIds);
    }

    try {
      return (await this.sendSessionMethodInternal(sessionId, "session/set_mode", { modeId: mode }, {}, false)) as {
        session: Session;
        response: SetSessionModeResponse | void;
      };
    } catch (error) {
      if (!(error instanceof AcpRpcError) || error.code !== -32601) {
        throw error;
      }
      return this.setSessionCategoryValue(sessionId, "mode", mode);
    }
  }

  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<{ session: Session; response: SetSessionConfigOptionResponse }> {
    const resolvedConfigId = configId.trim();
    if (!resolvedConfigId) {
      throw new Error("setSessionConfigOption requires a non-empty configId");
    }
    const resolvedValue = value.trim();
    if (!resolvedValue) {
      throw new Error("setSessionConfigOption requires a non-empty value");
    }

    const options = await this.getSessionConfigOptions(sessionId);
    const option = findConfigOptionById(options, resolvedConfigId);
    if (!option) {
      throw new UnsupportedSessionConfigOptionError(
        sessionId,
        resolvedConfigId,
        options.map((item) => item.id),
      );
    }

    const allowedValues = extractConfigValues(option);
    if (allowedValues.length > 0 && !allowedValues.includes(resolvedValue)) {
      throw new UnsupportedSessionValueError(sessionId, option.category ?? "uncategorized", option.id, resolvedValue, allowedValues);
    }

    return (await this.sendSessionMethodInternal(
      sessionId,
      "session/set_config_option",
      {
        configId: resolvedConfigId,
        value: resolvedValue,
      },
      {},
      false,
    )) as { session: Session; response: SetSessionConfigOptionResponse };
  }

  async setSessionModel(sessionId: string, model: string): Promise<{ session: Session; response: SetSessionConfigOptionResponse }> {
    return this.setSessionCategoryValue(sessionId, "model", model);
  }

  async setSessionThoughtLevel(sessionId: string, thoughtLevel: string): Promise<{ session: Session; response: SetSessionConfigOptionResponse }> {
    return this.setSessionCategoryValue(sessionId, "thought_level", thoughtLevel);
  }

  async getSessionConfigOptions(sessionId: string): Promise<SessionConfigOption[]> {
    const record = await this.requireSessionRecord(sessionId);
    const hydrated = await this.hydrateSessionConfigOptions(record.id, record);
    return cloneConfigOptions(hydrated.configOptions) ?? [];
  }

  async getSessionModes(sessionId: string): Promise<SessionModeState | null> {
    const record = await this.requireSessionRecord(sessionId);
    if (record.modes && record.modes.availableModes.length > 0) {
      return cloneModes(record.modes);
    }

    const hydrated = await this.hydrateSessionConfigOptions(record.id, record);
    if (hydrated.modes && hydrated.modes.availableModes.length > 0) {
      return cloneModes(hydrated.modes);
    }

    const derived = deriveModesFromConfigOptions(hydrated.configOptions);
    if (!derived) {
      return cloneModes(hydrated.modes);
    }

    const updated: SessionRecord = {
      ...hydrated,
      modes: derived,
    };
    await this.persist.updateSession(updated);
    return cloneModes(derived);
  }

  private async setSessionCategoryValue(
    sessionId: string,
    category: string,
    value: string,
  ): Promise<{ session: Session; response: SetSessionConfigOptionResponse }> {
    const resolvedValue = value.trim();
    if (!resolvedValue) {
      throw new Error(`setSession${toTitleCase(category)} requires a non-empty value`);
    }

    const options = await this.getSessionConfigOptions(sessionId);
    const option = findConfigOptionByCategory(options, category);
    if (!option) {
      const categories = uniqueCategories(options);
      throw new UnsupportedSessionCategoryError(sessionId, category, categories);
    }

    const allowedValues = extractConfigValues(option);
    if (allowedValues.length > 0 && !allowedValues.includes(resolvedValue)) {
      throw new UnsupportedSessionValueError(sessionId, category, option.id, resolvedValue, allowedValues);
    }

    return this.setSessionConfigOption(sessionId, option.id, resolvedValue);
  }

  private async hydrateSessionConfigOptions(sessionId: string, snapshot: SessionRecord): Promise<SessionRecord> {
    if (snapshot.configOptions !== undefined) {
      return snapshot;
    }

    const info = await this.getAgent(snapshot.agent, { config: true });
    let configOptions = normalizeSessionConfigOptions(info.configOptions) ?? [];
    // Re-read the record from persistence so we merge against the latest
    // state, not a stale snapshot captured before the network await.
    const record = await this.persist.getSession(sessionId);
    if (!record) {
      return { ...snapshot, configOptions };
    }

    const currentModeId = record.modes?.currentModeId;
    if (currentModeId) {
      const modeOption = findConfigOptionByCategory(configOptions, "mode");
      if (modeOption) {
        configOptions = applyConfigOptionValue(configOptions, modeOption.id, currentModeId) ?? configOptions;
      }
    }

    const updated: SessionRecord = {
      ...record,
      configOptions,
      modes: deriveModesFromConfigOptions(configOptions) ?? record.modes,
    };
    await this.persist.updateSession(updated);
    return updated;
  }

  async rawSendSessionMethod(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
    options: SessionSendOptions = {},
  ): Promise<{ session: Session; response: unknown }> {
    return this.sendSessionMethodInternal(sessionId, method, params, options, false);
  }

  private async sendSessionMethodInternal(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
    options: SessionSendOptions,
    allowManagedCancel: boolean,
  ): Promise<{ session: Session; response: unknown }> {
    if (method === SESSION_CANCEL_METHOD && !allowManagedCancel) {
      throw new Error(MANUAL_CANCEL_ERROR);
    }

    const record = await this.persist.getSession(sessionId);
    if (!record) {
      throw new Error(`session '${sessionId}' not found`);
    }

    const live = await this.getLiveConnection(record.agent);
    if (!live.hasBoundSession(record.id, record.agentSessionId)) {
      // The persisted session points at a stale connection; restore lazily.
      const restored = await this.resumeSession(record.id);
      return this.sendSessionMethodInternal(restored.id, method, params, options, allowManagedCancel);
    }

    const response = await live.sendSessionMethod(record.id, method, params, options);
    await this.persistSessionStateFromMethod(record.id, method, params, response);
    const refreshed = await this.requireSessionRecord(record.id);
    return {
      session: this.upsertSessionHandle(refreshed),
      response,
    };
  }

  private async persistSessionStateFromMethod(sessionId: string, method: string, params: Record<string, unknown>, response: unknown): Promise<void> {
    // Re-read the record from persistence so we merge against the latest
    // state, not a stale snapshot captured before the RPC await.
    const record = await this.persist.getSession(sessionId);
    if (!record) {
      return;
    }

    if (method === "session/set_config_option") {
      const configId = typeof params.configId === "string" ? params.configId : null;
      const value = typeof params.value === "string" ? params.value : null;
      const updates: Partial<SessionRecord> = {};

      const serverConfigOptions = extractConfigOptionsFromSetResponse(response);
      if (serverConfigOptions) {
        updates.configOptions = cloneConfigOptions(serverConfigOptions);
      } else if (record.configOptions && configId && value) {
        // Server didn't return configOptions — optimistically update the
        // cached currentValue so subsequent getConfigOptions() reflects the
        // change without a round-trip.
        const updated = applyConfigOptionValue(record.configOptions, configId, value);
        if (updated) {
          updates.configOptions = updated;
        }
      }

      // When a mode-category config option is set via set_config_option
      // (fallback path from setSessionMode), keep modes.currentModeId in sync.
      if (configId && value) {
        const source = updates.configOptions ?? record.configOptions;
        const option = source ? findConfigOptionById(source, configId) : null;
        if (option?.category === "mode") {
          const nextModes = applyCurrentMode(record.modes, value);
          if (nextModes) {
            updates.modes = nextModes;
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        await this.persist.updateSession({ ...record, ...updates });
      }
      return;
    }

    if (method === "session/set_mode") {
      const modeId = typeof params.modeId === "string" ? params.modeId : null;
      if (!modeId) {
        return;
      }
      const updates: Partial<SessionRecord> = {};
      const nextModes = applyCurrentMode(record.modes, modeId);
      if (nextModes) {
        updates.modes = nextModes;
      }
      // Keep configOptions mode-category currentValue in sync with the new
      // mode, mirroring the reverse sync in the set_config_option path above.
      if (record.configOptions) {
        const modeOption = findConfigOptionByCategory(record.configOptions, "mode");
        if (modeOption) {
          const updated = applyConfigOptionValue(record.configOptions, modeOption.id, modeId);
          if (updated) {
            updates.configOptions = updated;
          }
        }
      }
      if (Object.keys(updates).length > 0) {
        await this.persist.updateSession({ ...record, ...updates });
      }
    }
  }

  onSessionEvent(sessionId: string, listener: SessionEventListener): () => void {
    const listeners = this.eventListeners.get(sessionId) ?? new Set<SessionEventListener>();
    listeners.add(listener);
    this.eventListeners.set(sessionId, listeners);

    return () => {
      const set = this.eventListeners.get(sessionId);
      if (!set) {
        return;
      }
      set.delete(listener);
      if (set.size === 0) {
        this.eventListeners.delete(sessionId);
      }
    };
  }

  onPermissionRequest(sessionId: string, listener: PermissionRequestListener): () => void {
    const listeners = this.permissionListeners.get(sessionId) ?? new Set<PermissionRequestListener>();
    listeners.add(listener);
    this.permissionListeners.set(sessionId, listeners);

    return () => {
      const set = this.permissionListeners.get(sessionId);
      if (!set) {
        return;
      }
      set.delete(listener);
      if (set.size === 0) {
        this.permissionListeners.delete(sessionId);
      }
    };
  }

  async respondPermission(permissionId: string, reply: PermissionReply): Promise<void> {
    const pending = this.pendingPermissionRequests.get(permissionId);
    if (!pending) {
      throw new Error(`permission '${permissionId}' not found`);
    }

    let response: RequestPermissionResponse;
    try {
      response = permissionReplyToResponse(permissionId, pending.request, reply);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      this.pendingPermissionRequests.delete(permissionId);
      throw error;
    }
    this.resolvePendingPermission(permissionId, response);
  }

  async rawRespondPermission(permissionId: string, response: RequestPermissionResponse): Promise<void> {
    if (!this.pendingPermissionRequests.has(permissionId)) {
      throw new Error(`permission '${permissionId}' not found`);
    }
    this.resolvePendingPermission(permissionId, clonePermissionResponse(response));
  }

  async getHealth(): Promise<HealthResponse> {
    return this.requestHealth();
  }

  async startDesktop(request: DesktopStartRequest = {}): Promise<DesktopStatusResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/start`, {
      body: request,
    });
  }

  async stopDesktop(): Promise<DesktopStatusResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/stop`);
  }

  async getDesktopStatus(): Promise<DesktopStatusResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/status`);
  }

  async getDesktopDisplayInfo(): Promise<DesktopDisplayInfoResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/display/info`);
  }

  async takeDesktopScreenshot(query: DesktopScreenshotQuery = {}): Promise<Uint8Array> {
    const response = await this.requestRaw("GET", `${API_PREFIX}/desktop/screenshot`, {
      query,
      accept: "image/*",
    });
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async takeDesktopRegionScreenshot(query: DesktopRegionScreenshotQuery): Promise<Uint8Array> {
    const response = await this.requestRaw("GET", `${API_PREFIX}/desktop/screenshot/region`, {
      query,
      accept: "image/*",
    });
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async getDesktopMousePosition(): Promise<DesktopMousePositionResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/mouse/position`);
  }

  async moveDesktopMouse(request: DesktopMouseMoveRequest): Promise<DesktopMousePositionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/mouse/move`, {
      body: request,
    });
  }

  async clickDesktop(request: DesktopMouseClickRequest): Promise<DesktopMousePositionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/mouse/click`, {
      body: request,
    });
  }

  async mouseDownDesktop(request: DesktopMouseDownRequest): Promise<DesktopMousePositionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/mouse/down`, {
      body: request,
    });
  }

  async mouseUpDesktop(request: DesktopMouseUpRequest): Promise<DesktopMousePositionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/mouse/up`, {
      body: request,
    });
  }

  async dragDesktopMouse(request: DesktopMouseDragRequest): Promise<DesktopMousePositionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/mouse/drag`, {
      body: request,
    });
  }

  async scrollDesktop(request: DesktopMouseScrollRequest): Promise<DesktopMousePositionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/mouse/scroll`, {
      body: request,
    });
  }

  async typeDesktopText(request: DesktopKeyboardTypeRequest): Promise<DesktopActionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/keyboard/type`, {
      body: request,
    });
  }

  async pressDesktopKey(request: DesktopKeyboardPressRequest): Promise<DesktopActionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/keyboard/press`, {
      body: request,
    });
  }

  async keyDownDesktop(request: DesktopKeyboardDownRequest): Promise<DesktopActionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/keyboard/down`, {
      body: request,
    });
  }

  async keyUpDesktop(request: DesktopKeyboardUpRequest): Promise<DesktopActionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/keyboard/up`, {
      body: request,
    });
  }

  async listDesktopWindows(): Promise<DesktopWindowListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/windows`);
  }

  async getDesktopFocusedWindow(): Promise<DesktopWindowInfo> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/windows/focused`);
  }

  async focusDesktopWindow(windowId: string): Promise<DesktopWindowInfo> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/windows/${encodeURIComponent(windowId)}/focus`);
  }

  async moveDesktopWindow(windowId: string, request: DesktopWindowMoveRequest): Promise<DesktopWindowInfo> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/windows/${encodeURIComponent(windowId)}/move`, {
      body: request,
    });
  }

  async resizeDesktopWindow(windowId: string, request: DesktopWindowResizeRequest): Promise<DesktopWindowInfo> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/windows/${encodeURIComponent(windowId)}/resize`, {
      body: request,
    });
  }

  async getDesktopClipboard(query: DesktopClipboardQuery = {}): Promise<DesktopClipboardResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/clipboard`, {
      query,
    });
  }

  async setDesktopClipboard(request: DesktopClipboardWriteRequest): Promise<DesktopActionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/clipboard`, {
      body: request,
    });
  }

  async launchDesktopApp(request: DesktopLaunchRequest): Promise<DesktopLaunchResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/launch`, {
      body: request,
    });
  }

  async openDesktopTarget(request: DesktopOpenRequest): Promise<DesktopOpenResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/open`, {
      body: request,
    });
  }

  async getDesktopStreamStatus(): Promise<DesktopStreamStatusResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/stream/status`);
  }

  async startDesktopRecording(request: DesktopRecordingStartRequest = {}): Promise<DesktopRecordingInfo> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/recording/start`, {
      body: request,
    });
  }

  async stopDesktopRecording(): Promise<DesktopRecordingInfo> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/recording/stop`);
  }

  async listDesktopRecordings(): Promise<DesktopRecordingListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/recordings`);
  }

  async getDesktopRecording(id: string): Promise<DesktopRecordingInfo> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/recordings/${encodeURIComponent(id)}`);
  }

  async downloadDesktopRecording(id: string): Promise<Uint8Array> {
    const response = await this.requestRaw("GET", `${API_PREFIX}/desktop/recordings/${encodeURIComponent(id)}/download`, {
      accept: "video/mp4",
    });
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async deleteDesktopRecording(id: string): Promise<void> {
    await this.requestRaw("DELETE", `${API_PREFIX}/desktop/recordings/${encodeURIComponent(id)}`);
  }

  async startDesktopStream(): Promise<DesktopStreamStatusResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/stream/start`);
  }

  async stopDesktopStream(): Promise<DesktopStreamStatusResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/stream/stop`);
  }

  async listAgents(options?: AgentQueryOptions): Promise<AgentListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/agents`, {
      query: toAgentQuery(options),
    });
  }

  async getAgent(agent: string, options?: AgentQueryOptions): Promise<AgentInfo> {
    try {
      return await this.requestJson("GET", `${API_PREFIX}/agents/${encodeURIComponent(agent)}`, {
        query: toAgentQuery(options),
      });
    } catch (error) {
      if (!(error instanceof SandboxAgentError) || error.status !== 404) {
        throw error;
      }

      const listed = await this.listAgents(options);
      const match = listed.agents.find((entry) => entry.id === agent);
      if (match) {
        return match;
      }
      throw error;
    }
  }

  async installAgent(agent: string, request: AgentInstallRequest = {}): Promise<AgentInstallResponse> {
    return this.requestJson("POST", `${API_PREFIX}/agents/${encodeURIComponent(agent)}/install`, {
      body: request,
    });
  }

  async listAcpServers(): Promise<AcpServerListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/acp`);
  }

  async listFsEntries(query: FsEntriesQuery = {}): Promise<FsEntry[]> {
    return this.requestJson("GET", `${FS_PATH}/entries`, {
      query,
    });
  }

  async readFsFile(query: FsPathQuery): Promise<Uint8Array> {
    const response = await this.requestRaw("GET", `${FS_PATH}/file`, {
      query,
      accept: "application/octet-stream",
    });
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async writeFsFile(query: FsPathQuery, body: BodyInit): Promise<FsWriteResponse> {
    const response = await this.requestRaw("PUT", `${FS_PATH}/file`, {
      query,
      rawBody: body,
      contentType: "application/octet-stream",
      accept: "application/json",
    });
    return (await response.json()) as FsWriteResponse;
  }

  async deleteFsEntry(query: FsDeleteQuery): Promise<FsActionResponse> {
    return this.requestJson("DELETE", `${FS_PATH}/entry`, { query });
  }

  async mkdirFs(query: FsPathQuery): Promise<FsActionResponse> {
    return this.requestJson("POST", `${FS_PATH}/mkdir`, { query });
  }

  async moveFs(request: FsMoveRequest): Promise<FsMoveResponse> {
    return this.requestJson("POST", `${FS_PATH}/move`, { body: request });
  }

  async statFs(query: FsPathQuery): Promise<FsStat> {
    return this.requestJson("GET", `${FS_PATH}/stat`, { query });
  }

  async uploadFsBatch(body: BodyInit, query?: FsUploadBatchQuery): Promise<FsUploadBatchResponse> {
    const response = await this.requestRaw("POST", `${FS_PATH}/upload-batch`, {
      query,
      rawBody: body,
      contentType: "application/x-tar",
      accept: "application/json",
    });
    return (await response.json()) as FsUploadBatchResponse;
  }

  async getMcpConfig(query: McpConfigQuery): Promise<McpServerConfig> {
    return this.requestJson("GET", `${API_PREFIX}/config/mcp`, { query });
  }

  async setMcpConfig(query: McpConfigQuery, config: McpServerConfig): Promise<void> {
    await this.requestRaw("PUT", `${API_PREFIX}/config/mcp`, { query, body: config });
  }

  async deleteMcpConfig(query: McpConfigQuery): Promise<void> {
    await this.requestRaw("DELETE", `${API_PREFIX}/config/mcp`, { query });
  }

  async getSkillsConfig(query: SkillsConfigQuery): Promise<SkillsConfig> {
    return this.requestJson("GET", `${API_PREFIX}/config/skills`, { query });
  }

  async setSkillsConfig(query: SkillsConfigQuery, config: SkillsConfig): Promise<void> {
    await this.requestRaw("PUT", `${API_PREFIX}/config/skills`, { query, body: config });
  }

  async deleteSkillsConfig(query: SkillsConfigQuery): Promise<void> {
    await this.requestRaw("DELETE", `${API_PREFIX}/config/skills`, { query });
  }

  async getProcessConfig(): Promise<ProcessConfig> {
    return this.requestJson("GET", `${API_PREFIX}/processes/config`);
  }

  async setProcessConfig(config: ProcessConfig): Promise<ProcessConfig> {
    return this.requestJson("POST", `${API_PREFIX}/processes/config`, {
      body: config,
    });
  }

  async createProcess(request: ProcessCreateRequest): Promise<ProcessInfo> {
    return this.requestJson("POST", `${API_PREFIX}/processes`, {
      body: request,
    });
  }

  async runProcess(request: ProcessRunRequest): Promise<ProcessRunResponse> {
    return this.requestJson("POST", `${API_PREFIX}/processes/run`, {
      body: request,
    });
  }

  async listProcesses(query?: ProcessListQuery): Promise<ProcessListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/processes`, {
      query,
    });
  }

  async getProcess(id: string): Promise<ProcessInfo> {
    return this.requestJson("GET", `${API_PREFIX}/processes/${encodeURIComponent(id)}`);
  }

  async stopProcess(id: string, query?: ProcessSignalQuery): Promise<ProcessInfo> {
    return this.requestJson("POST", `${API_PREFIX}/processes/${encodeURIComponent(id)}/stop`, {
      query,
    });
  }

  async killProcess(id: string, query?: ProcessSignalQuery): Promise<ProcessInfo> {
    return this.requestJson("POST", `${API_PREFIX}/processes/${encodeURIComponent(id)}/kill`, {
      query,
    });
  }

  async deleteProcess(id: string): Promise<void> {
    await this.requestRaw("DELETE", `${API_PREFIX}/processes/${encodeURIComponent(id)}`);
  }

  async getProcessLogs(id: string, query: ProcessLogFollowQuery = {}): Promise<ProcessLogsResponse> {
    return this.requestJson("GET", `${API_PREFIX}/processes/${encodeURIComponent(id)}/logs`, {
      query,
    });
  }

  async followProcessLogs(id: string, listener: ProcessLogListener, query: ProcessLogFollowQuery = {}): Promise<ProcessLogSubscription> {
    const abortController = new AbortController();
    const response = await this.requestRaw("GET", `${API_PREFIX}/processes/${encodeURIComponent(id)}/logs`, {
      query: { ...query, follow: true },
      accept: "text/event-stream",
      signal: abortController.signal,
    });

    if (!response.body) {
      abortController.abort();
      throw new Error("SSE stream is not readable in this environment.");
    }

    const closed = consumeProcessLogSse(response.body, listener, abortController.signal);

    return {
      close: () => abortController.abort(),
      closed,
    };
  }

  async sendProcessInput(id: string, request: ProcessInputRequest): Promise<ProcessInputResponse> {
    return this.requestJson("POST", `${API_PREFIX}/processes/${encodeURIComponent(id)}/input`, {
      body: request,
    });
  }

  async resizeProcessTerminal(id: string, request: ProcessTerminalResizeRequest): Promise<ProcessTerminalResizeResponse> {
    return this.requestJson("POST", `${API_PREFIX}/processes/${encodeURIComponent(id)}/terminal/resize`, {
      body: request,
    });
  }

  buildProcessTerminalWebSocketUrl(id: string, options: ProcessTerminalWebSocketUrlOptions = {}): string {
    return toWebSocketUrl(
      this.buildUrl(`${API_PREFIX}/processes/${encodeURIComponent(id)}/terminal/ws`, {
        access_token: options.accessToken ?? this.token,
      }),
    );
  }

  connectProcessTerminalWebSocket(id: string, options: ProcessTerminalConnectOptions = {}): WebSocket {
    const WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new Error("WebSocket API is not available; provide a WebSocket implementation.");
    }

    return new WebSocketCtor(
      this.buildProcessTerminalWebSocketUrl(id, {
        accessToken: options.accessToken,
      }),
      options.protocols,
    );
  }

  connectProcessTerminal(id: string, options: ProcessTerminalSessionOptions = {}): ProcessTerminalSession {
    return new ProcessTerminalSession(this.connectProcessTerminalWebSocket(id, options));
  }

  buildDesktopStreamWebSocketUrl(options: ProcessTerminalWebSocketUrlOptions = {}): string {
    return toWebSocketUrl(
      this.buildUrl(`${API_PREFIX}/desktop/stream/signaling`, {
        access_token: options.accessToken ?? this.token,
      }),
    );
  }

  connectDesktopStreamWebSocket(options: DesktopStreamConnectOptions = {}): WebSocket {
    const WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new Error("WebSocket API is not available; provide a WebSocket implementation.");
    }

    return new WebSocketCtor(
      this.buildDesktopStreamWebSocketUrl({
        accessToken: options.accessToken,
      }),
      options.protocols,
    );
  }

  connectDesktopStream(options: DesktopStreamSessionOptions = {}): DesktopStreamSession {
    return new DesktopStreamSession(this.connectDesktopStreamWebSocket(options));
  }

  private async getLiveConnection(agent: string): Promise<LiveAcpConnection> {
    await this.awaitHealthy();

    const existing = this.liveConnections.get(agent);
    if (existing) {
      return existing;
    }

    const pending = this.pendingLiveConnections.get(agent);
    if (pending) {
      return pending;
    }

    const creating = (async () => {
      const serverId = `sdk-${agent}-${randomId()}`;
      const created = await LiveAcpConnection.create({
        baseUrl: this.baseUrl,
        token: this.token,
        fetcher: this.fetcher,
        headers: this.defaultHeaders,
        agent,
        serverId,
        onObservedEnvelope: (connection, envelope, direction, localSessionId) => {
          void this.enqueueObservedEnvelopePersistence(connection, envelope, direction, localSessionId).catch((error) => {
            console.error("Failed to persist observed sandbox-agent envelope", error);
          });
        },
        onPermissionRequest: async (connection, localSessionId, agentSessionId, request) =>
          this.enqueuePermissionRequest(connection, localSessionId, agentSessionId, request),
      });

      const raced = this.liveConnections.get(agent);
      if (raced) {
        await created.close();
        return raced;
      }

      this.liveConnections.set(agent, created);
      return created;
    })();

    this.pendingLiveConnections.set(agent, creating);
    try {
      return await creating;
    } finally {
      if (this.pendingLiveConnections.get(agent) === creating) {
        this.pendingLiveConnections.delete(agent);
      }
    }
  }

  private async persistObservedEnvelope(
    connection: LiveAcpConnection,
    envelope: AnyMessage,
    direction: AcpEnvelopeDirection,
    localSessionId: string | null,
  ): Promise<void> {
    if (!localSessionId) {
      return;
    }

    let event: SessionEvent | null = null;
    for (let attempt = 0; attempt < MAX_EVENT_INDEX_INSERT_RETRIES; attempt += 1) {
      event = {
        id: randomId(),
        eventIndex: await this.allocateSessionEventIndex(localSessionId),
        sessionId: localSessionId,
        createdAt: nowMs(),
        connectionId: connection.connectionId,
        sender: direction === "outbound" ? "client" : "agent",
        payload: cloneEnvelope(envelope),
      };

      try {
        await this.persist.insertEvent(localSessionId, event);
        break;
      } catch (error) {
        if (!isSessionEventIndexConflict(error) || attempt === MAX_EVENT_INDEX_INSERT_RETRIES - 1) {
          throw error;
        }
      }
    }

    if (!event) {
      return;
    }

    await this.persistSessionStateFromEvent(localSessionId, envelope, direction);

    const listeners = this.eventListeners.get(localSessionId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  private async enqueueObservedEnvelopePersistence(
    connection: LiveAcpConnection,
    envelope: AnyMessage,
    direction: AcpEnvelopeDirection,
    localSessionId: string | null,
  ): Promise<void> {
    if (!localSessionId) {
      return;
    }

    const previous = this.pendingObservedEnvelopePersistenceBySession.get(localSessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // Keep later envelope persistence moving even if an earlier write failed.
      })
      .then(() => this.persistObservedEnvelope(connection, envelope, direction, localSessionId));

    this.pendingObservedEnvelopePersistenceBySession.set(localSessionId, current);

    try {
      await current;
    } finally {
      if (this.pendingObservedEnvelopePersistenceBySession.get(localSessionId) === current) {
        this.pendingObservedEnvelopePersistenceBySession.delete(localSessionId);
      }
    }
  }

  private async persistSessionStateFromEvent(sessionId: string, envelope: AnyMessage, direction: AcpEnvelopeDirection): Promise<void> {
    if (direction !== "inbound") {
      return;
    }

    if (envelopeMethod(envelope) !== "session/update") {
      return;
    }

    const update = envelopeSessionUpdate(envelope);
    if (!update || typeof update.sessionUpdate !== "string") {
      return;
    }

    const record = await this.persist.getSession(sessionId);
    if (!record) {
      return;
    }

    if (update.sessionUpdate === "config_option_update") {
      const configOptions = normalizeSessionConfigOptions(update.configOptions);
      if (configOptions) {
        await this.persist.updateSession({
          ...record,
          configOptions,
        });
      }
      return;
    }

    if (update.sessionUpdate === "current_mode_update") {
      const modeId = typeof update.currentModeId === "string" ? update.currentModeId : null;
      if (!modeId) {
        return;
      }
      const nextModes = applyCurrentMode(record.modes, modeId);
      if (!nextModes) {
        return;
      }
      await this.persist.updateSession({
        ...record,
        modes: nextModes,
      });
    }
  }

  private async allocateSessionEventIndex(sessionId: string): Promise<number> {
    await this.ensureSessionEventIndexSeeded(sessionId);
    const nextIndex = this.nextSessionEventIndexBySession.get(sessionId) ?? 1;
    this.nextSessionEventIndexBySession.set(sessionId, nextIndex + 1);
    return nextIndex;
  }

  private async ensureSessionEventIndexSeeded(sessionId: string): Promise<void> {
    if (this.nextSessionEventIndexBySession.has(sessionId)) {
      return;
    }

    if (!this.seedSessionEventIndexBySession.has(sessionId)) {
      const pending = (async () => {
        const maxPersistedIndex = await this.findMaxPersistedSessionEventIndex(sessionId);
        this.nextSessionEventIndexBySession.set(sessionId, Math.max(1, maxPersistedIndex + 1));
      })().finally(() => {
        this.seedSessionEventIndexBySession.delete(sessionId);
      });
      this.seedSessionEventIndexBySession.set(sessionId, pending);
    }

    const pending = this.seedSessionEventIndexBySession.get(sessionId);
    if (pending) {
      await pending;
    }
  }

  private async findMaxPersistedSessionEventIndex(sessionId: string): Promise<number> {
    let maxIndex = 0;
    let eventCursor: string | undefined;

    while (true) {
      const eventsPage = await this.persist.listEvents({
        sessionId,
        cursor: eventCursor,
        limit: EVENT_INDEX_SCAN_EVENTS_LIMIT,
      });

      for (const event of eventsPage.items) {
        if (Number.isFinite(event.eventIndex) && event.eventIndex > maxIndex) {
          maxIndex = Math.floor(event.eventIndex);
        }
      }

      if (!eventsPage.nextCursor) {
        break;
      }
      eventCursor = eventsPage.nextCursor;
    }

    return maxIndex;
  }

  private async collectReplayEvents(sessionId: string, maxEvents: number): Promise<SessionEvent[]> {
    const all: SessionEvent[] = [];
    let cursor: string | undefined;

    while (true) {
      const page = await this.persist.listEvents({
        sessionId,
        cursor,
        limit: Math.max(100, maxEvents),
      });

      all.push(...page.items);

      if (!page.nextCursor) {
        break;
      }

      cursor = page.nextCursor;
    }

    return all.slice(-maxEvents);
  }

  private upsertSessionHandle(record: SessionRecord): Session {
    const existing = this.sessionHandles.get(record.id);
    if (existing) {
      existing.apply(record);
      return existing;
    }

    const created = new Session(this, record);
    this.sessionHandles.set(record.id, created);
    return created;
  }

  private async requireSessionRecord(id: string): Promise<SessionRecord> {
    const record = await this.persist.getSession(id);
    if (!record) {
      throw new Error(`session '${id}' not found`);
    }
    return record;
  }

  private async enqueuePermissionRequest(
    _connection: LiveAcpConnection,
    localSessionId: string,
    agentSessionId: string,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const listeners = this.permissionListeners.get(localSessionId);
    if (!listeners || listeners.size === 0) {
      return cancelledPermissionResponse();
    }

    const pendingId = randomId();
    const permissionRequest: SessionPermissionRequest = {
      id: pendingId,
      createdAt: nowMs(),
      sessionId: localSessionId,
      agentSessionId,
      availableReplies: availablePermissionReplies(request.options),
      options: request.options.map(clonePermissionOption),
      toolCall: clonePermissionToolCall(request.toolCall),
      rawRequest: clonePermissionRequest(request),
    };

    return await new Promise<RequestPermissionResponse>((resolve, reject) => {
      this.pendingPermissionRequests.set(pendingId, {
        id: pendingId,
        sessionId: localSessionId,
        request: clonePermissionRequest(request),
        resolve,
        reject,
      });

      try {
        for (const listener of listeners) {
          listener(permissionRequest);
        }
      } catch (error) {
        this.pendingPermissionRequests.delete(pendingId);
        reject(error);
      }
    });
  }

  private resolvePendingPermission(permissionId: string, response: RequestPermissionResponse): void {
    const pending = this.pendingPermissionRequests.get(permissionId);
    if (!pending) {
      throw new Error(`permission '${permissionId}' not found`);
    }

    this.pendingPermissionRequests.delete(permissionId);
    pending.resolve(response);
  }

  private cancelPendingPermissionsForSession(sessionId: string): void {
    for (const [permissionId, pending] of this.pendingPermissionRequests) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      this.pendingPermissionRequests.delete(permissionId);
      pending.resolve(cancelledPermissionResponse());
    }
  }

  private async requestJson<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.requestRaw(method, path, {
      query: options.query,
      body: options.body,
      headers: options.headers,
      accept: options.accept ?? "application/json",
      signal: options.signal,
      skipReadyWait: options.skipReadyWait,
    });

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async requestRaw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    if (!options.skipReadyWait) {
      await this.awaitHealthy(options.signal);
    }

    const url = this.buildUrl(path, options.query);
    const headers = this.buildHeaders(options.headers);

    if (options.accept) {
      headers.set("Accept", options.accept);
    }

    const init: RequestInit = {
      method,
      headers,
      signal: options.signal,
    };

    if (options.rawBody !== undefined && options.body !== undefined) {
      throw new Error("requestRaw received both rawBody and body");
    }

    if (options.rawBody !== undefined) {
      if (options.contentType) {
        headers.set("Content-Type", options.contentType);
      }
      init.body = options.rawBody;
    } else if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(options.body);
    }

    const response = await this.fetcher(url, init);
    if (!response.ok) {
      const problem = await readProblem(response);
      throw new SandboxAgentError(response.status, problem, response);
    }

    return response;
  }

  private startHealthWait(): void {
    if (!this.healthWait.enabled || this.healthPromise) {
      return;
    }

    this.healthPromise = this.runHealthWait().catch((error) => {
      this.healthError = error instanceof Error ? error : new Error(String(error));
    });
  }

  private async awaitHealthy(signal?: AbortSignal): Promise<void> {
    if (!this.healthPromise) {
      throwIfAborted(signal);
      return;
    }

    await waitForAbortable(this.healthPromise, signal);
    throwIfAborted(signal);
    if (this.healthError) {
      throw this.healthError;
    }
  }

  private async runHealthWait(): Promise<void> {
    const signal = this.healthWait.enabled ? anyAbortSignal([this.healthWait.signal, this.healthWaitAbortController.signal]) : undefined;
    const startedAt = Date.now();
    const deadline = typeof this.healthWait.timeoutMs === "number" ? startedAt + this.healthWait.timeoutMs : undefined;

    let delayMs = HEALTH_WAIT_MIN_DELAY_MS;
    let nextLogAt = startedAt + HEALTH_WAIT_LOG_AFTER_MS;
    let lastError: unknown;
    let consecutiveFailures = 0;

    while (!this.disposed && (deadline === undefined || Date.now() < deadline)) {
      throwIfAborted(signal);

      try {
        const health = await this.requestHealth({ signal });
        if (health.status === "ok") {
          return;
        }
        lastError = new Error(`Unexpected health response: ${JSON.stringify(health)}`);
        consecutiveFailures++;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        lastError = error;
        consecutiveFailures++;
      }

      if (consecutiveFailures >= HEALTH_WAIT_ENSURE_SERVER_AFTER_FAILURES && this.sandboxProvider?.ensureServer && this.sandboxProviderRawId) {
        try {
          await this.sandboxProvider.ensureServer(this.sandboxProviderRawId);
        } catch {
          // Best-effort; the next health check will determine if it worked.
        }
        consecutiveFailures = 0;
      }

      const now = Date.now();
      if (now >= nextLogAt) {
        const details = formatHealthWaitError(lastError);
        console.warn(`sandbox-agent at ${this.baseUrl} is not healthy after ${now - startedAt}ms; still waiting (${details})`);
        nextLogAt = now + HEALTH_WAIT_LOG_EVERY_MS;
      }

      await sleep(delayMs, signal);
      delayMs = Math.min(HEALTH_WAIT_MAX_DELAY_MS, delayMs * 2);
    }

    if (this.disposed) {
      return;
    }

    throw new Error(`Timed out waiting for sandbox-agent health after ${this.healthWait.timeoutMs}ms (${formatHealthWaitError(lastError)})`);
  }

  private buildHeaders(extra?: HeadersInit): Headers {
    const headers = new Headers(this.defaultHeaders ?? undefined);

    if (this.token) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }

    if (extra) {
      const merged = new Headers(extra);
      merged.forEach((value, key) => headers.set(key, value));
    }

    return headers;
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path}`);

    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value === undefined || value === null) {
          return;
        }
        url.searchParams.set(key, String(value));
      });
    }

    return url.toString();
  }

  private async requestHealth(options: { signal?: AbortSignal } = {}): Promise<HealthResponse> {
    return this.requestJson("GET", `${API_PREFIX}/health`, {
      signal: options.signal,
      skipReadyWait: true,
    });
  }
}

function isSessionEventIndexConflict(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /UNIQUE constraint failed: .*session_id, .*event_index/.test(error.message);
}

type PendingPermissionRequestState = {
  id: string;
  sessionId: string;
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
  reject: (reason?: unknown) => void;
};

type QueryValue = string | number | boolean | null | undefined;

type RequestOptions = {
  query?: Record<string, QueryValue>;
  body?: unknown;
  rawBody?: BodyInit;
  contentType?: string;
  headers?: HeadersInit;
  accept?: string;
  signal?: AbortSignal;
  skipReadyWait?: boolean;
};

type NormalizedHealthWaitOptions = { enabled: false; timeoutMs?: undefined; signal?: undefined } | { enabled: true; timeoutMs?: number; signal?: AbortSignal };

function parseProcessTerminalServerFrame(payload: string): ProcessTerminalServerFrame | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return null;
    }

    if (parsed.type === "ready" && typeof parsed.processId === "string") {
      return parsed as ProcessTerminalServerFrame;
    }

    if (parsed.type === "exit" && (parsed.exitCode === undefined || parsed.exitCode === null || typeof parsed.exitCode === "number")) {
      return parsed as ProcessTerminalServerFrame;
    }

    if (parsed.type === "error" && typeof parsed.message === "string") {
      return parsed as ProcessTerminalServerFrame;
    }
  } catch {
    return null;
  }

  return null;
}

function encodeTerminalInput(data: string | ArrayBuffer | ArrayBufferView): { data: string; encoding?: "base64" } {
  if (typeof data === "string") {
    return { data };
  }

  const bytes = encodeTerminalBytes(data);
  return {
    data: bytesToBase64(bytes),
    encoding: "base64",
  };
}

function encodeTerminalBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
}

async function decodeTerminalBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }

  throw new Error(`Unsupported terminal frame payload: ${String(data)}`);
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  if (typeof btoa === "function") {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  throw new Error("Base64 encoding is not available in this environment.");
}

/**
 * Auto-select and call `authenticate` based on the agent's advertised auth methods.
 * Prefers env-var-based methods that the server process already has configured.
 */
async function autoAuthenticate(acp: AcpHttpClient, methods: AuthMethod[]): Promise<void> {
  // Only attempt env-var-based methods that the server process can satisfy
  // automatically.  Interactive methods (e.g. "claude-login") cannot be
  // fulfilled programmatically and must be skipped.
  const envBased = methods.find((m) => m.id === "codex-api-key" || m.id === "openai-api-key" || m.id === "anthropic-api-key");

  if (!envBased) {
    return;
  }

  try {
    await acp.authenticate({ methodId: envBased.id });
  } catch {
    // Authentication is best-effort; the agent may already have credentials
    // from env vars or credential files configured on the server side.
  }
}

function toAgentQuery(options: AgentQueryOptions | undefined): Record<string, QueryValue> | undefined {
  if (!options) {
    return undefined;
  }

  return {
    config: options.config,
    no_cache: options.noCache,
  };
}

function normalizeSessionInit(
  value: Omit<NewSessionRequest, "_meta"> | undefined,
  cwdShorthand?: string,
  providerDefaultCwd?: string,
): Omit<NewSessionRequest, "_meta"> {
  if (!value) {
    return {
      cwd: cwdShorthand ?? providerDefaultCwd ?? defaultCwd(),
      mcpServers: [],
    };
  }

  return {
    ...value,
    cwd: value.cwd ?? cwdShorthand ?? providerDefaultCwd ?? defaultCwd(),
    mcpServers: value.mcpServers ?? [],
  };
}

function mapSessionParams(params: Record<string, unknown>, agentSessionId: string): Record<string, unknown> {
  return {
    ...params,
    sessionId: agentSessionId,
  };
}

function injectReplayPrompt(params: Record<string, unknown>, replayText: string): void {
  const prompt = Array.isArray(params.prompt) ? [...params.prompt] : [];
  prompt.unshift({
    type: "text",
    text: replayText,
  });
  params.prompt = prompt;
}

function buildReplayText(events: SessionEvent[], maxChars: number): string | null {
  if (events.length === 0) {
    return null;
  }

  const prefix = "Previous session history is replayed below as JSON-RPC envelopes. Use it as context before responding to the latest user prompt.\n";
  let text = prefix;

  for (const event of events) {
    const line = JSON.stringify({
      createdAt: event.createdAt,
      sender: event.sender,
      payload: event.payload,
    });

    if (text.length + line.length + 1 > maxChars) {
      text += "\n[history truncated]";
      break;
    }

    text += `${line}\n`;
  }

  return text;
}

function envelopeMethod(message: AnyMessage): string | null {
  if (!isRecord(message) || !("method" in message) || typeof message["method"] !== "string") {
    return null;
  }
  return message["method"];
}

function envelopeId(message: AnyMessage): string | null {
  if (!isRecord(message) || !("id" in message) || message["id"] === undefined || message["id"] === null) {
    return null;
  }
  return String(message["id"]);
}

function envelopeSessionIdFromParams(message: AnyMessage): string | null {
  if (!isRecord(message) || !("params" in message) || !isRecord(message["params"])) {
    return null;
  }

  const params = message["params"];
  if (typeof params.sessionId === "string" && params.sessionId.length > 0) {
    return params.sessionId;
  }

  return null;
}

function envelopeSessionIdFromResult(message: AnyMessage): string | null {
  if (!isRecord(message) || !("result" in message) || !isRecord(message["result"])) {
    return null;
  }

  const result = message["result"];
  if (typeof result.sessionId === "string" && result.sessionId.length > 0) {
    return result.sessionId;
  }

  return null;
}

function cloneEnvelope(envelope: AnyMessage): AnyMessage {
  return JSON.parse(JSON.stringify(envelope)) as AnyMessage;
}

function clonePermissionRequest(request: RequestPermissionRequest): RequestPermissionRequest {
  return JSON.parse(JSON.stringify(request)) as RequestPermissionRequest;
}

function clonePermissionResponse(response: RequestPermissionResponse): RequestPermissionResponse {
  return JSON.parse(JSON.stringify(response)) as RequestPermissionResponse;
}

function clonePermissionOption(option: PermissionOption): SessionPermissionRequestOption {
  return {
    optionId: option.optionId,
    name: option.name,
    kind: option.kind,
  };
}

function clonePermissionToolCall(toolCall: RequestPermissionRequest["toolCall"]): RequestPermissionRequest["toolCall"] {
  return JSON.parse(JSON.stringify(toolCall)) as RequestPermissionRequest["toolCall"];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowMs(): number {
  return Date.now();
}

function defaultCwd(): string {
  if (typeof process !== "undefined" && typeof process.cwd === "function") {
    return process.cwd();
  }
  return "/";
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) < 1) {
    return fallback;
  }
  return Math.floor(value as number);
}

function normalizeHealthWaitOptions(
  skipHealthCheck: boolean | undefined,
  waitForHealth: boolean | SandboxAgentHealthWaitOptions | undefined,
  signal: AbortSignal | undefined,
): NormalizedHealthWaitOptions {
  if (skipHealthCheck === true || waitForHealth === false) {
    return { enabled: false };
  }

  if (waitForHealth === true || waitForHealth === undefined) {
    return { enabled: true, signal };
  }

  const timeoutMs =
    typeof waitForHealth.timeoutMs === "number" && Number.isFinite(waitForHealth.timeoutMs) && waitForHealth.timeoutMs > 0
      ? Math.floor(waitForHealth.timeoutMs)
      : undefined;

  return {
    enabled: true,
    signal,
    timeoutMs,
  };
}

function parseSandboxProviderId(sandboxId: string): { provider: string; rawId: string } {
  const slashIndex = sandboxId.indexOf("/");
  if (slashIndex < 1 || slashIndex === sandboxId.length - 1) {
    throw new Error(`Sandbox IDs must be prefixed as "{provider}/{id}". Received '${sandboxId}'.`);
  }

  return {
    provider: sandboxId.slice(0, slashIndex),
    rawId: sandboxId.slice(slashIndex + 1),
  };
}

function requireSandboxBaseUrl(baseUrl: string | undefined, providerName: string): string {
  if (!baseUrl) {
    throw new Error(`Sandbox provider '${providerName}' did not return a base URL.`);
  }
  return baseUrl;
}

async function resolveProviderFetch(provider: SandboxProvider, rawSandboxId: string): Promise<typeof globalThis.fetch | undefined> {
  if (provider.getFetch) {
    return await provider.getFetch(rawSandboxId);
  }

  return undefined;
}

async function resolveProviderToken(provider: SandboxProvider, rawSandboxId: string): Promise<string | undefined> {
  const maybeGetToken = (
    provider as SandboxProvider & {
      getToken?: (sandboxId: string) => string | undefined | Promise<string | undefined>;
    }
  ).getToken;
  if (typeof maybeGetToken !== "function") {
    return undefined;
  }

  const token = await maybeGetToken.call(provider, rawSandboxId);
  return typeof token === "string" && token ? token : undefined;
}

async function readProblem(response: Response): Promise<ProblemDetails | undefined> {
  try {
    const text = await response.clone().text();
    if (!text) {
      return undefined;
    }
    return JSON.parse(text) as ProblemDetails;
  } catch {
    return undefined;
  }
}

function normalizeSessionConfigOptions(value: unknown): SessionConfigOption[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter(isSessionConfigOption) as SessionConfigOption[];
  return cloneConfigOptions(normalized) ?? [];
}

function extractConfigOptionsFromSetResponse(response: unknown): SessionConfigOption[] | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  return normalizeSessionConfigOptions(response.configOptions);
}

function findConfigOptionByCategory(options: SessionConfigOption[], category: string): SessionConfigOption | undefined {
  return options.find((option) => option.category === category);
}

function findConfigOptionById(options: SessionConfigOption[], configId: string): SessionConfigOption | undefined {
  return options.find((option) => option.id === configId);
}

function uniqueCategories(options: SessionConfigOption[]): string[] {
  return [...new Set(options.map((option) => option.category).filter((value): value is string => !!value))].sort();
}

function extractConfigValues(option: SessionConfigOption): string[] {
  if (!isRecord(option) || option.type !== "select" || !Array.isArray(option.options)) {
    return [];
  }

  const values: string[] = [];
  for (const entry of option.options as unknown[]) {
    if (isRecord(entry) && typeof entry.value === "string") {
      values.push(entry.value);
      continue;
    }
    if (isRecord(entry) && Array.isArray(entry.options)) {
      for (const nested of entry.options) {
        if (isRecord(nested) && typeof nested.value === "string") {
          values.push(nested.value);
        }
      }
    }
  }

  return [...new Set(values)];
}

function extractKnownModeIds(modes: SessionModeState | null | undefined): string[] {
  if (!modes || !Array.isArray(modes.availableModes)) {
    return [];
  }
  return modes.availableModes.map((mode) => (typeof mode.id === "string" ? mode.id : null)).filter((value): value is string => !!value);
}

function deriveModesFromConfigOptions(configOptions: SessionConfigOption[] | undefined): SessionModeState | null {
  if (!configOptions || configOptions.length === 0) {
    return null;
  }

  const modeOption = findConfigOptionByCategory(configOptions, "mode");
  if (!modeOption || modeOption.type !== "select" || !Array.isArray(modeOption.options)) {
    return null;
  }

  const availableModes = modeOption.options
    .flatMap((entry: unknown) => flattenConfigOptions(entry))
    .map((entry: { value: string; name: string; description?: string }) => ({
      id: entry.value,
      name: entry.name,
      description: entry.description ?? null,
    }));

  return {
    currentModeId: typeof modeOption.currentValue === "string" && modeOption.currentValue.length > 0 ? modeOption.currentValue : (availableModes[0]?.id ?? ""),
    availableModes,
  };
}

function applyCurrentMode(modes: SessionModeState | null | undefined, currentModeId: string): SessionModeState | null {
  if (modes && Array.isArray(modes.availableModes)) {
    return {
      ...modes,
      currentModeId,
    };
  }
  return {
    currentModeId,
    availableModes: [],
  };
}

function applyConfigOptionValue(configOptions: SessionConfigOption[], configId: string, value: string): SessionConfigOption[] | null {
  const idx = configOptions.findIndex((o) => o.id === configId);
  if (idx === -1) {
    return null;
  }
  const updated = cloneConfigOptions(configOptions) ?? [];
  updated[idx] = { ...updated[idx]!, currentValue: value } as SessionConfigOption;
  return updated;
}

function flattenConfigOptions(entry: unknown): Array<{ value: string; name: string; description?: string }> {
  if (!isRecord(entry)) {
    return [];
  }
  if (typeof entry.value === "string" && typeof entry.name === "string") {
    return [
      {
        value: entry.value,
        name: entry.name,
        description: typeof entry.description === "string" ? entry.description : undefined,
      },
    ];
  }
  if (!Array.isArray(entry.options)) {
    return [];
  }
  return entry.options.flatMap((nested) => flattenConfigOptions(nested));
}

function envelopeSessionUpdate(message: AnyMessage): Record<string, unknown> | null {
  if (!isRecord(message) || !("params" in message) || !isRecord(message.params)) {
    return null;
  }
  if (!("update" in message.params) || !isRecord(message.params.update)) {
    return null;
  }
  return message.params.update;
}

function cloneConfigOptions(value: SessionConfigOption[] | null | undefined): SessionConfigOption[] | undefined {
  if (!value) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as SessionConfigOption[];
}

function cloneModes(value: SessionModeState | null | undefined): SessionModeState | null {
  if (!value) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as SessionModeState;
}

function availablePermissionReplies(options: PermissionOption[]): PermissionReply[] {
  const replies = new Set<PermissionReply>();
  for (const option of options) {
    if (option.kind === "allow_once") {
      replies.add("once");
    } else if (option.kind === "allow_always") {
      replies.add("always");
    } else if (option.kind === "reject_once" || option.kind === "reject_always") {
      replies.add("reject");
    }
  }
  return [...replies];
}

function permissionReplyToResponse(permissionId: string, request: RequestPermissionRequest, reply: PermissionReply): RequestPermissionResponse {
  const preferredKinds: PermissionOptionKind[] =
    reply === "once" ? ["allow_once"] : reply === "always" ? ["allow_always", "allow_once"] : ["reject_once", "reject_always"];

  const selected = preferredKinds
    .map((kind) => request.options.find((option) => option.kind === kind))
    .find((option): option is PermissionOption => Boolean(option));

  if (!selected) {
    throw new UnsupportedPermissionReplyError(permissionId, reply, availablePermissionReplies(request.options));
  }

  return {
    outcome: {
      outcome: "selected",
      optionId: selected.optionId,
    },
  };
}

function cancelledPermissionResponse(): RequestPermissionResponse {
  return {
    outcome: {
      outcome: "cancelled",
    },
  };
}

function isSessionConfigOption(value: unknown): value is SessionConfigOption {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.type === "string";
}

function toTitleCase(input: string): string {
  if (!input) {
    return "";
  }
  return input
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function formatHealthWaitError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (error === undefined || error === null) {
    return "unknown error";
  }

  return String(error);
}

function anyAbortSignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) {
    return undefined;
  }

  if (active.length === 1) {
    return active[0];
  }

  const controller = new AbortController();
  const onAbort = (event: Event) => {
    cleanup();
    const signal = event.target as AbortSignal;
    controller.abort(signal.reason ?? createAbortError());
  };
  const cleanup = () => {
    for (const signal of active) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason ?? createAbortError());
      return controller.signal;
    }
  }

  for (const signal of active) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return controller.signal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  throw signal.reason instanceof Error ? signal.reason : createAbortError(signal.reason);
}

async function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }

  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : createAbortError(signal.reason));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function consumeProcessLogSse(body: ReadableStream<Uint8Array>, listener: ProcessLogListener, signal: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const chunk = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const entry = parseProcessLogSseChunk(chunk);
        if (entry) {
          listener(entry);
        }

        separatorIndex = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      return;
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function parseProcessLogSseChunk(chunk: string): ProcessLogEntry | null {
  if (!chunk.trim()) {
    return null;
  }

  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of chunk.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (eventName !== "log") {
    return null;
  }

  const data = dataLines.join("\n");
  if (!data.trim()) {
    return null;
  }

  return JSON.parse(data) as ProcessLogEntry;
}

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  }
  return parsed.toString();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  const message = typeof reason === "string" ? reason : "This operation was aborted.";
  if (typeof DOMException !== "undefined") {
    return new DOMException(message, "AbortError");
  }

  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : createAbortError(signal.reason));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
