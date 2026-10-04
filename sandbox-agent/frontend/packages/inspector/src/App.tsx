import type { TranscriptEntry } from "@sandbox-agent/react";
import { BookOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SandboxAgent,
  SandboxAgentError,
  type AgentInfo,
  type SessionEvent,
  type Session,
  type SessionPermissionRequest,
  type PermissionReply,
  InMemorySessionPersistDriver,
  type SessionPersistDriver,
} from "sandbox-agent";

type ConfigSelectOption = { value: string; name: string; description?: string };
type ConfigOption = {
  id: string;
  name: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: ConfigSelectOption[] | Array<{ group: string; name: string; options: ConfigSelectOption[] }>;
};
type AgentModeInfo = { id: string; name: string; description: string };
type AgentModelInfo = { id: string; name?: string };
import { IndexedDbSessionPersistDriver } from "./persist-indexeddb";
import ChatPanel from "./components/chat/ChatPanel";
import ConnectScreen from "./components/ConnectScreen";
import DebugPanel, { type DebugTab } from "./components/debug/DebugPanel";
import SessionSidebar from "./components/SessionSidebar";
import type { RequestLog } from "./types/requestLog";
import { buildCurl } from "./utils/http";

const flattenSelectOptions = (options: ConfigSelectOption[] | Array<{ group: string; name: string; options: ConfigSelectOption[] }>): ConfigSelectOption[] => {
  if (options.length === 0) return [];
  if ("value" in options[0]) return options as ConfigSelectOption[];
  return (options as Array<{ options: ConfigSelectOption[] }>).flatMap((g) => g.options);
};

const logoUrl = `${import.meta.env.BASE_URL}logos/sandboxagent.svg`;
const defaultAgents = ["claude", "codex", "opencode", "amp", "pi", "cursor"];

type ErrorToast = {
  id: number;
  message: string;
};

type SessionListItem = {
  sessionId: string;
  agent: string;
  ended: boolean;
  archived: boolean;
};

const ERROR_TOAST_MS = 6000;
const MAX_ERROR_TOASTS = 3;
const CREATE_SESSION_SLOW_WARNING_MS = 90_000;
const HTTP_ERROR_EVENT = "inspector-http-error";
const ARCHIVED_SESSIONS_KEY = "sandbox-agent-inspector-archived-sessions";
const SESSION_MODELS_KEY = "sandbox-agent-inspector-session-models";

const DEFAULT_ENDPOINT = "http://localhost:2468";

const getCurrentOriginEndpoint = () => {
  if (typeof window === "undefined") {
    return null;
  }
  return window.location.origin;
};

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof SandboxAgentError) {
    return error.problem?.detail ?? error.problem?.title ?? error.message;
  }
  if (error instanceof Error) {
    // ACP RequestError may carry a data object with a hint or details field.
    const data = (error as { data?: Record<string, unknown> }).data;
    if (data && typeof data === "object") {
      const hint = typeof data.hint === "string" ? data.hint : null;
      const details = typeof data.details === "string" ? data.details : null;
      if (hint) return hint;
      if (details) return details;
    }
    return error.message;
  }
  return fallback;
};

const getHttpErrorMessage = (status: number, statusText: string, responseBody: string) => {
  const base = statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
  const body = responseBody.trim();
  if (!body) {
    return base;
  }
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const detail = (parsed as { detail?: unknown }).detail;
      if (typeof detail === "string" && detail.trim()) {
        return detail;
      }
      const title = (parsed as { title?: unknown }).title;
      if (typeof title === "string" && title.trim()) {
        return title;
      }
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }
  } catch {
    // Ignore parse failures and fall through to body text.
  }
  const clippedBody = body.length > 240 ? `${body.slice(0, 240)}...` : body;
  return `${base}: ${clippedBody}`;
};

const shouldIgnoreGlobalError = (value: unknown): boolean => {
  const name = value instanceof Error ? value.name : "";
  const message = (() => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.message;
    if (value && typeof value === "object" && "message" in value && typeof (value as { message?: unknown }).message === "string") {
      return (value as { message: string }).message;
    }
    return "";
  })().toLowerCase();

  if (name === "AbortError") return true;
  if (!message) return false;

  return (
    message.includes("aborterror") ||
    message.includes("the operation was aborted") ||
    message.includes("signal is aborted") ||
    message.includes("acp client is closed") ||
    (message.includes("method not found") && message.includes("unstable/set_session_model")) ||
    message.includes("resizeobserver loop limit exceeded") ||
    message.includes("resizeobserver loop completed with undelivered notifications")
  );
};

const getSessionIdFromPath = (): string => {
  const basePath = import.meta.env.BASE_URL;
  const path = window.location.pathname;
  const relative = path.startsWith(basePath) ? path.slice(basePath.length) : path;
  const match = relative.match(/^sessions\/(.+)/);
  return match ? match[1] : "";
};

const getArchivedSessionIds = (): Set<string> => {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const raw = window.localStorage.getItem(ARCHIVED_SESSIONS_KEY);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0));
  } catch {
    return new Set<string>();
  }
};

const archiveSessionId = (id: string): void => {
  if (typeof window === "undefined" || !id) return;
  const archived = getArchivedSessionIds();
  archived.add(id);
  window.localStorage.setItem(ARCHIVED_SESSIONS_KEY, JSON.stringify([...archived]));
};

const unarchiveSessionId = (id: string): void => {
  if (typeof window === "undefined" || !id) return;
  const archived = getArchivedSessionIds();
  if (!archived.delete(id)) return;
  window.localStorage.setItem(ARCHIVED_SESSIONS_KEY, JSON.stringify([...archived]));
};

const getPersistedSessionModels = (): Record<string, string> => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SESSION_MODELS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].length > 0),
    );
  } catch {
    return {};
  }
};

const updateSessionPath = (id: string) => {
  const basePath = import.meta.env.BASE_URL;
  const params = window.location.search;
  const newPath = id ? `${basePath}sessions/${id}${params}` : `${basePath}${params}`;
  if (window.location.pathname + window.location.search !== newPath) {
    window.history.replaceState(null, "", newPath);
  }
};

const areEventsEqualById = (a: SessionEvent[], b: SessionEvent[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.id !== b[i]?.id) return false;
  }
  return true;
};

const getInitialConnection = () => {
  if (typeof window === "undefined") {
    return { endpoint: "http://127.0.0.1:2468", token: "", headers: {} as Record<string, string>, hasUrlParam: false };
  }
  const params = new URLSearchParams(window.location.search);
  const urlParam = params.get("url")?.trim();
  const tokenParam = params.get("token") ?? "";
  const headersParam = params.get("headers");
  let headers: Record<string, string> = {};
  if (headersParam) {
    try {
      headers = JSON.parse(headersParam);
    } catch {
      console.warn("Invalid headers query param, ignoring");
    }
  }
  const hasUrlParam = urlParam != null && urlParam.length > 0;
  const defaultEndpoint = import.meta.env.DEV ? DEFAULT_ENDPOINT : (getCurrentOriginEndpoint() ?? DEFAULT_ENDPOINT);
  return {
    endpoint: hasUrlParam ? urlParam : defaultEndpoint,
    token: tokenParam,
    headers,
    hasUrlParam,
  };
};

const agentDisplayNames: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  amp: "Amp",
  pi: "Pi",
  cursor: "Cursor",
};

export default function App() {
  const issueTrackerUrl = "https://github.com/rivet-dev/sandbox-agent/issues";
  const docsUrl = "https://sandboxagent.dev/docs";
  const discordUrl = "https://rivet.dev/discord";
  const initialConnectionRef = useRef(getInitialConnection());
  const [endpoint, setEndpoint] = useState(initialConnectionRef.current.endpoint);
  const [token, setToken] = useState(initialConnectionRef.current.token);
  const [extraHeaders] = useState(initialConnectionRef.current.headers);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [agentId, setAgentId] = useState("claude");
  const [sessionId, setSessionId] = useState(getSessionIdFromPath());
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionModelById, setSessionModelById] = useState<Record<string, string>>(() => getPersistedSessionModels());

  const [message, setMessage] = useState("");
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [sendingSessionId, setSendingSessionId] = useState<string | null>(null);
  const [historyLoadingSessionId, setHistoryLoadingSessionId] = useState<string | null>(null);

  const [requestLog, setRequestLog] = useState<RequestLog[]>([]);
  const logIdRef = useRef(1);
  const [copiedLogId, setCopiedLogId] = useState<number | null>(null);
  const [errorToasts, setErrorToasts] = useState<ErrorToast[]>([]);
  const toastIdRef = useRef(1);
  const toastTimeoutsRef = useRef<Map<number, number>>(new Map());
  const toastExpiryRef = useRef<Map<number, number>>(new Map());
  const toastRemainingMsRef = useRef<Map<number, number>>(new Map());

  const [debugTab, setDebugTab] = useState<DebugTab>("events");
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null);
  const [debugPanelCollapsed, setDebugPanelCollapsed] = useState(false);

  const transcriptScrollRef = useRef<HTMLDivElement>(null);

  const clientRef = useRef<SandboxAgent | null>(null);
  const activeSessionRef = useRef<Session | null>(null);
  const eventUnsubRef = useRef<(() => void) | null>(null);
  const permissionUnsubRef = useRef<(() => void) | null>(null);
  const pendingPermissionsRef = useRef<Map<string, SessionPermissionRequest>>(new Map());
  const permissionToolCallToIdRef = useRef<Map<string, string>>(new Map());
  const [pendingPermissionIds, setPendingPermissionIds] = useState<Set<string>>(new Set());
  const [resolvedPermissions, setResolvedPermissions] = useState<Map<string, string>>(new Map());
  const sessionEventsCacheRef = useRef<Map<string, SessionEvent[]>>(new Map());
  const selectedSessionIdRef = useRef(sessionId);
  const resumeInFlightSessionIdRef = useRef<string | null>(null);
  const subscriptionGenerationRef = useRef(0);
  const reconnectingAfterCreateFailureRef = useRef(false);
  const creatingSessionRef = useRef(false);
  const createNoiseIgnoreUntilRef = useRef(0);

  useEffect(() => {
    selectedSessionIdRef.current = sessionId;
    if (!sessionId) {
      setHistoryLoadingSessionId(null);
    }
  }, [sessionId]);

  const logRequest = useCallback((entry: RequestLog) => {
    setRequestLog((prev) => {
      const next = [entry, ...prev];
      return next.slice(0, 200);
    });
  }, []);

  const createClient = useCallback(
    async (overrideEndpoint?: string) => {
      const targetEndpoint = overrideEndpoint ?? endpoint;
      const fetchWithLog: typeof fetch = async (input, init) => {
        const method = init?.method ?? "GET";
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const bodyText = typeof init?.body === "string" ? init.body : undefined;
        const curl = buildCurl(method, url, bodyText, token);
        const logId = logIdRef.current++;

        const headers: Record<string, string> = {};
        if (init?.headers) {
          const h = new Headers(init.headers as HeadersInit);
          h.forEach((v, k) => {
            headers[k] = v;
          });
        }

        const entry: RequestLog = {
          id: logId,
          method,
          url,
          headers,
          body: bodyText,
          time: new Date().toLocaleTimeString(),
          curl,
        };
        let logged = false;

        const fetchInit = {
          ...init,
          targetAddressSpace: "loopback",
        };

        try {
          const response = await fetch(input, fetchInit);
          const acceptsStream = headers["accept"]?.includes("text/event-stream");
          if (acceptsStream) {
            const ct = response.headers.get("content-type") ?? "";
            if (!ct.includes("text/event-stream")) {
              throw new Error(`Expected text/event-stream from ${method} ${url} but got ${ct || "(no content-type)"} (HTTP ${response.status})`);
            }
            logRequest({ ...entry, status: response.status, responseBody: "(SSE stream)" });
            logged = true;
            return response;
          }
          const clone = response.clone();
          const responseBody = await clone.text().catch(() => "");
          logRequest({ ...entry, status: response.status, responseBody });
          if (!response.ok && response.status >= 500) {
            const messageText = getHttpErrorMessage(response.status, response.statusText, responseBody);
            window.dispatchEvent(new CustomEvent<string>(HTTP_ERROR_EVENT, { detail: messageText }));
          }
          logged = true;
          return response;
        } catch (error) {
          const messageText = error instanceof Error ? error.message : "Request failed";
          if (!logged) {
            logRequest({ ...entry, status: 0, error: messageText });
          }
          throw error;
        }
      };

      let persist: SessionPersistDriver;
      try {
        persist = new IndexedDbSessionPersistDriver({
          databaseName: "sandbox-agent-inspector",
        });
      } catch {
        persist = new InMemorySessionPersistDriver({
          maxSessions: 512,
          maxEventsPerSession: 5_000,
        });
      }

      const client = await SandboxAgent.connect({
        baseUrl: targetEndpoint,
        token: token || undefined,
        fetch: fetchWithLog,
        headers: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
        persist,
      });
      clientRef.current = client;
      return client;
    },
    [endpoint, token, extraHeaders, logRequest],
  );

  const getClient = useCallback((): SandboxAgent => {
    if (!clientRef.current) {
      throw new Error("Not connected");
    }
    return clientRef.current;
  }, []);

  const dismissErrorToast = useCallback((toastId: number) => {
    const timeoutId = toastTimeoutsRef.current.get(toastId);
    if (timeoutId != null) {
      window.clearTimeout(timeoutId);
      toastTimeoutsRef.current.delete(toastId);
    }
    toastExpiryRef.current.delete(toastId);
    toastRemainingMsRef.current.delete(toastId);
    setErrorToasts((prev) => prev.filter((toast) => toast.id !== toastId));
  }, []);

  const scheduleErrorToastDismiss = useCallback(
    (toastId: number, delayMs: number) => {
      const existingTimeoutId = toastTimeoutsRef.current.get(toastId);
      if (existingTimeoutId != null) {
        window.clearTimeout(existingTimeoutId);
        toastTimeoutsRef.current.delete(toastId);
      }

      const clampedDelayMs = Math.max(0, delayMs);
      const timeoutId = window.setTimeout(() => {
        dismissErrorToast(toastId);
      }, clampedDelayMs);

      toastTimeoutsRef.current.set(toastId, timeoutId);
      toastExpiryRef.current.set(toastId, Date.now() + clampedDelayMs);
      toastRemainingMsRef.current.set(toastId, clampedDelayMs);
    },
    [dismissErrorToast],
  );

  const pauseErrorToastDismiss = useCallback((toastId: number) => {
    const expiryMs = toastExpiryRef.current.get(toastId);
    if (expiryMs == null) return;
    const remainingMs = Math.max(0, expiryMs - Date.now());
    toastRemainingMsRef.current.set(toastId, remainingMs);

    const timeoutId = toastTimeoutsRef.current.get(toastId);
    if (timeoutId != null) {
      window.clearTimeout(timeoutId);
      toastTimeoutsRef.current.delete(toastId);
    }
    toastExpiryRef.current.delete(toastId);
  }, []);

  const resumeErrorToastDismiss = useCallback(
    (toastId: number) => {
      if (toastTimeoutsRef.current.has(toastId)) return;
      const remainingMs = toastRemainingMsRef.current.get(toastId);
      if (remainingMs == null) return;
      scheduleErrorToastDismiss(toastId, remainingMs);
    },
    [scheduleErrorToastDismiss],
  );

  const pushErrorToast = useCallback(
    (error: unknown, fallback: string) => {
      const messageText = getErrorMessage(error, fallback).trim() || fallback;
      const toastId = toastIdRef.current++;
      setErrorToasts((prev) => {
        if (prev.some((toast) => toast.message === messageText)) {
          return prev;
        }
        return [...prev, { id: toastId, message: messageText }].slice(-MAX_ERROR_TOASTS);
      });
      scheduleErrorToastDismiss(toastId, ERROR_TOAST_MS);
    },
    [scheduleErrorToastDismiss],
  );

  // Subscribe to events for the current active session
  const subscribeToSession = useCallback(
    (session: Session) => {
      const generation = ++subscriptionGenerationRef.current;
      const isCurrentSubscription = (): boolean =>
        subscriptionGenerationRef.current === generation && activeSessionRef.current?.id === session.id && selectedSessionIdRef.current === session.id;

      // Unsubscribe from previous
      if (eventUnsubRef.current) {
        eventUnsubRef.current();
        eventUnsubRef.current = null;
      }

      activeSessionRef.current = session;
      const cachedEvents = sessionEventsCacheRef.current.get(session.id);
      if (cachedEvents && isCurrentSubscription()) {
        setEvents(cachedEvents);
        setHistoryLoadingSessionId((current) => (current === session.id ? null : current));
      } else if (isCurrentSubscription()) {
        setHistoryLoadingSessionId(session.id);
      }

      // Hydrate existing events from persistence
      const hydrateEvents = async () => {
        const allEvents: SessionEvent[] = [];
        let cursor: string | undefined;
        while (true) {
          const page = await getClient().getEvents({
            sessionId: session.id,
            cursor,
            limit: 250,
          });
          allEvents.push(...page.items);
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        sessionEventsCacheRef.current.set(session.id, allEvents);
        if (!isCurrentSubscription()) return;
        setEvents((prev) => (areEventsEqualById(prev, allEvents) ? prev : allEvents));
        setHistoryLoadingSessionId((current) => (current === session.id ? null : current));
      };
      hydrateEvents().catch((error) => {
        console.error("Failed to hydrate events:", error);
        if (isCurrentSubscription()) {
          setHistoryLoadingSessionId((current) => (current === session.id ? null : current));
        }
      });

      // Subscribe to new events
      const unsub = session.onEvent((event) => {
        if (!isCurrentSubscription()) return;
        setEvents((prev) => {
          if (prev.some((existing) => existing.id === event.id)) {
            return prev;
          }
          const next = [...prev, event];
          sessionEventsCacheRef.current.set(session.id, next);
          return next;
        });
      });
      eventUnsubRef.current = unsub;

      // Subscribe to permission requests
      if (permissionUnsubRef.current) {
        permissionUnsubRef.current();
        permissionUnsubRef.current = null;
      }
      const permUnsub = session.onPermissionRequest((request: SessionPermissionRequest) => {
        if (!isCurrentSubscription()) return;
        pendingPermissionsRef.current.set(request.id, request);
        if (request.toolCall?.toolCallId) {
          permissionToolCallToIdRef.current.set(request.toolCall.toolCallId, request.id);
        }
        setPendingPermissionIds((prev) => new Set([...prev, request.id]));
      });
      permissionUnsubRef.current = permUnsub;
    },
    [getClient],
  );

  const handlePermissionReply = useCallback(
    async (permissionId: string, reply: PermissionReply) => {
      const session = activeSessionRef.current;
      if (!session) return;
      try {
        await session.respondPermission(permissionId, reply);
        const request = pendingPermissionsRef.current.get(permissionId);
        const selectedOption = request?.options.find((o) =>
          reply === "always" ? o.kind === "allow_always" : reply === "once" ? o.kind === "allow_once" : o.kind === "reject_once" || o.kind === "reject_always",
        );
        setResolvedPermissions((prev) => new Map([...prev, [permissionId, selectedOption?.optionId ?? reply]]));
        setPendingPermissionIds((prev) => {
          const next = new Set(prev);
          next.delete(permissionId);
          return next;
        });
      } catch (error) {
        pushErrorToast(error, "Failed to respond to permission request");
      }
    },
    [pushErrorToast],
  );

  const connectToDaemon = async (reportError: boolean, overrideEndpoint?: string) => {
    setConnecting(true);
    if (reportError) {
      setConnectError(null);
    }
    try {
      // Ensure reconnects do not keep stale session subscriptions/clients around.
      if (eventUnsubRef.current) {
        eventUnsubRef.current();
        eventUnsubRef.current = null;
      }
      if (permissionUnsubRef.current) {
        permissionUnsubRef.current();
        permissionUnsubRef.current = null;
      }
      subscriptionGenerationRef.current += 1;
      activeSessionRef.current = null;
      if (clientRef.current) {
        try {
          await clientRef.current.dispose();
        } catch (disposeError) {
          console.warn("Failed to dispose previous client during reconnect:", disposeError);
        } finally {
          clientRef.current = null;
        }
      }

      const client = await createClient(overrideEndpoint);
      await client.getHealth();
      if (overrideEndpoint) {
        setEndpoint(overrideEndpoint);
      }
      setConnected(true);
      await refreshAgents();
      await fetchSessions();
      if (sessionId) {
        try {
          const resumed = await client.resumeSession(sessionId);
          subscribeToSession(resumed);
        } catch (resumeError) {
          console.warn("Failed to resume current session after reconnect:", resumeError);
          setHistoryLoadingSessionId(null);
        }
      }
      if (reportError) {
        setConnectError(null);
      }
    } catch (error) {
      if (reportError) {
        const messageText = getErrorMessage(error, "Unable to connect");
        setConnectError(messageText);
      }
      setConnected(false);
      clientRef.current = null;
      throw error;
    } finally {
      setConnecting(false);
    }
  };

  const connect = () => connectToDaemon(true);

  const disconnect = () => {
    if (eventUnsubRef.current) {
      eventUnsubRef.current();
      eventUnsubRef.current = null;
    }
    if (permissionUnsubRef.current) {
      permissionUnsubRef.current();
      permissionUnsubRef.current = null;
    }
    subscriptionGenerationRef.current += 1;
    activeSessionRef.current = null;
    if (clientRef.current) {
      void clientRef.current.dispose().catch((error) => {
        console.warn("Failed to dispose client on disconnect:", error);
      });
    }
    setConnected(false);
    clientRef.current = null;
    setSessionError(null);
    setEvents([]);
    setHistoryLoadingSessionId(null);
    setAgents([]);
    setSessions([]);
    sessionEventsCacheRef.current.clear();
    setAgentsLoading(false);
    setSessionsLoading(false);
    setAgentsError(null);
    setSessionsError(null);
  };

  const refreshAgents = async () => {
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      const data = await getClient().listAgents();
      setAgents(data.agents ?? []);
    } catch (error) {
      setAgentsError(getErrorMessage(error, "Unable to refresh agents"));
    } finally {
      setAgentsLoading(false);
    }
  };

  const loadAgentConfig = useCallback(
    async (targetAgentId: string) => {
      console.log("[loadAgentConfig] Loading config for agent:", targetAgentId);
      try {
        const info = await getClient().getAgent(targetAgentId, { config: true });
        console.log("[loadAgentConfig] Got agent info:", info);
        setAgents((prev) => prev.map((a) => (a.id === targetAgentId ? { ...a, configOptions: info.configOptions, configError: info.configError } : a)));
      } catch (error) {
        console.error("[loadAgentConfig] Failed to load config:", error);
        // Config loading is best-effort; the menu still works without it.
      }
    },
    [getClient],
  );

  const fetchSessions = async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const archivedSessionIds = getArchivedSessionIds();
      // TODO: This eagerly paginates all sessions so we can reverse-sort to
      // show newest first. Replace with a server-side descending sort or a
      // dedicated "recent sessions" query once the API supports it.
      const all: SessionListItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await getClient().listSessions({ cursor, limit: 200 });
        for (const s of page.items) {
          all.push({
            sessionId: s.id,
            agent: s.agent,
            ended: s.destroyedAt != null,
            archived: archivedSessionIds.has(s.id),
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      all.reverse();
      setSessions(all);
    } catch {
      setSessionsError("Unable to load sessions.");
    } finally {
      setSessionsLoading(false);
    }
  };

  const archiveSession = async (targetSessionId: string) => {
    archiveSessionId(targetSessionId);
    try {
      try {
        await getClient().destroySession(targetSessionId);
      } catch (error) {
        // If the server already considers the session gone, still archive in local UI.
        console.warn("Destroy session returned an error while archiving:", error);
      }
      setSessions((prev) => prev.map((session) => (session.sessionId === targetSessionId ? { ...session, archived: true, ended: true } : session)));
      setSessionModelById((prev) => {
        if (!(targetSessionId in prev)) return prev;
        const next = { ...prev };
        delete next[targetSessionId];
        return next;
      });
      await fetchSessions();
    } catch (error) {
      console.error("Failed to archive session:", error);
    }
  };

  const unarchiveSession = async (targetSessionId: string) => {
    unarchiveSessionId(targetSessionId);
    setSessions((prev) => prev.map((session) => (session.sessionId === targetSessionId ? { ...session, archived: false } : session)));
    await fetchSessions();
  };

  const installAgent = async (targetId: string, reinstall: boolean) => {
    try {
      await getClient().installAgent(targetId, { reinstall });
      await refreshAgents();
    } catch (error) {
      setConnectError(getErrorMessage(error, "Install failed"));
    }
  };

  const sendMessage = async () => {
    const prompt = message.trim();
    if (!prompt || !sessionId || sendingSessionId) return;
    const targetSessionId = sessionId;
    setSessionError(null);
    setMessage("");
    setSendingSessionId(targetSessionId);

    try {
      let session = activeSessionRef.current;
      if (!session || session.id !== targetSessionId) {
        session = await getClient().resumeSession(targetSessionId);
        subscribeToSession(session);
      }
      await session.prompt([{ type: "text", text: prompt }]);
    } catch (error) {
      setSessionError(getErrorMessage(error, "Unable to send message"));
    } finally {
      setSendingSessionId(null);
    }
  };

  const selectSession = (session: SessionListItem) => {
    setSessionId(session.sessionId);
    selectedSessionIdRef.current = session.sessionId;
    updateSessionPath(session.sessionId);
    setAgentId(session.agent);
    setSessionModelById((prev) => {
      if (prev[session.sessionId]) return prev;
      const fallbackModel = defaultModelByAgent[session.agent];
      if (!fallbackModel) return prev;
      return { ...prev, [session.sessionId]: fallbackModel };
    });
    const cachedEvents = sessionEventsCacheRef.current.get(session.sessionId);
    if (cachedEvents) {
      setEvents(cachedEvents);
      setHistoryLoadingSessionId(null);
    } else {
      setEvents([]);
      setHistoryLoadingSessionId(session.sessionId);
    }
    setSessionError(null);
  };

  const createNewSession = async (nextAgentId: string, config: { agentMode: string; model: string }) => {
    console.log("[createNewSession] Creating session for agent:", nextAgentId, "config:", config);
    setSessionError(null);
    creatingSessionRef.current = true;
    createNoiseIgnoreUntilRef.current = Date.now() + 10_000;

    try {
      console.log("[createNewSession] Calling createSession...");
      const createSessionPromise = getClient().createSession({
        agent: nextAgentId,
        sessionInit: {
          cwd: "/",
          mcpServers: [],
        },
      });

      let slowWarningShown = false;
      const slowWarningTimerId = window.setTimeout(() => {
        slowWarningShown = true;
        setSessionError("Session creation is taking longer than expected. Waiting for agent startup...");
      }, CREATE_SESSION_SLOW_WARNING_MS);
      let session: Awaited<ReturnType<SandboxAgent["createSession"]>>;
      try {
        session = await createSessionPromise;
      } finally {
        window.clearTimeout(slowWarningTimerId);
      }
      console.log("[createNewSession] Session created:", session.id);
      if (slowWarningShown) {
        setSessionError(null);
      }

      setAgentId(nextAgentId);
      setEvents([]);
      setHistoryLoadingSessionId(null);
      setSessionId(session.id);
      selectedSessionIdRef.current = session.id;
      updateSessionPath(session.id);
      sessionEventsCacheRef.current.set(session.id, []);
      subscribeToSession(session);
      const skipPostCreateConfig = nextAgentId === "opencode";

      // Apply mode if selected
      if (!skipPostCreateConfig && config.agentMode) {
        try {
          await session.rawSend("session/set_mode", { modeId: config.agentMode });
        } catch {
          // Mode application is best-effort
        }
      }

      // Apply model if selected
      if (config.model) {
        setSessionModelById((prev) => ({ ...prev, [session.id]: config.model }));
        if (!skipPostCreateConfig) {
          try {
            const agentInfo = agents.find((agent) => agent.id === nextAgentId);
            const modelOption = ((agentInfo?.configOptions ?? []) as ConfigOption[]).find(
              (opt) => opt.category === "model" && opt.type === "select" && typeof opt.id === "string",
            );
            if (modelOption && config.model !== modelOption.currentValue) {
              await session.rawSend("session/set_config_option", {
                optionId: modelOption.id,
                value: config.model,
              });
            }
          } catch {
            // Model application is best-effort
          }
        }
      }

      // Refresh session list in background; UI should not stay blocked on list pagination.
      void fetchSessions();
    } catch (error) {
      console.error("[createNewSession] Failed to create session:", error);
      const messageText = getErrorMessage(error, "Unable to create session");
      console.error("[createNewSession] Error message:", messageText);
      setSessionError(messageText);
      pushErrorToast(error, messageText);
      if (!reconnectingAfterCreateFailureRef.current) {
        reconnectingAfterCreateFailureRef.current = true;
        // Run recovery in background so failed creates do not block UI.
        void connectToDaemon(false)
          .catch((reconnectError) => {
            console.error("[createNewSession] Soft reconnect failed:", reconnectError);
          })
          .finally(() => {
            reconnectingAfterCreateFailureRef.current = false;
          });
      }
      throw error;
    } finally {
      creatingSessionRef.current = false;
      // Keep a short post-create window for delayed transport rejections.
      createNoiseIgnoreUntilRef.current = Date.now() + 2_000;
    }
  };

  const endSession = async () => {
    if (!sessionId) return;
    try {
      await getClient().destroySession(sessionId);
      if (eventUnsubRef.current) {
        eventUnsubRef.current();
        eventUnsubRef.current = null;
      }
      if (permissionUnsubRef.current) {
        permissionUnsubRef.current();
        permissionUnsubRef.current = null;
      }
      activeSessionRef.current = null;
      await fetchSessions();
    } catch (error) {
      setSessionError(getErrorMessage(error, "Unable to end session"));
    }
  };

  const handleCopy = (entry: RequestLog) => {
    const text = entry.curl;
    const onSuccess = () => {
      setCopiedLogId(entry.id);
      window.setTimeout(() => setCopiedLogId(null), 1500);
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard
        .writeText(text)
        .then(onSuccess)
        .catch(() => {
          fallbackCopy(text, onSuccess);
        });
    } else {
      fallbackCopy(text, onSuccess);
    }
  };

  const fallbackCopy = (text: string, onSuccess?: () => void) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      onSuccess?.();
    } catch (err) {
      console.error("Failed to copy:", err);
    }
    document.body.removeChild(textarea);
  };

  // Build transcript entries from raw SessionEvents
  const transcriptEntries = useMemo(() => {
    const entries: TranscriptEntry[] = [];

    // Accumulators for streaming chunks
    let assistantAccumId: string | null = null;
    let assistantAccumText = "";
    let thoughtAccumId: string | null = null;
    let thoughtAccumText = "";

    const flushAssistant = (time: string) => {
      if (assistantAccumId) {
        const existing = entries.find((e) => e.id === assistantAccumId);
        if (existing) {
          existing.text = assistantAccumText;
          existing.time = time;
        }
      }
      assistantAccumId = null;
      assistantAccumText = "";
    };

    const flushThought = (time: string) => {
      if (thoughtAccumId) {
        const existing = entries.find((e) => e.id === thoughtAccumId);
        if (existing && existing.reasoning) {
          existing.reasoning.text = thoughtAccumText;
          existing.time = time;
        }
      }
      thoughtAccumId = null;
      thoughtAccumText = "";
    };

    // Track tool calls by ID for updates
    const toolEntryMap = new Map<string, TranscriptEntry>();

    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      const method = typeof payload.method === "string" ? payload.method : null;
      const time = new Date(event.createdAt).toISOString();

      if (event.sender === "client" && method === "session/prompt") {
        // User message
        flushAssistant(time);
        flushThought(time);
        const params = payload.params as Record<string, unknown> | undefined;
        const promptArray = params?.prompt as Array<{ type: string; text?: string }> | undefined;
        const replayPrefix = "Previous session history is replayed below";
        const text = (promptArray ?? [])
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text!.trim())
          // SDK replay prompt is prepended to the real user prompt; drop only replay blocks.
          .filter((partText) => partText.length > 0 && !partText.startsWith(replayPrefix))
          .join("\n\n")
          .trim();
        if (!text) {
          continue;
        }
        entries.push({
          id: event.id,
          eventId: event.id,
          kind: "message",
          time,
          role: "user",
          text,
        });
        continue;
      }

      if (event.sender === "agent" && method === "session/update") {
        const params = payload.params as Record<string, unknown> | undefined;
        const update = params?.update as Record<string, unknown> | undefined;
        if (!update || typeof update.sessionUpdate !== "string") continue;

        switch (update.sessionUpdate) {
          case "agent_message_chunk": {
            const content = update.content as { type?: string; text?: string } | undefined;
            if (content?.type === "text" && content.text) {
              if (!assistantAccumId) {
                assistantAccumId = `assistant-${event.id}`;
                assistantAccumText = "";
                entries.push({
                  id: assistantAccumId,
                  eventId: event.id,
                  kind: "message",
                  time,
                  role: "assistant",
                  text: "",
                });
              }
              assistantAccumText += content.text;
              const entry = entries.find((e) => e.id === assistantAccumId);
              if (entry) {
                entry.text = assistantAccumText;
                entry.time = time;
              }
            }
            break;
          }
          case "agent_thought_chunk": {
            const content = update.content as { type?: string; text?: string } | undefined;
            if (content?.type === "text" && content.text) {
              if (!thoughtAccumId) {
                thoughtAccumId = `thought-${event.id}`;
                thoughtAccumText = "";
                entries.push({
                  id: thoughtAccumId,
                  eventId: event.id,
                  kind: "reasoning",
                  time,
                  reasoning: { text: "", visibility: "public" },
                });
              }
              thoughtAccumText += content.text;
              const entry = entries.find((e) => e.id === thoughtAccumId);
              if (entry && entry.reasoning) {
                entry.reasoning.text = thoughtAccumText;
                entry.time = time;
              }
            }
            break;
          }
          case "user_message_chunk": {
            const content = update.content as { type?: string; text?: string } | undefined;
            const text = content?.type === "text" ? (content.text ?? "") : JSON.stringify(content);
            entries.push({
              id: event.id,
              eventId: event.id,
              kind: "message",
              time,
              role: "user",
              text,
            });
            break;
          }
          case "tool_call": {
            flushAssistant(time);
            flushThought(time);
            const toolCallId = (update.toolCallId as string) ?? event.id;
            const existing = toolEntryMap.get(toolCallId);
            if (existing) {
              // Update existing entry instead of creating a duplicate
              if (update.status) existing.toolStatus = update.status as string;
              if (update.rawInput != null) existing.toolInput = JSON.stringify(update.rawInput, null, 2);
              if (update.rawOutput != null) existing.toolOutput = JSON.stringify(update.rawOutput, null, 2);
              if (update.title) existing.toolName = update.title as string;
              existing.time = time;
            } else {
              const entry: TranscriptEntry = {
                id: `tool-${toolCallId}`,
                eventId: event.id,
                kind: "tool",
                time,
                toolName: (update.title as string) ?? "tool",
                toolInput: update.rawInput != null ? JSON.stringify(update.rawInput, null, 2) : undefined,
                toolOutput: update.rawOutput != null ? JSON.stringify(update.rawOutput, null, 2) : undefined,
                toolStatus: (update.status as string) ?? "in_progress",
              };
              toolEntryMap.set(toolCallId, entry);
              entries.push(entry);
            }
            break;
          }
          case "tool_call_update": {
            const toolCallId = update.toolCallId as string;
            const existing = toolEntryMap.get(toolCallId);
            if (existing) {
              if (update.status) existing.toolStatus = update.status as string;
              if (update.rawOutput != null) existing.toolOutput = JSON.stringify(update.rawOutput, null, 2);
              if (update.title) existing.toolName = (existing.toolName ?? "") + (update.title as string);
              existing.time = time;
            }
            break;
          }
          case "plan": {
            const planEntries = (update.entries as Array<{ content: string; status: string }>) ?? [];
            const detail = planEntries.map((e) => `[${e.status}] ${e.content}`).join("\n");
            entries.push({
              id: event.id,
              eventId: event.id,
              kind: "meta",
              time,
              meta: { title: "Plan", detail, severity: "info" },
            });
            break;
          }
          case "session_info_update": {
            const title = update.title as string | undefined;
            entries.push({
              id: event.id,
              eventId: event.id,
              kind: "meta",
              time,
              meta: { title: "Session info update", detail: title ? `Title: ${title}` : undefined, severity: "info" },
            });
            break;
          }
          case "usage_update": {
            // Token usage is displayed in the config bar, not in the transcript
            break;
          }
          case "current_mode_update": {
            entries.push({
              id: event.id,
              eventId: event.id,
              kind: "meta",
              time,
              meta: { title: "Mode changed", detail: update.currentModeId as string, severity: "info" },
            });
            break;
          }
          case "config_option_update": {
            entries.push({
              id: event.id,
              eventId: event.id,
              kind: "meta",
              time,
              meta: { title: "Config option update", severity: "info" },
            });
            break;
          }
          case "available_commands_update": {
            entries.push({
              id: event.id,
              eventId: event.id,
              kind: "meta",
              time,
              meta: { title: "Available commands update", severity: "info" },
            });
            break;
          }
          default: {
            entries.push({
              id: event.id,
              eventId: event.id,
              kind: "meta",
              time,
              meta: { title: `session/update: ${update.sessionUpdate}`, severity: "info" },
            });
            break;
          }
        }
        continue;
      }

      if (event.sender === "agent" && method === "session/request_permission") {
        const params = payload.params as
          | {
              options?: Array<{ optionId: string; name: string; kind: string }>;
              toolCall?: { title?: string; toolCallId?: string; description?: string };
            }
          | undefined;
        const toolCallId = params?.toolCall?.toolCallId;
        const sdkPermissionId = toolCallId ? permissionToolCallToIdRef.current.get(toolCallId) : undefined;
        const permissionId = sdkPermissionId ?? (typeof payload.id === "number" || typeof payload.id === "string" ? String(payload.id) : event.id);
        const options = (params?.options ?? []).map((o) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        }));
        const title = params?.toolCall?.title ?? params?.toolCall?.toolCallId ?? "Permission request";
        const resolved = resolvedPermissions.get(permissionId);
        entries.push({
          id: event.id,
          eventId: event.id,
          kind: "permission",
          time,
          permission: {
            permissionId,
            title,
            description: params?.toolCall?.description,
            options,
            resolved: resolved != null || sdkPermissionId == null,
            selectedOptionId: resolved,
          },
        });
        continue;
      }

      if (event.sender === "agent" && method === "_sandboxagent/agent/unparsed") {
        const params = payload.params as { error?: string; location?: string } | undefined;
        entries.push({
          id: event.id,
          eventId: event.id,
          kind: "meta",
          time,
          meta: {
            title: "Agent parse failure",
            detail: `${params?.location ?? "unknown"}: ${params?.error ?? "unknown error"}`,
            severity: "error",
          },
        });
        continue;
      }

      // For any other ACP envelope, show as generic meta
      if (method) {
        entries.push({
          id: event.id,
          eventId: event.id,
          kind: "meta",
          time,
          meta: { title: method, detail: event.sender, severity: "info" },
        });
      }
    }

    return entries;
  }, [events, resolvedPermissions]);

  useEffect(() => {
    return () => {
      if (eventUnsubRef.current) {
        eventUnsubRef.current();
        eventUnsubRef.current = null;
      }
      if (permissionUnsubRef.current) {
        permissionUnsubRef.current();
        permissionUnsubRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const shouldIgnoreCreateNoise = (value: unknown): boolean => {
      if (Date.now() > createNoiseIgnoreUntilRef.current) return false;
      const message = getErrorMessage(value, "").trim().toLowerCase();
      return message.length === 0 || message === "request failed" || message.includes("request failed") || message.includes("unhandled promise rejection");
    };

    const handleWindowError = (event: ErrorEvent) => {
      const errorLike = event.error ?? event.message;
      if (shouldIgnoreCreateNoise(errorLike)) return;
      if (shouldIgnoreGlobalError(errorLike)) return;
      pushErrorToast(errorLike, "Unexpected error");
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (shouldIgnoreCreateNoise(event.reason)) {
        event.preventDefault();
        return;
      }
      if (shouldIgnoreGlobalError(event.reason)) {
        event.preventDefault();
        return;
      }
      pushErrorToast(event.reason, "Unhandled promise rejection");
    };
    const handleHttpError = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail.trim()) {
        pushErrorToast(new Error(detail), detail);
      }
    };
    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener(HTTP_ERROR_EVENT, handleHttpError);
    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      window.removeEventListener(HTTP_ERROR_EVENT, handleHttpError);
    };
  }, [pushErrorToast]);

  useEffect(() => {
    return () => {
      for (const timeoutId of toastTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      toastTimeoutsRef.current.clear();
      toastExpiryRef.current.clear();
      toastRemainingMsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const attempt = async () => {
      const { hasUrlParam } = initialConnectionRef.current;

      if (hasUrlParam) {
        try {
          await connectToDaemon(false);
        } catch {
          // Keep the URL param endpoint in the form even if connection failed
        }
        return;
      }

      const originEndpoint = getCurrentOriginEndpoint();
      if (originEndpoint) {
        try {
          await connectToDaemon(false, originEndpoint);
          return;
        } catch {
          // Origin failed, continue to fallback
        }
      }

      if (!active) return;
      try {
        await connectToDaemon(false, DEFAULT_ENDPOINT);
      } catch {
        setEndpoint(DEFAULT_ENDPOINT);
      }
    };
    attempt().catch(() => {
      if (!active) return;
      setConnecting(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!connected) return;
    refreshAgents();
  }, [connected]);

  // Auto-load session when sessionId changes
  useEffect(() => {
    if (!connected || !sessionId) return;
    if (creatingSessionRef.current) return;
    if (resumeInFlightSessionIdRef.current === sessionId) return;
    const sessionInfo = sessions.find((s) => s.sessionId === sessionId);
    if (!sessionInfo) return;
    if (activeSessionRef.current?.id === sessionId) return;

    // Set the correct agent from the session
    setAgentId(sessionInfo.agent);
    const cachedEvents = sessionEventsCacheRef.current.get(sessionId);
    if (cachedEvents) {
      setEvents(cachedEvents);
      setHistoryLoadingSessionId(null);
    } else {
      setEvents([]);
      setHistoryLoadingSessionId(sessionId);
    }
    setSessionError(null);

    const requestedSessionId = sessionId;
    resumeInFlightSessionIdRef.current = requestedSessionId;

    getClient()
      .resumeSession(requestedSessionId)
      .then((session) => {
        if (selectedSessionIdRef.current !== requestedSessionId) return;
        subscribeToSession(session);
      })
      .catch((error) => {
        if (selectedSessionIdRef.current !== requestedSessionId) return;
        setSessionError(getErrorMessage(error, "Unable to resume session"));
        setHistoryLoadingSessionId((current) => (current === requestedSessionId ? null : current));
      })
      .finally(() => {
        if (resumeInFlightSessionIdRef.current === requestedSessionId) {
          resumeInFlightSessionIdRef.current = null;
        }
      });
  }, [connected, sessionId, sessions, getClient, subscribeToSession]);

  const currentAgent = agents.find((agent) => agent.id === agentId);
  const agentLabel = agentDisplayNames[agentId] ?? agentId;
  const selectedSession = sessions.find((s) => s.sessionId === sessionId);
  const sessionArchived = selectedSession?.archived ?? false;
  // Archived sessions are treated as ended in UI so they can never be "ended again".
  const sessionEnded = (selectedSession?.ended ?? false) || sessionArchived;

  // Determine if agent is thinking (has in-progress tools or waiting for response)
  const isThinking = useMemo(() => {
    if (!sessionId || sessionEnded) return false;
    // If actively sending a prompt, show thinking
    if (sendingSessionId === sessionId) return true;
    // Check for in-progress tool calls
    const hasInProgressTool = transcriptEntries.some((e) => e.kind === "tool" && e.toolStatus === "in_progress");
    if (hasInProgressTool) return true;
    // Check if last message was from user with no subsequent agent activity
    const lastUserMessageIndex = [...transcriptEntries].reverse().findIndex((e) => e.kind === "message" && e.role === "user");
    if (lastUserMessageIndex === -1) return false;
    // If user message is the very last entry, we're waiting for response
    if (lastUserMessageIndex === 0) return true;
    // Check if there's any agent response after the user message
    const entriesAfterUser = transcriptEntries.slice(-lastUserMessageIndex);
    const hasAgentResponse = entriesAfterUser.some((e) => e.kind === "message" && e.role === "assistant");
    // If no assistant message after user, but there are completed tools, not thinking
    const hasCompletedTools = entriesAfterUser.some((e) => e.kind === "tool" && (e.toolStatus === "completed" || e.toolStatus === "failed"));
    if (!hasAgentResponse && !hasCompletedTools) return true;
    return false;
  }, [sessionId, sessionEnded, transcriptEntries, sendingSessionId]);

  // Extract latest token usage from events
  const tokenUsage = useMemo(() => {
    let latest: { used: number; size: number; cost?: number } | null = null;
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      const method = typeof payload.method === "string" ? payload.method : null;
      if (event.sender === "agent" && method === "session/update") {
        const params = payload.params as Record<string, unknown> | undefined;
        const update = params?.update as Record<string, unknown> | undefined;
        if (update?.sessionUpdate === "usage_update") {
          latest = {
            used: (update.used as number) ?? 0,
            size: (update.size as number) ?? 0,
            cost: (update.cost as { total?: number })?.total,
          };
        }
      }
    }
    return latest;
  }, [events]);

  // Extract modes and models from configOptions
  const modesByAgent = useMemo(() => {
    const result: Record<string, AgentModeInfo[]> = {};
    for (const agent of agents) {
      const options = (agent.configOptions ?? []) as ConfigOption[];
      for (const opt of options) {
        if (opt.category === "mode" && opt.type === "select" && opt.options) {
          result[agent.id] = flattenSelectOptions(opt.options).map((o) => ({
            id: o.value,
            name: o.name,
            description: o.description ?? "",
          }));
        }
      }
    }
    return result;
  }, [agents]);

  const modelsByAgent = useMemo(() => {
    const result: Record<string, AgentModelInfo[]> = {};
    for (const agent of agents) {
      const options = (agent.configOptions ?? []) as ConfigOption[];
      for (const opt of options) {
        if (opt.category === "model" && opt.type === "select" && opt.options) {
          result[agent.id] = flattenSelectOptions(opt.options).map((o) => ({
            id: o.value,
            name: o.name,
          }));
        }
      }
    }
    return result;
  }, [agents]);

  const defaultModelByAgent = useMemo(() => {
    const result: Record<string, string> = {};
    for (const agent of agents) {
      const options = (agent.configOptions ?? []) as ConfigOption[];
      for (const opt of options) {
        if (opt.category === "model" && opt.type === "select" && opt.currentValue) {
          result[agent.id] = opt.currentValue;
        }
      }
    }
    return result;
  }, [agents]);

  const currentSessionModelId = useMemo(() => {
    let latestModelId: string | null = null;

    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      const method = typeof payload.method === "string" ? payload.method : null;
      const params = payload.params as Record<string, unknown> | undefined;

      if (event.sender === "agent" && method === "session/update") {
        const update = params?.update as Record<string, unknown> | undefined;
        if (update?.sessionUpdate !== "config_option_update") continue;

        const category = (update.category as string | undefined) ?? ((update.option as Record<string, unknown> | undefined)?.category as string | undefined);
        if (category && category !== "model") continue;

        const optionId =
          (update.optionId as string | undefined) ??
          (update.configOptionId as string | undefined) ??
          ((update.option as Record<string, unknown> | undefined)?.id as string | undefined);
        const seemsModelOption = !optionId || optionId.toLowerCase().includes("model");
        if (!seemsModelOption) continue;

        const candidate =
          (update.value as string | undefined) ??
          (update.currentValue as string | undefined) ??
          (update.selectedValue as string | undefined) ??
          (update.modelId as string | undefined);
        if (candidate) {
          latestModelId = candidate;
        }
        continue;
      }

      // Capture explicit client-side model changes; these are persisted and survive refresh.
      if (event.sender === "client" && method === "unstable/set_session_model") {
        const candidate = params?.modelId as string | undefined;
        if (candidate) {
          latestModelId = candidate;
        }
        continue;
      }

      if (event.sender === "client" && method === "session/set_config_option") {
        const category = params?.category as string | undefined;
        const optionId = params?.optionId as string | undefined;
        const seemsModelOption = category === "model" || (typeof optionId === "string" && optionId.toLowerCase().includes("model"));
        if (!seemsModelOption) continue;
        const candidate = (params?.value as string | undefined) ?? (params?.currentValue as string | undefined) ?? (params?.modelId as string | undefined);
        if (candidate) {
          latestModelId = candidate;
        }
      }
    }

    return latestModelId;
  }, [events]);

  const modelPillLabel = useMemo(() => {
    const sessionModelId =
      currentSessionModelId ?? (sessionId ? sessionModelById[sessionId] : undefined) ?? (sessionId ? defaultModelByAgent[agentId] : undefined);
    if (!sessionModelId) return null;
    return sessionModelId;
  }, [agentId, currentSessionModelId, defaultModelByAgent, sessionId, sessionModelById]);

  useEffect(() => {
    if (!sessionId || !currentSessionModelId) return;
    setSessionModelById((prev) => (prev[sessionId] === currentSessionModelId ? prev : { ...prev, [sessionId]: currentSessionModelId }));
  }, [currentSessionModelId, sessionId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SESSION_MODELS_KEY, JSON.stringify(sessionModelById));
    } catch {
      // Ignore storage write failures.
    }
  }, [sessionModelById]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  const toastStack = (
    <div className="toast-stack" aria-live="assertive" aria-atomic="false">
      {errorToasts.map((toast) => (
        <div
          key={toast.id}
          className="toast error"
          role="status"
          onMouseEnter={() => pauseErrorToastDismiss(toast.id)}
          onMouseLeave={() => resumeErrorToastDismiss(toast.id)}
          onFocus={() => pauseErrorToastDismiss(toast.id)}
          onBlur={() => resumeErrorToastDismiss(toast.id)}
        >
          <button type="button" className="toast-close" aria-label="Dismiss error" onClick={() => dismissErrorToast(toast.id)}>
            ×
          </button>
          <div className="toast-content">
            <div className="toast-title">Request failed</div>
            <div className="toast-message">{toast.message}</div>
          </div>
        </div>
      ))}
    </div>
  );

  if (!connected) {
    return (
      <>
        <ConnectScreen
          endpoint={endpoint}
          token={token}
          connectError={connectError}
          connecting={connecting}
          onEndpointChange={setEndpoint}
          onTokenChange={setToken}
          onConnect={connect}
          reportUrl={issueTrackerUrl}
          docsUrl={docsUrl}
          discordUrl={discordUrl}
        />
        {toastStack}
      </>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <img src={logoUrl} alt="Sandbox Agent" className="logo-text" style={{ height: "20px", width: "auto" }} />
          <span className="header-endpoint">{endpoint}</span>
        </div>
        <div className="header-right">
          <a className="header-link" href={docsUrl} target="_blank" rel="noreferrer">
            <BookOpen size={12} />
            Docs
          </a>
          <a className="header-link" href={discordUrl} target="_blank" rel="noreferrer">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
            </svg>
            Discord
          </a>
          <a className="header-link" href={issueTrackerUrl} target="_blank" rel="noreferrer">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
            Issues
          </a>
          <button className="button secondary small" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      </header>

      <main className={`main-layout ${debugPanelCollapsed ? "debug-collapsed" : ""}`}>
        <SessionSidebar
          sessions={sessions}
          selectedSessionId={sessionId}
          onSelectSession={selectSession}
          onRefresh={fetchSessions}
          onCreateSession={createNewSession}
          onSelectAgent={loadAgentConfig}
          agents={
            agents.length
              ? agents
              : defaultAgents.map((id) => ({
                  id,
                  installed: false,
                  credentialsAvailable: true,
                  capabilities: {} as AgentInfo["capabilities"],
                }))
          }
          agentsLoading={agentsLoading}
          agentsError={agentsError}
          sessionsLoading={sessionsLoading}
          sessionsError={sessionsError}
          modesByAgent={modesByAgent}
          modelsByAgent={modelsByAgent}
          defaultModelByAgent={defaultModelByAgent}
        />

        <ChatPanel
          sessionId={sessionId}
          transcriptEntries={transcriptEntries}
          isLoadingHistory={historyLoadingSessionId === sessionId}
          sessionError={sessionError}
          message={message}
          onMessageChange={setMessage}
          onSendMessage={sendMessage}
          onKeyDown={handleKeyDown}
          onCreateSession={createNewSession}
          onSelectAgent={loadAgentConfig}
          agents={
            agents.length
              ? agents
              : defaultAgents.map((id) => ({
                  id,
                  installed: false,
                  credentialsAvailable: true,
                  capabilities: {} as AgentInfo["capabilities"],
                }))
          }
          agentsLoading={agentsLoading}
          agentsError={agentsError}
          scrollRef={transcriptScrollRef}
          agentLabel={agentLabel}
          modelLabel={modelPillLabel}
          currentAgentVersion={currentAgent?.version ?? null}
          sessionEnded={sessionEnded}
          sessionArchived={sessionArchived}
          onEndSession={endSession}
          onArchiveSession={() => {
            if (sessionId) {
              void archiveSession(sessionId);
            }
          }}
          onUnarchiveSession={() => {
            if (sessionId) {
              void unarchiveSession(sessionId);
            }
          }}
          modesByAgent={modesByAgent}
          modelsByAgent={modelsByAgent}
          defaultModelByAgent={defaultModelByAgent}
          onEventClick={(eventId) => {
            setDebugTab("events");
            setHighlightedEventId(eventId);
          }}
          isThinking={isThinking}
          agentId={agentId}
          tokenUsage={tokenUsage}
          onPermissionReply={handlePermissionReply}
        />

        <DebugPanel
          debugTab={debugTab}
          onDebugTabChange={setDebugTab}
          events={events}
          onResetEvents={() => setEvents([])}
          highlightedEventId={highlightedEventId}
          onClearHighlight={() => setHighlightedEventId(null)}
          requestLog={requestLog}
          copiedLogId={copiedLogId}
          onClearRequestLog={() => setRequestLog([])}
          onCopyRequestLog={handleCopy}
          agents={agents}
          defaultAgents={defaultAgents}
          modesByAgent={modesByAgent}
          onRefreshAgents={refreshAgents}
          onInstallAgent={installAgent}
          agentsLoading={agentsLoading}
          agentsError={agentsError}
          getClient={getClient}
          collapsed={debugPanelCollapsed}
          onToggleCollapse={() => setDebugPanelCollapsed(!debugPanelCollapsed)}
        />
      </main>
      {toastStack}
    </div>
  );
}
