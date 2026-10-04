import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type Client,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type Stream,
} from "@agentclientprotocol/sdk";

const DEFAULT_ACP_PATH = "/v1/rpc";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}

export type AcpEnvelopeDirection = "inbound" | "outbound";

export type AcpEnvelopeObserver = (envelope: AnyMessage, direction: AcpEnvelopeDirection) => void;

export type QueryValue = string | number | boolean | null | undefined;

export interface AcpHttpTransportOptions {
  path?: string;
  bootstrapQuery?: Record<string, QueryValue>;
}

export interface AcpHttpClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  client?: Partial<Client>;
  onEnvelope?: AcpEnvelopeObserver;
  transport?: AcpHttpTransportOptions;
}

export class AcpHttpError extends Error {
  readonly status: number;
  readonly problem?: ProblemDetails;
  readonly response: Response;

  constructor(status: number, problem: ProblemDetails | undefined, response: Response) {
    super(problem?.title ?? `Request failed with status ${status}`);
    this.name = "AcpHttpError";
    this.status = status;
    this.problem = problem;
    this.response = response;
  }
}

export interface RpcErrorResponse {
  code: number;
  message: string;
  data?: unknown;
}

const RPC_CODE_LABELS: Record<number, string> = {
  [-32700]: "Parse error",
  [-32600]: "Invalid request",
  [-32601]: "Method not supported by agent",
  [-32602]: "Invalid parameters",
  [-32603]: "Internal agent error",
  [-32000]: "Authentication required",
  [-32002]: "Resource not found",
};

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    const label = RPC_CODE_LABELS[code];
    const display = label ? `${label}: ${message}` : message;
    super(display);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }
}

function isRpcErrorResponse(value: unknown): value is RpcErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof (value as RpcErrorResponse).code === "number" &&
    "message" in value &&
    typeof (value as RpcErrorResponse).message === "string"
  );
}

async function wrapRpc<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (isRpcErrorResponse(error)) {
      throw new AcpRpcError(error.code, error.message, error.data);
    }
    throw error;
  }
}

export class AcpHttpClient {
  private readonly transport: StreamableHttpAcpTransport;
  private readonly connection: ClientSideConnection;

  constructor(options: AcpHttpClientOptions) {
    const fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetcher) {
      throw new Error("Fetch API is not available; provide a fetch implementation.");
    }

    this.transport = new StreamableHttpAcpTransport({
      baseUrl: options.baseUrl,
      fetcher,
      token: options.token,
      defaultHeaders: options.headers,
      onEnvelope: options.onEnvelope,
      transport: options.transport,
    });

    const clientHandlers = buildClientHandlers(options.client);
    this.connection = new ClientSideConnection(() => clientHandlers, this.transport.stream);
  }

  async initialize(request: Partial<InitializeRequest> = {}): Promise<InitializeResponse> {
    const params: InitializeRequest = {
      protocolVersion: request.protocolVersion ?? PROTOCOL_VERSION,
      clientCapabilities: request.clientCapabilities,
      clientInfo: request.clientInfo ?? {
        name: "acp-http-client",
        version: "v1",
      },
    };

    if (request._meta !== undefined) {
      params._meta = request._meta;
    }

    return wrapRpc(this.connection.initialize(params));
  }

  async authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse> {
    return wrapRpc(this.connection.authenticate(request));
  }

  async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    return wrapRpc(this.connection.newSession(request));
  }

  async loadSession(request: LoadSessionRequest): Promise<LoadSessionResponse> {
    return wrapRpc(this.connection.loadSession(request));
  }

  async prompt(request: PromptRequest): Promise<PromptResponse> {
    return wrapRpc(this.connection.prompt(request));
  }

  async cancel(notification: CancelNotification): Promise<void> {
    return this.connection.cancel(notification);
  }

  async setSessionMode(request: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
    return wrapRpc(this.connection.setSessionMode(request));
  }

  async setSessionConfigOption(request: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    return wrapRpc(this.connection.setSessionConfigOption(request));
  }

  async listSessions(request: ListSessionsRequest): Promise<ListSessionsResponse> {
    return wrapRpc(this.connection.listSessions(request));
  }

  async unstableForkSession(request: ForkSessionRequest): Promise<ForkSessionResponse> {
    return wrapRpc(this.connection.unstable_forkSession(request));
  }

  async unstableResumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return wrapRpc(this.connection.unstable_resumeSession(request));
  }

  async unstableSetSessionModel(request: SetSessionModelRequest): Promise<SetSessionModelResponse | void> {
    return wrapRpc(this.connection.unstable_setSessionModel(request));
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return wrapRpc(this.connection.extMethod(method, params));
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    return this.connection.extNotification(method, params);
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
  }

  get closed(): Promise<void> {
    return this.connection.closed;
  }

  get signal(): AbortSignal {
    return this.connection.signal;
  }

  get clientSideConnection(): ClientSideConnection {
    return this.connection;
  }
}

type StreamableHttpAcpTransportOptions = {
  baseUrl: string;
  fetcher: typeof fetch;
  token?: string;
  defaultHeaders?: HeadersInit;
  onEnvelope?: AcpEnvelopeObserver;
  transport?: AcpHttpTransportOptions;
};

class StreamableHttpAcpTransport {
  readonly stream: Stream;

  private readonly baseUrl: string;
  private readonly path: string;
  private readonly fetcher: typeof fetch;
  private readonly token?: string;
  private readonly defaultHeaders?: HeadersInit;
  private readonly onEnvelope?: AcpEnvelopeObserver;
  private readonly bootstrapQuery: URLSearchParams | null;

  private readableController: ReadableStreamDefaultController<AnyMessage> | null = null;
  private sseAbortController: AbortController | null = null;
  private sseLoop: Promise<void> | null = null;
  private lastEventId: string | null = null;
  private closed = false;
  private closingPromise: Promise<void> | null = null;
  private postedOnce = false;
  private readonly seenResponseIds = new Set<string>();
  private readonly seenResponseIdOrder: string[] = [];

  constructor(options: StreamableHttpAcpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.path = normalizePath(options.transport?.path ?? DEFAULT_ACP_PATH);
    this.fetcher = options.fetcher;
    this.token = options.token;
    this.defaultHeaders = options.defaultHeaders;
    this.onEnvelope = options.onEnvelope;
    this.bootstrapQuery = options.transport?.bootstrapQuery ? buildQueryParams(options.transport.bootstrapQuery) : null;

    this.stream = {
      readable: new ReadableStream<AnyMessage>({
        start: (controller) => {
          this.readableController = controller;
        },
        cancel: async () => {
          await this.close();
        },
      }),
      writable: new WritableStream<AnyMessage>({
        write: async (message) => {
          await this.writeMessage(message);
        },
        close: async () => {
          await this.close();
        },
        abort: async () => {
          await this.close();
        },
      }),
    };
  }

  async close(): Promise<void> {
    if (this.closingPromise) {
      return this.closingPromise;
    }

    this.closingPromise = this.closeImpl();
    return this.closingPromise;
  }

  private async closeImpl(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.sseAbortController) {
      this.sseAbortController.abort();
    }

    if (!this.postedOnce) {
      try {
        this.readableController?.close();
      } catch {
        // no-op
      }
      this.readableController = null;
      return;
    }

    const deleteHeaders = this.buildHeaders({
      Accept: "application/json",
    });

    try {
      const response = await this.fetcher(this.buildUrl(), {
        method: "DELETE",
        headers: deleteHeaders,
        signal: timeoutSignal(2_000),
      });

      if (!response.ok && response.status !== 404) {
        throw new AcpHttpError(response.status, await readProblem(response), response);
      }
    } catch {
      // Ignore close errors; close must be best effort.
    }

    try {
      this.readableController?.close();
    } catch {
      // no-op
    }

    this.readableController = null;
  }

  private async writeMessage(message: AnyMessage): Promise<void> {
    if (this.closed) {
      throw new Error("ACP client is closed");
    }

    this.observeEnvelope(message, "outbound");

    const headers = this.buildHeaders({
      "Content-Type": "application/json",
      Accept: "application/json",
    });

    const url = this.buildUrl(this.bootstrapQueryIfNeeded());
    this.postedOnce = true;
    this.ensureSseLoop();
    void this.postMessage(url, headers, message);
  }

  private async postMessage(url: string, headers: Headers, message: AnyMessage): Promise<void> {
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        throw new AcpHttpError(response.status, await readProblem(response), response);
      }

      if (response.status === 200) {
        const text = await response.text();
        if (text.trim()) {
          const envelope = JSON.parse(text) as AnyMessage;
          this.pushInbound(envelope);
        }
        return;
      }

      // Drain response body so the underlying connection is released back to
      // the pool. Without this, Node.js undici keeps the socket occupied and
      // may stall subsequent requests to the same origin.
      await response.text().catch(() => {});
    } catch (error) {
      console.error("ACP write error:", error);
      this.failReadable(error);
    }
  }

  private ensureSseLoop(): void {
    if (this.sseLoop || this.closed || !this.postedOnce) {
      return;
    }

    this.sseLoop = this.runSseLoop().finally(() => {
      this.sseLoop = null;
    });
  }

  private async runSseLoop(): Promise<void> {
    while (!this.closed) {
      this.sseAbortController = new AbortController();

      const headers = this.buildHeaders({
        Accept: "text/event-stream",
      });

      if (this.lastEventId) {
        headers.set("Last-Event-ID", this.lastEventId);
      }

      try {
        const response = await this.fetcher(this.buildUrl(), {
          method: "GET",
          headers,
          signal: this.sseAbortController.signal,
        });
        if (!response.ok) {
          throw new AcpHttpError(response.status, await readProblem(response), response);
        }

        if (!response.body) {
          throw new Error("SSE stream is not readable in this environment.");
        }

        await this.consumeSse(response.body);

        if (!this.closed) {
          await delay(150);
        }
      } catch (error) {
        if (this.closed || isAbortError(error)) {
          return;
        }

        // SSE failure is non-fatal: the POST request/response flow still works.
        // Exiting the loop allows ensureSseLoop() to restart it on the next POST.
        return;
      }
    }
  }

  private async consumeSse(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex !== -1) {
          const eventChunk = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          this.processSseEvent(eventChunk);
          separatorIndex = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private processSseEvent(chunk: string): void {
    if (!chunk.trim()) {
      return;
    }

    let eventName = "message";
    let eventId: string | null = null;
    const dataLines: string[] = [];

    for (const line of chunk.split("\n")) {
      if (!line || line.startsWith(":")) {
        continue;
      }

      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }

      if (line.startsWith("id:")) {
        eventId = line.slice(3).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (eventId) {
      this.lastEventId = eventId;
    }

    if (eventName !== "message" || dataLines.length === 0) {
      return;
    }

    const payloadText = dataLines.join("\n");
    if (!payloadText.trim()) {
      return;
    }

    const envelope = JSON.parse(payloadText) as AnyMessage;
    this.pushInbound(envelope);
  }

  private pushInbound(envelope: AnyMessage): void {
    if (this.closed) {
      return;
    }

    const responseId = responseEnvelopeId(envelope);
    if (responseId) {
      if (this.seenResponseIds.has(responseId)) {
        return;
      }
      this.seenResponseIds.add(responseId);
      this.seenResponseIdOrder.push(responseId);
      if (this.seenResponseIdOrder.length > 2048) {
        const oldest = this.seenResponseIdOrder.shift();
        if (oldest) {
          this.seenResponseIds.delete(oldest);
        }
      }
    }

    this.observeEnvelope(envelope, "inbound");

    try {
      this.readableController?.enqueue(envelope);
    } catch (error) {
      this.failReadable(error);
    }
  }

  private failReadable(error: unknown): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    try {
      this.readableController?.error(error);
    } catch {
      // no-op
    }

    this.readableController = null;

    if (this.sseAbortController) {
      this.sseAbortController.abort();
    }
  }

  private observeEnvelope(message: AnyMessage, direction: AcpEnvelopeDirection): void {
    if (!this.onEnvelope) {
      return;
    }

    this.onEnvelope(message, direction);
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

  private buildUrl(query?: URLSearchParams | null): string {
    const url = new URL(`${this.baseUrl}${this.path}`);
    if (query) {
      for (const [key, value] of query.entries()) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private bootstrapQueryIfNeeded(): URLSearchParams | null {
    if (this.postedOnce || !this.bootstrapQuery || this.bootstrapQuery.size === 0) {
      return null;
    }
    return this.bootstrapQuery;
  }
}

function buildClientHandlers(client?: Partial<Client>): Client {
  const fallbackPermission: RequestPermissionResponse = {
    outcome: {
      outcome: "cancelled",
    } as RequestPermissionOutcome,
  };

  return {
    requestPermission: async (request: RequestPermissionRequest) => {
      if (client?.requestPermission) {
        return client.requestPermission(request);
      }
      return fallbackPermission;
    },
    sessionUpdate: async (notification: SessionNotification) => {
      if (client?.sessionUpdate) {
        await client.sessionUpdate(notification);
      }
    },
    readTextFile: client?.readTextFile,
    writeTextFile: client?.writeTextFile,
    createTerminal: client?.createTerminal,
    terminalOutput: client?.terminalOutput,
    releaseTerminal: client?.releaseTerminal,
    waitForTerminalExit: client?.waitForTerminalExit,
    killTerminal: client?.killTerminal,
    extMethod: client?.extMethod,
    extNotification: async (method: string, params: Record<string, unknown>) => {
      if (client?.extNotification) {
        await client.extNotification(method, params);
      }
    },
  };
}

function responseEnvelopeId(message: AnyMessage): string | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const record = message as Record<string, unknown>;
  if ("method" in record) {
    return null;
  }
  if (!("result" in record) && !("error" in record)) {
    return null;
  }
  const id = record.id;
  if (id === null || id === undefined) {
    return null;
  }
  return String(id);
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) {
    return `/${path}`;
  }
  return path;
}

function buildQueryParams(source: Record<string, QueryValue>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) {
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}

export type * from "@agentclientprotocol/sdk";
export { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
