import type { AnyMessage, NewSessionRequest, SessionConfigOption, SessionModeState } from "acp-http-client";
import type { components, operations } from "./generated/openapi.ts";

export type ProblemDetails = components["schemas"]["ProblemDetails"];

export type HealthResponse = JsonResponse<operations["get_v1_health"], 200>;
export type DesktopState = components["schemas"]["DesktopState"];
export type DesktopResolution = components["schemas"]["DesktopResolution"];
export type DesktopErrorInfo = components["schemas"]["DesktopErrorInfo"];
export type DesktopProcessInfo = components["schemas"]["DesktopProcessInfo"];
export type DesktopStatusResponse = JsonResponse<operations["get_v1_desktop_status"], 200>;
export type DesktopStartRequest = JsonRequestBody<operations["post_v1_desktop_start"]>;
export type DesktopScreenshotFormat = components["schemas"]["DesktopScreenshotFormat"];
export type DesktopScreenshotQuery =
  QueryParams<operations["get_v1_desktop_screenshot"]> extends never ? Record<string, never> : QueryParams<operations["get_v1_desktop_screenshot"]>;
export type DesktopRegionScreenshotQuery = QueryParams<operations["get_v1_desktop_screenshot_region"]>;
export type DesktopMousePositionResponse = JsonResponse<operations["get_v1_desktop_mouse_position"], 200>;
export type DesktopMouseButton = components["schemas"]["DesktopMouseButton"];
export type DesktopMouseMoveRequest = JsonRequestBody<operations["post_v1_desktop_mouse_move"]>;
export type DesktopMouseClickRequest = JsonRequestBody<operations["post_v1_desktop_mouse_click"]>;
export type DesktopMouseDownRequest = JsonRequestBody<operations["post_v1_desktop_mouse_down"]>;
export type DesktopMouseUpRequest = JsonRequestBody<operations["post_v1_desktop_mouse_up"]>;
export type DesktopMouseDragRequest = JsonRequestBody<operations["post_v1_desktop_mouse_drag"]>;
export type DesktopMouseScrollRequest = JsonRequestBody<operations["post_v1_desktop_mouse_scroll"]>;
export type DesktopKeyboardTypeRequest = JsonRequestBody<operations["post_v1_desktop_keyboard_type"]>;
export type DesktopKeyModifiers = components["schemas"]["DesktopKeyModifiers"];
export type DesktopKeyboardPressRequest = JsonRequestBody<operations["post_v1_desktop_keyboard_press"]>;
export type DesktopKeyboardDownRequest = JsonRequestBody<operations["post_v1_desktop_keyboard_down"]>;
export type DesktopKeyboardUpRequest = JsonRequestBody<operations["post_v1_desktop_keyboard_up"]>;
export type DesktopActionResponse = JsonResponse<operations["post_v1_desktop_keyboard_type"], 200>;
export type DesktopDisplayInfoResponse = JsonResponse<operations["get_v1_desktop_display_info"], 200>;
export type DesktopWindowInfo = components["schemas"]["DesktopWindowInfo"];
export type DesktopWindowListResponse = JsonResponse<operations["get_v1_desktop_windows"], 200>;
export type DesktopRecordingStartRequest = JsonRequestBody<operations["post_v1_desktop_recording_start"]>;
export type DesktopRecordingStatus = components["schemas"]["DesktopRecordingStatus"];
export type DesktopRecordingInfo = JsonResponse<operations["post_v1_desktop_recording_start"], 200>;
export type DesktopRecordingListResponse = JsonResponse<operations["get_v1_desktop_recordings"], 200>;
export type DesktopStreamStatusResponse = JsonResponse<operations["post_v1_desktop_stream_start"], 200>;
export type DesktopClipboardResponse = JsonResponse<operations["get_v1_desktop_clipboard"], 200>;
export type DesktopClipboardQuery =
  QueryParams<operations["get_v1_desktop_clipboard"]> extends never ? Record<string, never> : QueryParams<operations["get_v1_desktop_clipboard"]>;
export type DesktopClipboardWriteRequest = JsonRequestBody<operations["post_v1_desktop_clipboard"]>;
export type DesktopLaunchRequest = JsonRequestBody<operations["post_v1_desktop_launch"]>;
export type DesktopLaunchResponse = JsonResponse<operations["post_v1_desktop_launch"], 200>;
export type DesktopOpenRequest = JsonRequestBody<operations["post_v1_desktop_open"]>;
export type DesktopOpenResponse = JsonResponse<operations["post_v1_desktop_open"], 200>;
export type DesktopWindowMoveRequest = JsonRequestBody<operations["post_v1_desktop_window_move"]>;
export type DesktopWindowResizeRequest = JsonRequestBody<operations["post_v1_desktop_window_resize"]>;
export type AgentListResponse = JsonResponse<operations["get_v1_agents"], 200>;
export type AgentInfo = components["schemas"]["AgentInfo"];
export type AgentQuery = QueryParams<operations["get_v1_agents"]>;
export type AgentInstallRequest = JsonRequestBody<operations["post_v1_agent_install"]>;
export type AgentInstallResponse = JsonResponse<operations["post_v1_agent_install"], 200>;

export type AcpEnvelope = components["schemas"]["AcpEnvelope"];
export type AcpServerInfo = components["schemas"]["AcpServerInfo"];
export type AcpServerListResponse = JsonResponse<operations["get_v1_acp_servers"], 200>;

export type FsEntriesQuery = QueryParams<operations["get_v1_fs_entries"]>;
export type FsEntry = components["schemas"]["FsEntry"];
export type FsPathQuery = QueryParams<operations["get_v1_fs_file"]>;
export type FsDeleteQuery = QueryParams<operations["delete_v1_fs_entry"]>;
export type FsUploadBatchQuery = QueryParams<operations["post_v1_fs_upload_batch"]>;
export type FsWriteResponse = JsonResponse<operations["put_v1_fs_file"], 200>;
export type FsActionResponse = JsonResponse<operations["delete_v1_fs_entry"], 200>;
export type FsMoveRequest = JsonRequestBody<operations["post_v1_fs_move"]>;
export type FsMoveResponse = JsonResponse<operations["post_v1_fs_move"], 200>;
export type FsStat = JsonResponse<operations["get_v1_fs_stat"], 200>;
export type FsUploadBatchResponse = JsonResponse<operations["post_v1_fs_upload_batch"], 200>;

export type McpConfigQuery = QueryParams<operations["get_v1_config_mcp"]>;
export type McpServerConfig = components["schemas"]["McpServerConfig"];

export type SkillsConfigQuery = QueryParams<operations["get_v1_config_skills"]>;
export type SkillsConfig = components["schemas"]["SkillsConfig"];

export type ProcessConfig = JsonResponse<operations["get_v1_processes_config"], 200>;
export type ProcessCreateRequest = JsonRequestBody<operations["post_v1_processes"]>;
export type ProcessInfo = components["schemas"]["ProcessInfo"];
export type ProcessInputRequest = JsonRequestBody<operations["post_v1_process_input"]>;
export type ProcessInputResponse = JsonResponse<operations["post_v1_process_input"], 200>;
export type ProcessListQuery = QueryParams<operations["get_v1_processes"]>;
export type ProcessListResponse = JsonResponse<operations["get_v1_processes"], 200>;
export type ProcessLogEntry = components["schemas"]["ProcessLogEntry"];
export type ProcessLogsQuery = QueryParams<operations["get_v1_process_logs"]>;
export type ProcessLogsResponse = JsonResponse<operations["get_v1_process_logs"], 200>;
export type ProcessLogsStream = components["schemas"]["ProcessLogsStream"];
export type ProcessOwner = components["schemas"]["ProcessOwner"];
export type ProcessRunRequest = JsonRequestBody<operations["post_v1_processes_run"]>;
export type ProcessRunResponse = JsonResponse<operations["post_v1_processes_run"], 200>;
export type ProcessSignalQuery = QueryParams<operations["post_v1_process_stop"]>;
export type ProcessState = components["schemas"]["ProcessState"];
export type ProcessTerminalResizeRequest = JsonRequestBody<operations["post_v1_process_terminal_resize"]>;
export type ProcessTerminalResizeResponse = JsonResponse<operations["post_v1_process_terminal_resize"], 200>;

export type ProcessTerminalClientFrame =
  | {
      type: "input";
      data: string;
      encoding?: string;
    }
  | {
      type: "resize";
      cols: number;
      rows: number;
    }
  | {
      type: "close";
    };

export interface ProcessTerminalReadyFrame {
  type: "ready";
  processId: string;
}

export interface ProcessTerminalExitFrame {
  type: "exit";
  exitCode?: number | null;
}

export interface ProcessTerminalErrorFrame {
  type: "error";
  message: string;
}

export type ProcessTerminalServerFrame = ProcessTerminalReadyFrame | ProcessTerminalExitFrame | ProcessTerminalErrorFrame;

export type TerminalReadyStatus = ProcessTerminalReadyFrame;
export type TerminalExitStatus = ProcessTerminalExitFrame;
export type TerminalErrorStatus = ProcessTerminalErrorFrame;
export type TerminalStatusMessage = ProcessTerminalServerFrame;

export interface TerminalResizePayload {
  cols: number;
  rows: number;
}

export interface SessionRecord {
  id: string;
  agent: string;
  agentSessionId: string;
  lastConnectionId: string;
  createdAt: number;
  destroyedAt?: number;
  sandboxId?: string;
  sessionInit?: Omit<NewSessionRequest, "_meta">;
  configOptions?: SessionConfigOption[];
  modes?: SessionModeState | null;
}

export type SessionEventSender = "client" | "agent";

export interface SessionEvent {
  // Stable unique event id. For ordering, sort by (sessionId, eventIndex).
  id: string;
  eventIndex: number;
  sessionId: string;
  createdAt: number;
  connectionId: string;
  sender: SessionEventSender;
  payload: AnyMessage;
}

export interface ListPageRequest {
  cursor?: string;
  limit?: number;
}

export interface ListPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface ListEventsRequest extends ListPageRequest {
  sessionId: string;
}

export interface SessionPersistDriver {
  getSession(id: string): Promise<SessionRecord | undefined>;
  listSessions(request?: ListPageRequest): Promise<ListPage<SessionRecord>>;
  updateSession(session: SessionRecord): Promise<void>;
  listEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>>;
  insertEvent(sessionId: string, event: SessionEvent): Promise<void>;
}

export interface InMemorySessionPersistDriverOptions {
  maxSessions?: number;
  maxEventsPerSession?: number;
}

const DEFAULT_MAX_SESSIONS = 1024;
const DEFAULT_MAX_EVENTS_PER_SESSION = 500;
const DEFAULT_LIST_LIMIT = 100;

export class InMemorySessionPersistDriver implements SessionPersistDriver {
  private readonly maxSessions: number;
  private readonly maxEventsPerSession: number;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly eventsBySession = new Map<string, SessionEvent[]>();

  constructor(options: InMemorySessionPersistDriverOptions = {}) {
    this.maxSessions = normalizeCap(options.maxSessions, DEFAULT_MAX_SESSIONS);
    this.maxEventsPerSession = normalizeCap(options.maxEventsPerSession, DEFAULT_MAX_EVENTS_PER_SESSION);
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(id);
    return session ? cloneSessionRecord(session) : undefined;
  }

  async listSessions(request: ListPageRequest = {}): Promise<ListPage<SessionRecord>> {
    const sorted = [...this.sessions.values()].sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt;
      }
      return a.id.localeCompare(b.id);
    });
    const page = paginate(sorted, request);
    return {
      items: page.items.map(cloneSessionRecord),
      nextCursor: page.nextCursor,
    };
  }

  async updateSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, { ...session });

    if (!this.eventsBySession.has(session.id)) {
      this.eventsBySession.set(session.id, []);
    }

    if (this.sessions.size <= this.maxSessions) {
      return;
    }

    const overflow = this.sessions.size - this.maxSessions;
    const removable = [...this.sessions.values()]
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) {
          return a.createdAt - b.createdAt;
        }
        return a.id.localeCompare(b.id);
      })
      .slice(0, overflow)
      .map((sessionToRemove) => sessionToRemove.id);

    for (const sessionId of removable) {
      this.sessions.delete(sessionId);
      this.eventsBySession.delete(sessionId);
    }
  }

  async listEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>> {
    const all = [...(this.eventsBySession.get(request.sessionId) ?? [])].sort((a, b) => {
      if (a.eventIndex !== b.eventIndex) {
        return a.eventIndex - b.eventIndex;
      }
      return a.id.localeCompare(b.id);
    });
    const page = paginate(all, request);
    return {
      items: page.items.map(cloneSessionEvent),
      nextCursor: page.nextCursor,
    };
  }

  async insertEvent(sessionId: string, event: SessionEvent): Promise<void> {
    const events = this.eventsBySession.get(sessionId) ?? [];
    events.push(cloneSessionEvent(event));

    if (events.length > this.maxEventsPerSession) {
      events.splice(0, events.length - this.maxEventsPerSession);
    }

    this.eventsBySession.set(sessionId, events);
  }
}

function cloneSessionRecord(session: SessionRecord): SessionRecord {
  return {
    ...session,
    sessionInit: session.sessionInit ? (JSON.parse(JSON.stringify(session.sessionInit)) as SessionRecord["sessionInit"]) : undefined,
    configOptions: session.configOptions ? (JSON.parse(JSON.stringify(session.configOptions)) as SessionRecord["configOptions"]) : undefined,
    modes: session.modes ? (JSON.parse(JSON.stringify(session.modes)) as SessionRecord["modes"]) : session.modes,
  };
}

function cloneSessionEvent(event: SessionEvent): SessionEvent {
  return {
    ...event,
    payload: JSON.parse(JSON.stringify(event.payload)) as AnyMessage,
  };
}

type ResponsesOf<T> = T extends { responses: infer R } ? R : never;
type JsonResponse<T, StatusCode extends keyof ResponsesOf<T>> = ResponsesOf<T>[StatusCode] extends {
  content: { "application/json": infer B };
}
  ? B
  : never;

type JsonRequestBody<T> = T extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;

type QueryParams<T> = T extends { parameters: { query: infer Q } } ? Q : T extends { parameters: { query?: infer Q } } ? Q : never;

function normalizeCap(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) < 1) {
    return fallback;
  }
  return Math.floor(value as number);
}

function paginate<T>(items: T[], request: ListPageRequest): ListPage<T> {
  const offset = parseCursor(request.cursor);
  const limit = normalizeCap(request.limit, DEFAULT_LIST_LIMIT);
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  return {
    items: slice,
    nextCursor: nextOffset < items.length ? String(nextOffset) : undefined,
  };
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}
