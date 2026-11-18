import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useStyletron } from "baseui";
import {
  DEFAULT_WORKSPACE_MODEL_GROUPS,
  DEFAULT_WORKSPACE_MODEL_ID,
  createErrorContext,
  type FoundryOrganization,
  type TaskWorkspaceSnapshot,
  type WorkspaceModelGroup,
  type WorkspaceSessionSummary,
  type WorkspaceTaskDetail,
  type WorkspaceTaskSummary,
} from "@sandbox-agent/foundry-shared";
import { useSubscription } from "@sandbox-agent/foundry-client";

import { CircleAlert, PanelLeft, PanelRight } from "lucide-react";
import { useFoundryTokens } from "../app/theme";
import { logger } from "../logging.js";

import { DiffContent } from "./mock-layout/diff-content";
import { MessageList } from "./mock-layout/message-list";
import { PromptComposer } from "./mock-layout/prompt-composer";
import { RightSidebar } from "./mock-layout/right-sidebar";
import { Sidebar } from "./mock-layout/sidebar";
import { SessionStrip } from "./mock-layout/session-strip";
import { TerminalPane } from "./mock-layout/terminal-pane";
import { TranscriptHeader } from "./mock-layout/transcript-header";
import { PROMPT_TEXTAREA_MAX_HEIGHT, PROMPT_TEXTAREA_MIN_HEIGHT, SPanel, ScrollBody, Shell, SpinnerDot } from "./mock-layout/ui";
import { DevPanel, useDevPanel } from "./dev-panel";
import {
  buildDisplayMessages,
  diffPath,
  diffTabId,
  formatThinkingDuration,
  isDiffTab,
  buildHistoryEvents,
  type Task,
  type HistoryEvent,
  type LineAttachment,
  type Message,
  type ModelId,
} from "./mock-layout/view-model";
import { activeMockOrganization, activeMockUser, getMockOrganizationById, useMockAppClient, useMockAppSnapshot } from "../lib/mock-app";
import { backendClient } from "../lib/backend";
import { subscriptionManager } from "../lib/subscription";
import { describeTaskState, isProvisioningTaskStatus } from "../features/tasks/status";

function firstAgentSessionId(task: Task): string | null {
  return task.sessions[0]?.id ?? null;
}

function sanitizeOpenDiffs(task: Task, paths: string[] | undefined): string[] {
  if (!paths) {
    return [];
  }

  return paths.filter((path) => task.diffs[path] != null);
}

function sanitizeLastAgentSessionId(task: Task, sessionId: string | null | undefined): string | null {
  if (sessionId && task.sessions.some((tab) => tab.id === sessionId)) {
    return sessionId;
  }

  return firstAgentSessionId(task);
}

function sanitizeActiveSessionId(task: Task, sessionId: string | null | undefined, openDiffs: string[], lastAgentSessionId: string | null): string | null {
  if (sessionId) {
    if (task.sessions.some((tab) => tab.id === sessionId)) {
      return sessionId;
    }
    if (isDiffTab(sessionId) && openDiffs.includes(diffPath(sessionId))) {
      return sessionId;
    }
  }

  return openDiffs.length > 0 ? diffTabId(openDiffs[openDiffs.length - 1]!) : lastAgentSessionId;
}

type GithubStatusView = Pick<
  FoundryOrganization["github"],
  "connectedAccount" | "installationStatus" | "syncStatus" | "importedRepoCount" | "lastSyncLabel"
> & {
  syncPhase?: string | null;
  processedRepositoryCount?: number;
  totalRepositoryCount?: number;
};

function githubInstallationWarningTitle(github: GithubStatusView): string {
  return github.installationStatus === "install_required" ? "GitHub App not installed" : "GitHub App needs reconnection";
}

function githubInstallationWarningDetail(github: GithubStatusView): string {
  const statusDetail = github.lastSyncLabel.trim();
  const requirementDetail =
    github.installationStatus === "install_required"
      ? "Webhooks are required for Foundry to function. Repo sync and PR updates will not work until the GitHub App is installed for this organization."
      : "Webhook delivery is unavailable. Repo sync and PR updates will not work until the GitHub App is reconnected.";
  return statusDetail ? `${requirementDetail} ${statusDetail}.` : requirementDetail;
}

function GithubInstallationWarning({
  github,
  css,
  t,
}: {
  github: GithubStatusView;
  css: ReturnType<typeof useStyletron>[0];
  t: ReturnType<typeof useFoundryTokens>;
}) {
  if (github.installationStatus === "connected") {
    return null;
  }

  return (
    <div
      className={css({
        position: "fixed",
        bottom: "8px",
        left: "8px",
        zIndex: 99998,
        display: "flex",
        alignItems: "flex-start",
        gap: "8px",
        padding: "10px 12px",
        backgroundColor: t.surfaceElevated,
        border: `1px solid ${t.statusError}`,
        borderRadius: "6px",
        boxShadow: t.shadow,
        maxWidth: "440px",
      })}
    >
      <CircleAlert size={15} color={t.statusError} />
      <div className={css({ display: "flex", flexDirection: "column", gap: "3px" })}>
        <div className={css({ fontSize: "11px", fontWeight: 600, color: t.textPrimary })}>{githubInstallationWarningTitle(github)}</div>
        <div className={css({ fontSize: "11px", lineHeight: 1.45, color: t.textMuted })}>{githubInstallationWarningDetail(github)}</div>
      </div>
    </div>
  );
}

function toSessionModel(
  summary: WorkspaceSessionSummary,
  sessionDetail?: { draft: Task["sessions"][number]["draft"]; transcript: Task["sessions"][number]["transcript"] },
): Task["sessions"][number] {
  return {
    id: summary.id,
    sessionId: summary.sessionId,
    sessionName: summary.sessionName,
    agent: summary.agent,
    model: summary.model,
    status: summary.status,
    thinkingSinceMs: summary.thinkingSinceMs,
    unread: summary.unread,
    created: summary.created,
    errorMessage: summary.errorMessage ?? null,
    draft: sessionDetail?.draft ?? {
      text: "",
      attachments: [],
      updatedAtMs: null,
    },
    transcript: sessionDetail?.transcript ?? [],
  };
}

function toTaskModel(
  summary: WorkspaceTaskSummary,
  detail?: WorkspaceTaskDetail,
  sessionCache?: Map<string, { draft: Task["sessions"][number]["draft"]; transcript: Task["sessions"][number]["transcript"] }>,
): Task {
  const sessions = detail?.sessionsSummary ?? summary.sessionsSummary;
  return {
    id: summary.id,
    repoId: summary.repoId,
    title: detail?.title ?? summary.title,
    status: detail?.status ?? summary.status,
    repoName: detail?.repoName ?? summary.repoName,
    updatedAtMs: detail?.updatedAtMs ?? summary.updatedAtMs,
    branch: detail?.branch ?? summary.branch,
    pullRequest: detail?.pullRequest ?? summary.pullRequest,
    activeSessionId: detail?.activeSessionId ?? summary.activeSessionId ?? null,
    sessions: sessions.map((session) => toSessionModel(session, sessionCache?.get(session.id))),
    fileChanges: detail?.fileChanges ?? [],
    diffs: detail?.diffs ?? {},
    fileTree: detail?.fileTree ?? [],
    minutesUsed: detail?.minutesUsed ?? 0,
    sandboxes: detail?.sandboxes ?? [],
    activeSandboxId: detail?.activeSandboxId ?? null,
    primaryUserLogin: detail?.primaryUserLogin ?? summary.primaryUserLogin ?? null,
    primaryUserAvatarUrl: detail?.primaryUserAvatarUrl ?? summary.primaryUserAvatarUrl ?? null,
  };
}

function sessionStateMessage(tab: Task["sessions"][number] | null | undefined): string | null {
  if (!tab) {
    return null;
  }
  if (tab.status === "pending_provision") {
    return "Provisioning sandbox...";
  }
  if (tab.status === "pending_session_create") {
    return "Creating session...";
  }
  if (tab.status === "error") {
    return tab.errorMessage ?? "Session failed to start.";
  }
  return null;
}

function groupRepositories(
  repos: Array<{ id: string; label: string }>,
  tasks: Task[],
  openPullRequests?: Array<{
    repoId: string;
    repoFullName: string;
    number: number;
    title: string;
    state: string;
    url: string;
    headRefName: string;
    authorLogin: string | null;
    isDraft: boolean;
  }>,
) {
  return repos
    .map((repo) => ({
      id: repo.id,
      label: repo.label,
      updatedAtMs: tasks.filter((task) => task.repoId === repo.id).reduce((latest, task) => Math.max(latest, task.updatedAtMs), 0),
      tasks: tasks.filter((task) => task.repoId === repo.id).sort((left, right) => right.updatedAtMs - left.updatedAtMs),
      pullRequests: (openPullRequests ?? []).filter((pr) => pr.repoId === repo.id),
    }))
    .sort((a, b) => {
      // Repos with tasks first, then repos with PRs, then alphabetical
      const aHasActivity = a.tasks.length > 0 || a.pullRequests.length > 0;
      const bHasActivity = b.tasks.length > 0 || b.pullRequests.length > 0;
      if (aHasActivity && !bHasActivity) return -1;
      if (!aHasActivity && bHasActivity) return 1;
      if (a.updatedAtMs !== b.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
      return a.label.localeCompare(b.label);
    });
}

interface WorkspaceActions {
  createTask(input: {
    repoId: string;
    task: string;
    title?: string;
    branch?: string;
    onBranch?: string;
    model?: ModelId;
  }): Promise<{ taskId: string; sessionId?: string }>;
  markTaskUnread(input: { repoId: string; taskId: string }): Promise<void>;
  renameTask(input: { repoId: string; taskId: string; value: string }): Promise<void>;
  archiveTask(input: { repoId: string; taskId: string }): Promise<void>;
  publishPr(input: { repoId: string; taskId: string }): Promise<void>;
  revertFile(input: { repoId: string; taskId: string; path: string }): Promise<void>;
  updateDraft(input: { repoId: string; taskId: string; sessionId: string; text: string; attachments: LineAttachment[] }): Promise<void>;
  sendMessage(input: { repoId: string; taskId: string; sessionId: string; text: string; attachments: LineAttachment[] }): Promise<void>;
  stopAgent(input: { repoId: string; taskId: string; sessionId: string }): Promise<void>;
  selectSession(input: { repoId: string; taskId: string; sessionId: string }): Promise<void>;
  setSessionUnread(input: { repoId: string; taskId: string; sessionId: string; unread: boolean }): Promise<void>;
  renameSession(input: { repoId: string; taskId: string; sessionId: string; title: string }): Promise<void>;
  closeSession(input: { repoId: string; taskId: string; sessionId: string }): Promise<void>;
  addSession(input: { repoId: string; taskId: string; model?: string }): Promise<{ sessionId: string }>;
  changeModel(input: { repoId: string; taskId: string; sessionId: string; model: ModelId }): Promise<void>;
  changeOwner(input: { repoId: string; taskId: string; targetUserId: string; targetUserName: string; targetUserEmail: string }): Promise<void>;
  adminReloadGithubOrganization(): Promise<void>;
  adminReloadGithubRepository(repoId: string): Promise<void>;
}

const TranscriptPanel = memo(function TranscriptPanel({
  taskWorkspaceClient,
  task,
  hasSandbox,
  activeSessionId,
  lastAgentSessionId,
  openDiffs,
  onSyncRouteSession,
  onSetActiveSessionId,
  onSetLastAgentSessionId,
  onSetOpenDiffs,
  sidebarCollapsed,
  onToggleSidebar,
  onSidebarPeekStart,
  onSidebarPeekEnd,
  rightSidebarCollapsed,
  onToggleRightSidebar,
  selectedSessionHydrating = false,
  modelGroups,
  onNavigateToUsage,
}: {
  taskWorkspaceClient: WorkspaceActions;
  task: Task;
  hasSandbox: boolean;
  activeSessionId: string | null;
  lastAgentSessionId: string | null;
  openDiffs: string[];
  onSyncRouteSession: (taskId: string, sessionId: string | null, replace?: boolean) => void;
  onSetActiveSessionId: (sessionId: string | null) => void;
  onSetLastAgentSessionId: (sessionId: string | null) => void;
  onSetOpenDiffs: (paths: string[]) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onSidebarPeekStart?: () => void;
  onSidebarPeekEnd?: () => void;
  rightSidebarCollapsed?: boolean;
  onToggleRightSidebar?: () => void;
  selectedSessionHydrating?: boolean;
  modelGroups: WorkspaceModelGroup[];
  onNavigateToUsage?: () => void;
}) {
  const t = useFoundryTokens();
  const appSnapshot = useMockAppSnapshot();
  const appClient = useMockAppClient();
  const currentUser = activeMockUser(appSnapshot);
  const defaultModel = currentUser?.defaultModel ?? DEFAULT_WORKSPACE_MODEL_ID;
  const [editingField, setEditingField] = useState<"title" | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState("");
  const [pendingHistoryTarget, setPendingHistoryTarget] = useState<{ messageId: string; sessionId: string } | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [timerNowMs, setTimerNowMs] = useState(() => Date.now());
  const [localDraft, setLocalDraft] = useState("");
  const [localAttachments, setLocalAttachments] = useState<LineAttachment[]>([]);
  const [pendingMessage, setPendingMessage] = useState<{ text: string; sessionId: string; sentAt: number } | null>(null);
  const lastEditTimeRef = useRef(0);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraftRef = useRef<{ text: string; attachments: LineAttachment[] } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const activeDiff = activeSessionId && isDiffTab(activeSessionId) ? diffPath(activeSessionId) : null;
  const activeAgentSession = activeDiff ? null : (task.sessions.find((candidate) => candidate.id === activeSessionId) ?? task.sessions[0] ?? null);
  const promptSession = task.sessions.find((candidate) => candidate.id === lastAgentSessionId) ?? task.sessions[0] ?? null;
  const isTerminal = task.status === "archived";
  const historyEvents = useMemo(() => buildHistoryEvents(task.sessions), [task.sessions]);
  const activeMessages = useMemo(() => buildDisplayMessages(activeAgentSession), [activeAgentSession]);
  const taskState = describeTaskState(task.status);
  const taskProvisioning = isProvisioningTaskStatus(task.status);
  const taskProvisioningMessage = taskState.detail;
  const activeSessionMessage = sessionStateMessage(activeAgentSession);
  const showPendingSessionState =
    !activeDiff &&
    !!activeAgentSession &&
    (activeAgentSession.status === "pending_provision" || activeAgentSession.status === "pending_session_create" || activeAgentSession.status === "error") &&
    activeMessages.length === 0;
  const serverDraft = promptSession?.draft.text ?? "";
  const serverAttachments = promptSession?.draft.attachments;
  const serverAttachmentsJson = JSON.stringify(serverAttachments ?? []);

  // Sync server → local only when user hasn't typed recently (3s cooldown)
  const DRAFT_SYNC_COOLDOWN_MS = 3_000;
  useEffect(() => {
    if (Date.now() - lastEditTimeRef.current > DRAFT_SYNC_COOLDOWN_MS) {
      setLocalDraft(serverDraft);
      setLocalAttachments(serverAttachments ?? []);
    }
  }, [serverDraft, serverAttachmentsJson]);

  // Reset local draft immediately on session/task switch
  useEffect(() => {
    lastEditTimeRef.current = 0;
    setLocalDraft(promptSession?.draft.text ?? "");
    setLocalAttachments(promptSession?.draft.attachments ?? []);
  }, [promptSession?.id, task.id]);

  // Clear pending message once the real transcript contains a client message newer than when we sent
  const pendingMessageClientCount = useRef(0);
  useEffect(() => {
    if (!pendingMessage) return;

    const targetSession = task.sessions.find((s) => s.id === pendingMessage.sessionId);
    if (!targetSession) return;

    const clientEventCount = targetSession.transcript.filter((event) => event.sender === "client").length;
    if (clientEventCount > pendingMessageClientCount.current) {
      setPendingMessage(null);
    }
  }, [task.sessions, pendingMessage]);

  const draft = localDraft;
  const attachments = localAttachments;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeMessages.length]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [activeSessionId, task.id]);

  useEffect(() => {
    setEditingSessionId(null);
    setEditingSessionName("");
  }, [task.id]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = `${PROMPT_TEXTAREA_MIN_HEIGHT}px`;
    const nextHeight = Math.min(textarea.scrollHeight, PROMPT_TEXTAREA_MAX_HEIGHT);
    textarea.style.height = `${Math.max(PROMPT_TEXTAREA_MIN_HEIGHT, nextHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > PROMPT_TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
  }, [draft, activeSessionId, task.id]);

  useEffect(() => {
    if (!copiedMessageId) {
      return;
    }

    const timer = setTimeout(() => {
      setCopiedMessageId(null);
    }, 1_200);

    return () => clearTimeout(timer);
  }, [copiedMessageId]);

  useEffect(() => {
    if (!activeAgentSession || activeAgentSession.status !== "running" || activeAgentSession.thinkingSinceMs === null) {
      return;
    }

    setTimerNowMs(Date.now());
    const timer = window.setInterval(() => {
      setTimerNowMs(Date.now());
    }, 1_000);

    return () => window.clearInterval(timer);
  }, [activeAgentSession?.id, activeAgentSession?.status, activeAgentSession?.thinkingSinceMs]);

  useEffect(() => {
    if (!activeAgentSession?.unread) {
      return;
    }

    void taskWorkspaceClient.setSessionUnread({
      repoId: task.repoId,
      taskId: task.id,
      sessionId: activeAgentSession.id,
      unread: false,
    });
  }, [activeAgentSession?.id, activeAgentSession?.unread, task.id]);

  const startEditingField = useCallback((field: "title", value: string) => {
    setEditingField(field);
    setEditValue(value);
  }, []);

  const cancelEditingField = useCallback(() => {
    setEditingField(null);
  }, []);

  const commitEditingField = useCallback(
    (field: "title") => {
      const value = editValue.trim();
      if (!value) {
        setEditingField(null);
        return;
      }

      void taskWorkspaceClient.renameTask({ repoId: task.repoId, taskId: task.id, value });
      setEditingField(null);
    },
    [editValue, task.id],
  );

  const DRAFT_THROTTLE_MS = 500;

  const flushDraft = useCallback(
    (text: string, nextAttachments: LineAttachment[], sessionId: string) => {
      void taskWorkspaceClient.updateDraft({
        repoId: task.repoId,
        taskId: task.id,
        sessionId,
        text,
        attachments: nextAttachments,
      });
    },
    [task.id],
  );

  // Clean up throttle timer on unmount
  useEffect(() => {
    return () => {
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
      }
    };
  }, []);

  const updateDraft = useCallback(
    (nextText: string, nextAttachments: LineAttachment[]) => {
      if (!promptSession) {
        return;
      }

      // Update local state immediately for responsive typing
      lastEditTimeRef.current = Date.now();
      setLocalDraft(nextText);
      setLocalAttachments(nextAttachments);

      // Throttle the network call
      pendingDraftRef.current = { text: nextText, attachments: nextAttachments };
      if (!throttleTimerRef.current) {
        throttleTimerRef.current = setTimeout(() => {
          throttleTimerRef.current = null;
          if (pendingDraftRef.current) {
            flushDraft(pendingDraftRef.current.text, pendingDraftRef.current.attachments, promptSession.id);
            pendingDraftRef.current = null;
          }
        }, DRAFT_THROTTLE_MS);
      }
    },
    [promptSession, flushDraft],
  );

  const sendMessage = useCallback(() => {
    const text = draft.trim();
    if (!text || !promptSession) {
      return;
    }

    // Clear draft and show optimistic message immediately (don't wait for server round-trip)
    setLocalDraft("");
    setLocalAttachments([]);
    lastEditTimeRef.current = Date.now();
    // Snapshot current client message count so we can detect when the server adds ours
    pendingMessageClientCount.current = promptSession.transcript.filter((event) => event.sender === "client").length;
    setPendingMessage({ text, sessionId: promptSession.id, sentAt: Date.now() });

    onSetActiveSessionId(promptSession.id);
    onSetLastAgentSessionId(promptSession.id);
    void taskWorkspaceClient.sendMessage({
      repoId: task.repoId,
      taskId: task.id,
      sessionId: promptSession.id,
      text,
      attachments,
    });
  }, [attachments, draft, task.id, onSetActiveSessionId, onSetLastAgentSessionId, promptSession]);

  const stopAgent = useCallback(() => {
    if (!promptSession) {
      return;
    }

    void taskWorkspaceClient.stopAgent({
      repoId: task.repoId,
      taskId: task.id,
      sessionId: promptSession.id,
    });
  }, [task.id, promptSession]);

  const switchSession = useCallback(
    (sessionId: string) => {
      onSetActiveSessionId(sessionId);

      if (!isDiffTab(sessionId)) {
        onSetLastAgentSessionId(sessionId);
        void taskWorkspaceClient.selectSession({
          repoId: task.repoId,
          taskId: task.id,
          sessionId,
        });
        const session = task.sessions.find((candidate) => candidate.id === sessionId);
        if (session?.unread) {
          void taskWorkspaceClient.setSessionUnread({
            repoId: task.repoId,
            taskId: task.id,
            sessionId,
            unread: false,
          });
        }
        onSyncRouteSession(task.id, sessionId);
      }
    },
    [task.id, task.repoId, task.sessions, onSetActiveSessionId, onSetLastAgentSessionId, onSyncRouteSession],
  );

  const setSessionUnread = useCallback(
    (sessionId: string, unread: boolean) => {
      void taskWorkspaceClient.setSessionUnread({ repoId: task.repoId, taskId: task.id, sessionId, unread });
    },
    [task.id, task.repoId],
  );

  const startRenamingSession = useCallback(
    (sessionId: string) => {
      const targetSession = task.sessions.find((candidate) => candidate.id === sessionId);
      if (!targetSession) {
        throw new Error(`Unable to rename missing session ${sessionId}`);
      }

      setEditingSessionId(sessionId);
      setEditingSessionName(targetSession.sessionName);
    },
    [task.sessions],
  );

  const cancelSessionRename = useCallback(() => {
    setEditingSessionId(null);
    setEditingSessionName("");
  }, []);

  const commitSessionRename = useCallback(() => {
    if (!editingSessionId) {
      return;
    }

    const trimmedName = editingSessionName.trim();
    if (!trimmedName) {
      cancelSessionRename();
      return;
    }

    void taskWorkspaceClient.renameSession({
      repoId: task.repoId,
      taskId: task.id,
      sessionId: editingSessionId,
      title: trimmedName,
    });
    cancelSessionRename();
  }, [cancelSessionRename, editingSessionName, editingSessionId, task.id]);

  const closeSession = useCallback(
    (sessionId: string) => {
      const remainingSessions = task.sessions.filter((candidate) => candidate.id !== sessionId);
      const nextSessionId = remainingSessions[0]?.id ?? null;

      if (activeSessionId === sessionId) {
        onSetActiveSessionId(nextSessionId);
      }
      if (lastAgentSessionId === sessionId) {
        onSetLastAgentSessionId(nextSessionId);
      }

      onSyncRouteSession(task.id, nextSessionId);
      void taskWorkspaceClient.closeSession({ repoId: task.repoId, taskId: task.id, sessionId });
    },
    [activeSessionId, task.id, task.repoId, task.sessions, lastAgentSessionId, onSetActiveSessionId, onSetLastAgentSessionId, onSyncRouteSession],
  );

  const closeDiffTab = useCallback(
    (path: string) => {
      const nextOpenDiffs = openDiffs.filter((candidate) => candidate !== path);
      onSetOpenDiffs(nextOpenDiffs);
      if (activeSessionId === diffTabId(path)) {
        onSetActiveSessionId(
          nextOpenDiffs.length > 0 ? diffTabId(nextOpenDiffs[nextOpenDiffs.length - 1]!) : (lastAgentSessionId ?? firstAgentSessionId(task)),
        );
      }
    },
    [activeSessionId, task, lastAgentSessionId, onSetActiveSessionId, onSetOpenDiffs, openDiffs],
  );

  const addSession = useCallback(() => {
    void (async () => {
      const { sessionId } = await taskWorkspaceClient.addSession({ repoId: task.repoId, taskId: task.id });
      onSetLastAgentSessionId(sessionId);
      onSetActiveSessionId(sessionId);
      onSyncRouteSession(task.id, sessionId);
    })();
  }, [task.id, task.repoId, onSetActiveSessionId, onSetLastAgentSessionId, onSyncRouteSession]);

  const changeModel = useCallback(
    (model: ModelId) => {
      if (!promptSession) {
        throw new Error(`Unable to change model for task ${task.id} without an active prompt session`);
      }

      void taskWorkspaceClient.changeModel({
        repoId: task.repoId,
        taskId: task.id,
        sessionId: promptSession.id,
        model,
      });
    },
    [task.id, promptSession],
  );

  const addAttachment = useCallback(
    (filePath: string, lineNumber: number, lineContent: string) => {
      if (!promptSession) {
        return;
      }

      const nextAttachment = { id: `${filePath}:${lineNumber}`, filePath, lineNumber, lineContent };
      if (attachments.some((attachment) => attachment.filePath === filePath && attachment.lineNumber === lineNumber)) {
        return;
      }

      updateDraft(draft, [...attachments, nextAttachment]);
    },
    [attachments, draft, promptSession, updateDraft],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      updateDraft(
        draft,
        attachments.filter((attachment) => attachment.id !== id),
      );
    },
    [attachments, draft, updateDraft],
  );

  const jumpToHistoryEvent = useCallback(
    (event: HistoryEvent) => {
      setPendingHistoryTarget({ messageId: event.messageId, sessionId: event.sessionId });

      if (activeSessionId !== event.sessionId) {
        switchSession(event.sessionId);
      }
    },
    [activeSessionId, switchSession],
  );

  const copyMessage = useCallback(async (message: Message) => {
    try {
      if (!window.navigator.clipboard) {
        throw new Error("Clipboard API unavailable in mock layout");
      }

      await window.navigator.clipboard.writeText(message.text);
      setCopiedMessageId(message.id);
    } catch (error) {
      logger.error(
        {
          messageId: message.id,
          ...createErrorContext(error),
        },
        "failed_to_copy_transcript_message",
      );
    }
  }, []);

  const isOptimisticThinking = pendingMessage !== null && activeAgentSession?.id === pendingMessage.sessionId;
  const thinkingTimerLabel =
    activeAgentSession?.status === "running" && activeAgentSession.thinkingSinceMs !== null
      ? formatThinkingDuration(timerNowMs - activeAgentSession.thinkingSinceMs)
      : isOptimisticThinking
        ? formatThinkingDuration(timerNowMs - pendingMessage.sentAt)
        : null;

  return (
    <SPanel>
      <TranscriptHeader
        task={task}
        hasSandbox={hasSandbox}
        activeSession={activeAgentSession}
        editingField={editingField}
        editValue={editValue}
        onEditValueChange={setEditValue}
        onStartEditingField={startEditingField}
        onCommitEditingField={commitEditingField}
        onCancelEditingField={cancelEditingField}
        onSetActiveSessionUnread={(unread) => {
          if (activeAgentSession) {
            setSessionUnread(activeAgentSession.id, unread);
          }
        }}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={onToggleSidebar}
        onSidebarPeekStart={onSidebarPeekStart}
        onSidebarPeekEnd={onSidebarPeekEnd}
        rightSidebarCollapsed={rightSidebarCollapsed}
        onToggleRightSidebar={onToggleRightSidebar}
        onNavigateToUsage={onNavigateToUsage}
      />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          backgroundColor: t.surfacePrimary,
          overflow: "hidden",
          borderTopLeftRadius: "12px",
          borderTopRightRadius: rightSidebarCollapsed ? "12px" : 0,
          borderBottomLeftRadius: "24px",
          borderBottomRightRadius: rightSidebarCollapsed ? "24px" : 0,
          border: `1px solid ${t.borderDefault}`,
        }}
      >
        <SessionStrip
          task={task}
          activeSessionId={activeSessionId}
          openDiffs={openDiffs}
          editingSessionId={editingSessionId}
          editingSessionName={editingSessionName}
          onEditingSessionNameChange={setEditingSessionName}
          onSwitchSession={switchSession}
          onStartRenamingSession={startRenamingSession}
          onCommitSessionRename={commitSessionRename}
          onCancelSessionRename={cancelSessionRename}
          onSetSessionUnread={setSessionUnread}
          onCloseSession={closeSession}
          onCloseDiffTab={closeDiffTab}
          onAddSession={addSession}
          sidebarCollapsed={sidebarCollapsed}
        />
        {activeDiff ? (
          <DiffContent
            filePath={activeDiff}
            file={task.fileChanges.find((file) => file.path === activeDiff)}
            diff={task.diffs[activeDiff]}
            onAddAttachment={addAttachment}
          />
        ) : task.sessions.length === 0 ? (
          <ScrollBody>
            <div
              style={{
                minHeight: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "32px",
              }}
            >
              <div
                style={{
                  maxWidth: "420px",
                  textAlign: "center",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                  alignItems: "center",
                }}
              >
                {taskProvisioning ? (
                  <>
                    <SpinnerDot size={16} />
                    <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>{taskState.title}</h2>
                    <p style={{ margin: 0, opacity: 0.75 }}>{taskProvisioningMessage}</p>
                  </>
                ) : (
                  <>
                    <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>Create the first session</h2>
                    <p style={{ margin: 0, opacity: 0.75 }}>Sessions are where you chat with the agent. Start one now to send the first prompt on this task.</p>
                    <button
                      type="button"
                      onClick={addSession}
                      style={{
                        alignSelf: "center",
                        border: 0,
                        borderRadius: "999px",
                        padding: "10px 18px",
                        background: t.borderMedium,
                        color: t.textPrimary,
                        cursor: "pointer",
                        fontWeight: 600,
                      }}
                    >
                      New session
                    </button>
                  </>
                )}
              </div>
            </div>
          </ScrollBody>
        ) : selectedSessionHydrating ? (
          <ScrollBody>
            <div
              style={{
                minHeight: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "32px",
              }}
            >
              <div
                style={{
                  maxWidth: "420px",
                  textAlign: "center",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                  alignItems: "center",
                }}
              >
                <SpinnerDot size={16} />
                <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>Loading session</h2>
                <p style={{ margin: 0, opacity: 0.75 }}>Fetching the latest transcript for this session.</p>
              </div>
            </div>
          </ScrollBody>
        ) : showPendingSessionState ? (
          <ScrollBody>
            <div
              style={{
                minHeight: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "32px",
              }}
            >
              <div
                style={{
                  maxWidth: "420px",
                  textAlign: "center",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                  alignItems: "center",
                }}
              >
                {activeAgentSession?.status === "error" ? null : <SpinnerDot size={16} />}
                <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>
                  {activeAgentSession?.status === "pending_provision"
                    ? "Provisioning sandbox"
                    : activeAgentSession?.status === "pending_session_create"
                      ? "Creating session"
                      : "Session unavailable"}
                </h2>
                <p style={{ margin: 0, opacity: 0.75 }}>{activeSessionMessage}</p>
                {activeAgentSession?.status === "error" ? (
                  <button
                    type="button"
                    onClick={addSession}
                    style={{
                      alignSelf: "center",
                      border: 0,
                      borderRadius: "999px",
                      padding: "10px 18px",
                      background: t.borderMedium,
                      color: t.textPrimary,
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    Retry session
                  </button>
                ) : null}
              </div>
            </div>
          </ScrollBody>
        ) : (
          <ScrollBody>
            <MessageList
              session={activeAgentSession}
              scrollRef={scrollRef}
              messageRefs={messageRefs}
              historyEvents={historyEvents}
              onSelectHistoryEvent={jumpToHistoryEvent}
              targetMessageId={pendingHistoryTarget && activeAgentSession?.id === pendingHistoryTarget.sessionId ? pendingHistoryTarget.messageId : null}
              onTargetMessageResolved={() => setPendingHistoryTarget(null)}
              copiedMessageId={copiedMessageId}
              onCopyMessage={(message) => {
                void copyMessage(message);
              }}
              thinkingTimerLabel={thinkingTimerLabel}
              pendingMessage={
                pendingMessage && activeAgentSession?.id === pendingMessage.sessionId ? { text: pendingMessage.text, sentAt: pendingMessage.sentAt } : null
              }
            />
          </ScrollBody>
        )}
        {!isTerminal && promptSession && (promptSession.status === "ready" || promptSession.status === "running" || promptSession.status === "idle") ? (
          <PromptComposer
            draft={draft}
            textareaRef={textareaRef}
            placeholder={!promptSession.created ? "Describe your task..." : "Send a message..."}
            attachments={attachments}
            modelGroups={modelGroups}
            defaultModel={defaultModel}
            model={promptSession.model}
            isRunning={promptSession.status === "running"}
            onDraftChange={(value) => updateDraft(value, attachments)}
            onSend={sendMessage}
            onStop={stopAgent}
            onRemoveAttachment={removeAttachment}
            onChangeModel={changeModel}
            onSetDefaultModel={(model) => {
              void appClient.setDefaultModel(model);
            }}
          />
        ) : null}
      </div>
    </SPanel>
  );
});

const LEFT_SIDEBAR_DEFAULT_WIDTH = 340;
const RIGHT_SIDEBAR_DEFAULT_WIDTH = 380;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 600;
const RESIZE_HANDLE_WIDTH = 1;
const LEFT_WIDTH_STORAGE_KEY = "foundry:left-sidebar-width";
const RIGHT_WIDTH_STORAGE_KEY = "foundry:right-sidebar-width";

function readStoredWidth(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const stored = window.localStorage.getItem(key);
  const parsed = stored ? Number.parseInt(stored, 10) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH) : fallback;
}

const PanelResizeHandle = memo(function PanelResizeHandle({ onResizeStart, onResize }: { onResizeStart: () => void; onResize: (deltaX: number) => void }) {
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      onResizeStart();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        onResize(moveEvent.clientX - startX);
      };

      const stopResize = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize, { once: true });
    },
    [onResize, onResizeStart],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={handlePointerDown}
      style={{
        width: `${RESIZE_HANDLE_WIDTH}px`,
        flexShrink: 0,
        cursor: "col-resize",
        backgroundColor: "transparent",
        position: "relative",
        zIndex: 1,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: "-3px",
          right: "-3px",
        }}
      />
    </div>
  );
});

const RIGHT_RAIL_MIN_SECTION_HEIGHT = 180;
const RIGHT_RAIL_SPLITTER_HEIGHT = 10;
const DEFAULT_TERMINAL_HEIGHT = 320;
const TERMINAL_HEIGHT_STORAGE_KEY = "foundry:terminal-height";

const RightRail = memo(function RightRail({
  organizationId,
  task,
  activeSessionId,
  onOpenDiff,
  onArchive,
  onRevertFile,
  onPublishPr,
  onChangeOwner,
  members,
  onToggleSidebar,
}: {
  organizationId: string;
  task: Task;
  activeSessionId: string | null;
  onOpenDiff: (path: string) => void;
  onArchive: () => void;
  onRevertFile: (path: string) => void;
  onPublishPr: () => void;
  onChangeOwner: (member: { id: string; name: string; email: string }) => void;
  members: Array<{ id: string; name: string; email: string }>;
  onToggleSidebar?: () => void;
}) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const railRef = useRef<HTMLDivElement>(null);
  const [terminalHeight, setTerminalHeight] = useState(() => {
    if (typeof window === "undefined") {
      return DEFAULT_TERMINAL_HEIGHT;
    }

    const stored = window.localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : DEFAULT_TERMINAL_HEIGHT;
  });

  const clampTerminalHeight = useCallback((nextHeight: number) => {
    const railHeight = railRef.current?.getBoundingClientRect().height ?? 0;
    const maxHeight = Math.max(RIGHT_RAIL_MIN_SECTION_HEIGHT, railHeight - RIGHT_RAIL_MIN_SECTION_HEIGHT - RIGHT_RAIL_SPLITTER_HEIGHT);

    return Math.min(Math.max(nextHeight, 43), maxHeight);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(terminalHeight));
  }, [terminalHeight]);

  useEffect(() => {
    const handleResize = () => {
      setTerminalHeight((current) => clampTerminalHeight(current));
    };

    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, [clampTerminalHeight]);

  const startResize = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault();

      const startY = event.clientY;
      const startHeight = terminalHeight;
      document.body.style.cursor = "ns-resize";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const deltaY = moveEvent.clientY - startY;
        setTerminalHeight(clampTerminalHeight(startHeight - deltaY));
      };

      const stopResize = () => {
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize, { once: true });
    },
    [clampTerminalHeight, terminalHeight],
  );

  return (
    <div
      ref={railRef}
      className={css({
        minHeight: 0,
        flex: 1,
        display: "flex",
        flexDirection: "column",
        backgroundColor: t.surfacePrimary,
      })}
    >
      <div
        className={css({
          minHeight: `${RIGHT_RAIL_MIN_SECTION_HEIGHT}px`,
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        })}
      >
        <RightSidebar
          task={task}
          activeSessionId={activeSessionId}
          onOpenDiff={onOpenDiff}
          onArchive={onArchive}
          onRevertFile={onRevertFile}
          onPublishPr={onPublishPr}
          onChangeOwner={onChangeOwner}
          members={members}
          onToggleSidebar={onToggleSidebar}
        />
      </div>
      <div
        className={css({
          height: `${terminalHeight}px`,
          minHeight: "43px",
          backgroundColor: t.surfacePrimary,
          overflow: "hidden",
          borderBottomRightRadius: "12px",
          borderRight: `1px solid ${t.borderDefault}`,
          borderBottom: `1px solid ${t.borderDefault}`,
          display: "flex",
          flexDirection: "column",
        })}
      >
        <TerminalPane
          organizationId={organizationId}
          taskId={task.id}
          onStartResize={startResize}
          isExpanded={(() => {
            const railHeight = railRef.current?.getBoundingClientRect().height ?? 0;
            return railHeight > 0 && terminalHeight >= railHeight * 0.7;
          })()}
          onExpand={() => {
            const railHeight = railRef.current?.getBoundingClientRect().height ?? 0;
            const maxHeight = Math.max(RIGHT_RAIL_MIN_SECTION_HEIGHT, railHeight - RIGHT_RAIL_SPLITTER_HEIGHT - 42);
            setTerminalHeight(maxHeight);
          }}
          onCollapse={() => {
            setTerminalHeight(43);
          }}
        />
      </div>
    </div>
  );
});

interface MockLayoutProps {
  organizationId: string;
  selectedTaskId?: string | null;
  selectedSessionId?: string | null;
}

function MockOrganizationOrgBar() {
  const navigate = useNavigate();
  const snapshot = useMockAppSnapshot();
  const organization = activeMockOrganization(snapshot);
  const t = useFoundryTokens();

  if (!organization) {
    return null;
  }

  const buttonStyle = {
    border: `1px solid ${t.borderMedium}`,
    borderRadius: "999px",
    padding: "8px 12px",
    background: t.interactiveSubtle,
    color: t.textPrimary,
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 600,
  } satisfies React.CSSProperties;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
        padding: "12px 20px",
        borderBottom: `1px solid ${t.borderSubtle}`,
        background: t.surfaceSecondary,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <strong style={{ fontSize: "14px", fontWeight: 600 }}>{organization.settings.displayName}</strong>
        <span style={{ fontSize: "12px", color: t.textMuted }}>{organization.settings.primaryDomain}</span>
      </div>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            void navigate({ to: "/organizations" });
          }}
        >
          Switch org
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            void navigate({
              to: "/organizations/$organizationId/settings",
              params: { organizationId: organization.id },
            });
          }}
        >
          Settings
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            void navigate({
              to: "/organizations/$organizationId/billing",
              params: { organizationId: organization.id },
            });
          }}
        >
          Billing
        </button>
      </div>
    </div>
  );
}

export function MockLayout({ organizationId, selectedTaskId, selectedSessionId }: MockLayoutProps) {
  const [css] = useStyletron();
  const t = useFoundryTokens();
  const navigate = useNavigate();
  const taskWorkspaceClient = useMemo<WorkspaceActions>(
    () => ({
      createTask: (input) => backendClient.createWorkspaceTask(organizationId, input),
      markTaskUnread: (input) => backendClient.markWorkspaceUnread(organizationId, input),
      renameTask: (input) => backendClient.renameWorkspaceTask(organizationId, input),
      archiveTask: async (input) => backendClient.runAction(organizationId, input.repoId, input.taskId, "archive"),
      publishPr: (input) => backendClient.publishWorkspacePr(organizationId, input),
      revertFile: (input) => backendClient.revertWorkspaceFile(organizationId, input),
      updateDraft: (input) => backendClient.updateWorkspaceDraft(organizationId, input),
      sendMessage: (input) => backendClient.sendWorkspaceMessage(organizationId, input),
      stopAgent: (input) => backendClient.stopWorkspaceSession(organizationId, input),
      selectSession: (input) => backendClient.selectWorkspaceSession(organizationId, input),
      setSessionUnread: (input) => backendClient.setWorkspaceSessionUnread(organizationId, input),
      renameSession: (input) => backendClient.renameWorkspaceSession(organizationId, input),
      closeSession: (input) => backendClient.closeWorkspaceSession(organizationId, input),
      addSession: (input) => backendClient.createWorkspaceSession(organizationId, input),
      changeModel: (input) => backendClient.changeWorkspaceModel(organizationId, input),
      changeOwner: (input) => backendClient.changeWorkspaceTaskOwner(organizationId, input),
      adminReloadGithubOrganization: () => backendClient.adminReloadGithubOrganization(organizationId),
      adminReloadGithubRepository: (repoId) => backendClient.adminReloadGithubRepository(organizationId, repoId),
    }),
    [organizationId],
  );
  const organizationState = useSubscription(subscriptionManager, "organization", { organizationId });
  const organizationReposData = organizationState.data?.repos;
  const taskSummariesData = organizationState.data?.taskSummaries;
  const openPullRequestsData = organizationState.data?.openPullRequests;
  const organizationRepos = organizationReposData ?? [];
  const taskSummaries = taskSummariesData ?? [];
  const selectedTaskSummary = useMemo(
    () => taskSummaries.find((task) => task.id === selectedTaskId) ?? taskSummaries[0] ?? null,
    [selectedTaskId, taskSummariesData],
  );
  const taskState = useSubscription(
    subscriptionManager,
    "task",
    selectedTaskSummary
      ? {
          organizationId,
          repoId: selectedTaskSummary.repoId,
          taskId: selectedTaskSummary.id,
        }
      : null,
  );
  const sessionState = useSubscription(
    subscriptionManager,
    "session",
    selectedTaskSummary && selectedSessionId
      ? {
          organizationId,
          repoId: selectedTaskSummary.repoId,
          taskId: selectedTaskSummary.id,
          sessionId: selectedSessionId,
        }
      : null,
  );
  const activeSandbox = useMemo(() => {
    if (!taskState.data?.activeSandboxId) return null;
    return taskState.data.sandboxes?.find((s) => s.sandboxId === taskState.data!.activeSandboxId) ?? null;
  }, [taskState.data?.activeSandboxId, taskState.data?.sandboxes]);
  const sandboxState = useSubscription(
    subscriptionManager,
    "sandboxProcesses",
    activeSandbox
      ? {
          organizationId,
          sandboxProviderId: activeSandbox.sandboxProviderId,
          sandboxId: activeSandbox.sandboxId,
        }
      : null,
  );
  const hasSandbox = Boolean(activeSandbox) && sandboxState.status !== "error";
  const modelGroupsQuery = useQuery({
    queryKey: ["mock-layout", "workspace-model-groups", organizationId, activeSandbox?.sandboxProviderId ?? "", activeSandbox?.sandboxId ?? ""],
    enabled: Boolean(activeSandbox?.sandboxId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!activeSandbox) {
        throw new Error("Cannot load workspace model groups without an active sandbox.");
      }

      return await backendClient.getSandboxWorkspaceModelGroups(organizationId, activeSandbox.sandboxProviderId, activeSandbox.sandboxId);
    },
  });
  const modelGroups = modelGroupsQuery.data && modelGroupsQuery.data.length > 0 ? modelGroupsQuery.data : DEFAULT_WORKSPACE_MODEL_GROUPS;
  const tasks = useMemo(() => {
    const sessionCache = new Map<string, { draft: Task["sessions"][number]["draft"]; transcript: Task["sessions"][number]["transcript"] }>();
    if (selectedTaskSummary && taskState.data) {
      for (const session of taskState.data.sessionsSummary) {
        const cached =
          (selectedSessionId && session.id === selectedSessionId ? sessionState.data : undefined) ??
          subscriptionManager.getSnapshot("session", {
            organizationId,
            repoId: selectedTaskSummary.repoId,
            taskId: selectedTaskSummary.id,
            sessionId: session.id,
          });
        if (cached) {
          sessionCache.set(session.id, {
            draft: cached.draft,
            transcript: cached.transcript,
          });
        }
      }
    }

    const hydratedTasks = taskSummaries.map((summary) =>
      summary.id === selectedTaskSummary?.id ? toTaskModel(summary, taskState.data, sessionCache) : toTaskModel(summary),
    );
    return hydratedTasks.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  }, [selectedTaskSummary, selectedSessionId, sessionState.data, taskState.data, taskSummariesData, organizationId]);
  const openPullRequests = openPullRequestsData ?? [];
  const rawRepositories = useMemo(() => groupRepositories(organizationRepos, tasks, openPullRequests), [tasks, organizationReposData, openPullRequestsData]);
  const appSnapshot = useMockAppSnapshot();
  const currentUser = activeMockUser(appSnapshot);
  const activeOrg = activeMockOrganization(appSnapshot);
  const liveGithub = organizationState.data?.github ?? activeOrg?.github ?? null;
  const navigateToUsage = useCallback(() => {
    if (activeOrg) {
      void navigate({ to: "/organizations/$organizationId/billing" as never, params: { organizationId: activeOrg.id } as never });
    }
  }, [activeOrg, navigate]);
  const [repositoryOrder, setRepositoryOrder] = useState<string[] | null>(null);
  const repositories = useMemo(() => {
    if (!repositoryOrder) return rawRepositories;
    const byId = new Map(rawRepositories.map((p) => [p.id, p]));
    const ordered = repositoryOrder.map((id) => byId.get(id)).filter(Boolean) as typeof rawRepositories;
    for (const p of rawRepositories) {
      if (!repositoryOrder.includes(p.id)) ordered.push(p);
    }
    return ordered;
  }, [rawRepositories, repositoryOrder]);
  const [activeSessionIdByTask, setActiveSessionIdByTask] = useState<Record<string, string | null>>({});
  const [lastAgentSessionIdByTask, setLastAgentSessionIdByTask] = useState<Record<string, string | null>>({});
  const [openDiffsByTask, setOpenDiffsByTask] = useState<Record<string, string[]>>({});
  const [selectedNewTaskRepoId, setSelectedNewTaskRepoId] = useState("");
  const [leftWidth, setLeftWidth] = useState(() => readStoredWidth(LEFT_WIDTH_STORAGE_KEY, LEFT_SIDEBAR_DEFAULT_WIDTH));
  const [rightWidth, setRightWidth] = useState(() => readStoredWidth(RIGHT_WIDTH_STORAGE_KEY, RIGHT_SIDEBAR_DEFAULT_WIDTH));
  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);
  const autoCreatingSessionForTaskRef = useRef<Set<string>>(new Set());
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [leftSidebarPeeking, setLeftSidebarPeeking] = useState(false);
  const showDevPanel = useDevPanel();
  const peekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startPeek = useCallback(() => {
    if (peekTimeoutRef.current) clearTimeout(peekTimeoutRef.current);
    setLeftSidebarPeeking(true);
  }, []);

  const endPeek = useCallback(() => {
    peekTimeoutRef.current = setTimeout(() => setLeftSidebarPeeking(false), 200);
  }, []);

  const reorderRepositories = useCallback(
    (fromIndex: number, toIndex: number) => {
      const ids = repositories.map((p) => p.id);
      const [moved] = ids.splice(fromIndex, 1);
      ids.splice(toIndex, 0, moved!);
      setRepositoryOrder(ids);
    },
    [repositories],
  );

  const [taskOrderByRepository, setTaskOrderByRepository] = useState<Record<string, string[]>>({});
  const reorderTasks = useCallback(
    (repositoryId: string, fromIndex: number, toIndex: number) => {
      const repository = repositories.find((p) => p.id === repositoryId);
      if (!repository) return;
      const currentOrder = taskOrderByRepository[repositoryId] ?? repository.tasks.map((t) => t.id);
      const ids = [...currentOrder];
      const [moved] = ids.splice(fromIndex, 1);
      ids.splice(toIndex, 0, moved!);
      setTaskOrderByRepository((prev) => ({ ...prev, [repositoryId]: ids }));
    },
    [repositories, taskOrderByRepository],
  );

  useEffect(() => {
    leftWidthRef.current = leftWidth;
    window.localStorage.setItem(LEFT_WIDTH_STORAGE_KEY, String(leftWidth));
  }, [leftWidth]);

  useEffect(() => {
    rightWidthRef.current = rightWidth;
    window.localStorage.setItem(RIGHT_WIDTH_STORAGE_KEY, String(rightWidth));
  }, [rightWidth]);

  const startLeftRef = useRef(leftWidth);
  const startRightRef = useRef(rightWidth);

  const onLeftResize = useCallback((deltaX: number) => {
    setLeftWidth(Math.min(Math.max(startLeftRef.current + deltaX, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH));
  }, []);

  const onLeftResizeStart = useCallback(() => {
    startLeftRef.current = leftWidthRef.current;
  }, []);

  const onRightResize = useCallback((deltaX: number) => {
    setRightWidth(Math.min(Math.max(startRightRef.current - deltaX, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH));
  }, []);

  const onRightResizeStart = useCallback(() => {
    startRightRef.current = rightWidthRef.current;
  }, []);

  const activeTask = useMemo(() => {
    if (selectedTaskId) {
      return tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null;
    }
    return tasks[0] ?? null;
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    if (activeTask) {
      return;
    }

    const fallbackTaskId = tasks[0]?.id;
    if (!fallbackTaskId) {
      return;
    }

    const fallbackTask = tasks.find((task) => task.id === fallbackTaskId) ?? null;

    void navigate({
      to: "/organizations/$organizationId/tasks/$taskId",
      params: {
        organizationId,
        taskId: fallbackTaskId,
      },
      search: { sessionId: fallbackTask?.sessions[0]?.id ?? undefined },
      replace: true,
    });
  }, [activeTask, navigate, tasks, organizationId]);

  const openDiffs = activeTask ? sanitizeOpenDiffs(activeTask, openDiffsByTask[activeTask.id]) : [];
  const lastAgentSessionId = activeTask ? sanitizeLastAgentSessionId(activeTask, lastAgentSessionIdByTask[activeTask.id]) : null;
  const activeSessionId = activeTask
    ? sanitizeActiveSessionId(activeTask, activeSessionIdByTask[activeTask.id] ?? activeTask.activeSessionId ?? null, openDiffs, lastAgentSessionId)
    : null;
  const selectedSessionHydrating = Boolean(
    selectedSessionId && activeSessionId === selectedSessionId && sessionState.status === "loading" && !sessionState.data,
  );

  const syncRouteSession = useCallback(
    (taskId: string, sessionId: string | null, replace = false) => {
      void navigate({
        to: "/organizations/$organizationId/tasks/$taskId",
        params: {
          organizationId,
          taskId,
        },
        search: { sessionId: sessionId ?? undefined },
        ...(replace ? { replace: true } : {}),
      });
    },
    [navigate, organizationId],
  );

  useEffect(() => {
    if (!activeTask) {
      return;
    }

    const resolvedRouteSessionId = sanitizeLastAgentSessionId(activeTask, selectedSessionId);
    if (!resolvedRouteSessionId) {
      return;
    }

    if (selectedSessionId !== resolvedRouteSessionId) {
      syncRouteSession(activeTask.id, resolvedRouteSessionId, true);
      return;
    }

    if (lastAgentSessionIdByTask[activeTask.id] === resolvedRouteSessionId) {
      return;
    }

    setLastAgentSessionIdByTask((current) => ({
      ...current,
      [activeTask.id]: resolvedRouteSessionId,
    }));
    setActiveSessionIdByTask((current) => {
      const currentActive = current[activeTask.id];
      if (currentActive && isDiffTab(currentActive)) {
        return current;
      }

      return {
        ...current,
        [activeTask.id]: resolvedRouteSessionId,
      };
    });
  }, [activeTask, lastAgentSessionIdByTask, selectedSessionId, syncRouteSession]);

  useEffect(() => {
    const organizationRepos = organizationReposData ?? [];
    if (selectedNewTaskRepoId && organizationRepos.some((repo) => repo.id === selectedNewTaskRepoId)) {
      return;
    }

    const fallbackRepoId =
      activeTask?.repoId && organizationRepos.some((repo) => repo.id === activeTask.repoId) ? activeTask.repoId : (organizationRepos[0]?.id ?? "");
    if (fallbackRepoId !== selectedNewTaskRepoId) {
      setSelectedNewTaskRepoId(fallbackRepoId);
    }
  }, [activeTask?.repoId, selectedNewTaskRepoId, organizationReposData]);

  useEffect(() => {
    if (!activeTask) {
      return;
    }
    if (activeTask.sessions.length > 0) {
      autoCreatingSessionForTaskRef.current.delete(activeTask.id);
      return;
    }
    if (selectedSessionId) {
      return;
    }
    if (autoCreatingSessionForTaskRef.current.has(activeTask.id)) {
      return;
    }

    autoCreatingSessionForTaskRef.current.add(activeTask.id);
    void (async () => {
      try {
        const { sessionId } = await taskWorkspaceClient.addSession({ repoId: activeTask.repoId, taskId: activeTask.id });
        syncRouteSession(activeTask.id, sessionId, true);
      } catch (error) {
        logger.error(
          {
            taskId: activeTask.id,
            ...createErrorContext(error),
          },
          "failed_to_auto_create_workspace_session",
        );
        // Keep the guard in the set on error to prevent retry storms.
        // The guard is cleared when sessions appear (line above) or the task changes.
      }
    })();
  }, [activeTask, selectedSessionId, syncRouteSession, taskWorkspaceClient]);

  const createTask = useCallback(
    (overrideRepoId?: string, options?: { title?: string; task?: string; branch?: string; onBranch?: string }) => {
      void (async () => {
        const repoId = overrideRepoId || selectedNewTaskRepoId;
        if (!repoId) {
          throw new Error("Cannot create a task without an available repo");
        }

        const { taskId, sessionId } = await taskWorkspaceClient.createTask({
          repoId,
          task: options?.task ?? "New task",
          model: currentUser?.defaultModel ?? DEFAULT_WORKSPACE_MODEL_ID,
          title: options?.title ?? "New task",
          ...(options?.branch ? { branch: options.branch } : {}),
          ...(options?.onBranch ? { onBranch: options.onBranch } : {}),
        });
        await navigate({
          to: "/organizations/$organizationId/tasks/$taskId",
          params: {
            organizationId,
            taskId,
          },
          search: { sessionId: sessionId ?? undefined },
        });
      })();
    },
    [currentUser?.defaultModel, navigate, selectedNewTaskRepoId, taskWorkspaceClient, organizationId],
  );

  const openDiffTab = useCallback(
    (path: string) => {
      if (!activeTask) {
        throw new Error("Cannot open a diff tab without an active task");
      }
      setOpenDiffsByTask((current) => {
        const existing = sanitizeOpenDiffs(activeTask, current[activeTask.id]);
        if (existing.includes(path)) {
          return current;
        }

        return {
          ...current,
          [activeTask.id]: [...existing, path],
        };
      });
      setActiveSessionIdByTask((current) => ({
        ...current,
        [activeTask.id]: diffTabId(path),
      }));
    },
    [activeTask],
  );

  const selectTask = useCallback(
    (id: string) => {
      const task = tasks.find((candidate) => candidate.id === id) ?? null;
      void navigate({
        to: "/organizations/$organizationId/tasks/$taskId",
        params: {
          organizationId,
          taskId: id,
        },
        search: { sessionId: task?.sessions[0]?.id ?? undefined },
      });
    },
    [navigate, tasks, organizationId],
  );

  const markTaskUnread = useCallback(
    (id: string) => {
      const task = tasks.find((candidate) => candidate.id === id);
      if (!task) {
        return;
      }
      void taskWorkspaceClient.markTaskUnread({ repoId: task.repoId, taskId: id });
    },
    [tasks],
  );

  const renameTask = useCallback(
    (id: string) => {
      const currentTask = tasks.find((task) => task.id === id);
      if (!currentTask) {
        throw new Error(`Unable to rename missing task ${id}`);
      }

      const nextTitle = window.prompt("Rename task", currentTask.title);
      if (nextTitle === null) {
        return;
      }

      const trimmedTitle = nextTitle.trim();
      if (!trimmedTitle) {
        return;
      }

      void taskWorkspaceClient.renameTask({ repoId: currentTask.repoId, taskId: id, value: trimmedTitle });
    },
    [tasks],
  );

  const changeOwner = useCallback(
    (member: { id: string; name: string; email: string }) => {
      if (!activeTask) {
        throw new Error("Cannot change owner without an active task");
      }
      void taskWorkspaceClient.changeOwner({
        repoId: activeTask.repoId,
        taskId: activeTask.id,
        targetUserId: member.id,
        targetUserName: member.name,
        targetUserEmail: member.email,
      });
    },
    [activeTask],
  );

  const archiveTask = useCallback(() => {
    if (!activeTask) {
      throw new Error("Cannot archive without an active task");
    }
    void taskWorkspaceClient.archiveTask({ repoId: activeTask.repoId, taskId: activeTask.id });
  }, [activeTask]);

  const publishPr = useCallback(() => {
    if (!activeTask) {
      throw new Error("Cannot publish PR without an active task");
    }
    void taskWorkspaceClient.publishPr({ repoId: activeTask.repoId, taskId: activeTask.id });
  }, [activeTask]);

  const revertFile = useCallback(
    (path: string) => {
      if (!activeTask) {
        throw new Error("Cannot revert a file without an active task");
      }
      setOpenDiffsByTask((current) => ({
        ...current,
        [activeTask.id]: sanitizeOpenDiffs(activeTask, current[activeTask.id]).filter((candidate) => candidate !== path),
      }));
      setActiveSessionIdByTask((current) => ({
        ...current,
        [activeTask.id]:
          current[activeTask.id] === diffTabId(path)
            ? sanitizeLastAgentSessionId(activeTask, lastAgentSessionIdByTask[activeTask.id])
            : (current[activeTask.id] ?? null),
      }));

      void taskWorkspaceClient.revertFile({
        repoId: activeTask.repoId,
        taskId: activeTask.id,
        path,
      });
    },
    [activeTask, lastAgentSessionIdByTask],
  );

  const isDesktop = !!import.meta.env.VITE_DESKTOP;
  const onDragMouseDown = useCallback((event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    // Tauri v2 IPC: invoke start_dragging on the webview window
    const ipc = (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ as
      | {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        }
      | undefined;
    if (ipc?.invoke) {
      ipc.invoke("plugin:window|start_dragging").catch(() => {});
    }
  }, []);
  const dragRegion = isDesktop ? (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: "38px",
        zIndex: 9998,
        pointerEvents: "none",
      }}
    >
      {/* Background drag target – sits behind interactive elements */}
      <div
        onPointerDown={onDragMouseDown}
        style={
          {
            position: "absolute",
            inset: 0,
            WebkitAppRegion: "drag",
            pointerEvents: "auto",
            zIndex: 0,
          } as React.CSSProperties
        }
      />
    </div>
  ) : null;

  const collapsedToggleClass = css({
    width: "26px",
    height: "26px",
    borderRadius: "6px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    color: t.textTertiary,
    position: "relative",
    zIndex: 9999,
    flexShrink: 0,
    ":hover": { color: t.textSecondary, backgroundColor: t.interactiveHover },
  });

  const sidebarTransition = "width 200ms ease";
  const contentFrameStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "row",
    overflow: "hidden",
    marginBottom: "8px",
    marginRight: "8px",
    marginLeft: leftSidebarOpen ? 0 : "8px",
  };

  if (!activeTask) {
    return (
      <>
        {dragRegion}
        <Shell>
          <div
            style={{
              width: leftSidebarOpen ? `${leftWidth}px` : 0,
              flexShrink: 0,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              transition: sidebarTransition,
            }}
          >
            <div style={{ minWidth: `${leftWidth}px`, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <Sidebar
                repositories={repositories}
                newTaskRepos={organizationRepos}
                selectedNewTaskRepoId={selectedNewTaskRepoId}
                activeId={selectedTaskId ?? ""}
                onSelect={selectTask}
                onCreate={createTask}
                onSelectNewTaskRepo={setSelectedNewTaskRepoId}
                onMarkUnread={markTaskUnread}
                onRenameTask={renameTask}
                onReorderRepositories={reorderRepositories}
                taskOrderByRepository={taskOrderByRepository}
                onReorderTasks={reorderTasks}
                onReloadOrganization={() => void taskWorkspaceClient.adminReloadGithubOrganization()}
                onReloadRepository={(repoId) => void taskWorkspaceClient.adminReloadGithubRepository(repoId)}
                onToggleSidebar={() => setLeftSidebarOpen(false)}
              />
            </div>
          </div>
          <div style={contentFrameStyle}>
            {leftSidebarOpen ? <PanelResizeHandle onResizeStart={onLeftResizeStart} onResize={onLeftResize} /> : null}
            <SPanel $style={{ backgroundColor: t.surfacePrimary, flex: 1, minWidth: 0 }}>
              {!leftSidebarOpen || !rightSidebarOpen ? (
                <div style={{ display: "flex", alignItems: "center", padding: "8px 8px 0 8px" }}>
                  {leftSidebarOpen ? null : (
                    <div className={collapsedToggleClass} onClick={() => setLeftSidebarOpen(true)}>
                      <PanelLeft size={14} />
                    </div>
                  )}
                  <div style={{ flex: 1 }} />
                  {rightSidebarOpen ? null : (
                    <div className={collapsedToggleClass} onClick={() => setRightSidebarOpen(true)}>
                      <PanelRight size={14} />
                    </div>
                  )}
                </div>
              ) : null}
              <ScrollBody>
                <div
                  style={{
                    minHeight: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "32px",
                  }}
                >
                  <div
                    style={{
                      maxWidth: "420px",
                      textAlign: "center",
                      display: "flex",
                      flexDirection: "column",
                      gap: "12px",
                    }}
                  >
                    {liveGithub?.syncStatus === "syncing" || liveGithub?.syncStatus === "pending" ? (
                      <>
                        <div
                          className={css({
                            width: "24px",
                            height: "24px",
                            border: `2px solid ${t.borderSubtle}`,
                            borderTopColor: t.textSecondary,
                            borderRadius: "50%",
                            animationName: {
                              from: { transform: "rotate(0deg)" },
                              to: { transform: "rotate(360deg)" },
                            } as unknown as string,
                            animationDuration: "0.8s",
                            animationIterationCount: "infinite",
                            animationTimingFunction: "linear",
                            alignSelf: "center",
                          })}
                        />
                        <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>Syncing with GitHub</h2>
                        <p style={{ margin: 0, opacity: 0.75 }}>
                          {liveGithub.lastSyncLabel || `Importing repos from @${liveGithub.connectedAccount || "GitHub"}...`}
                          {(liveGithub.totalRepositoryCount ?? 0) > 0 && (
                            <>
                              {" "}
                              {liveGithub.syncPhase === "syncing_repositories"
                                ? `${liveGithub.importedRepoCount} of ${liveGithub.totalRepositoryCount} repos imported so far.`
                                : `${liveGithub.processedRepositoryCount} of ${liveGithub.totalRepositoryCount} repos processed in ${liveGithub.syncPhase?.replace(/^syncing_/, "").replace(/_/g, " ") ?? "sync"}.`}
                            </>
                          )}
                        </p>
                      </>
                    ) : liveGithub?.syncStatus === "error" ? (
                      <>
                        <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600, color: t.statusError }}>GitHub sync failed</h2>
                        <p style={{ margin: 0, opacity: 0.75 }}>There was a problem syncing repos from GitHub. Check the dev panel for details.</p>
                      </>
                    ) : (
                      <>
                        <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>Create your first task</h2>
                        <p style={{ margin: 0, opacity: 0.75 }}>
                          {organizationRepos.length > 0
                            ? "Start from the sidebar to create a task on the first available repo."
                            : "No repos are available in this organization yet."}
                        </p>
                        <button
                          type="button"
                          onClick={() => createTask()}
                          disabled={organizationRepos.length === 0}
                          style={{
                            alignSelf: "center",
                            border: 0,
                            borderRadius: "999px",
                            padding: "10px 18px",
                            background: organizationRepos.length > 0 ? t.borderMedium : t.textTertiary,
                            color: t.textPrimary,
                            cursor: organizationRepos.length > 0 ? "pointer" : "not-allowed",
                            fontWeight: 600,
                          }}
                        >
                          New task
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </ScrollBody>
            </SPanel>
            {rightSidebarOpen ? <PanelResizeHandle onResizeStart={onRightResizeStart} onResize={onRightResize} /> : null}
            <div
              style={{
                width: rightSidebarOpen ? `${rightWidth}px` : 0,
                flexShrink: 0,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                transition: sidebarTransition,
              }}
            >
              <div style={{ minWidth: `${rightWidth}px`, flex: 1, display: "flex", flexDirection: "column" }}>
                <SPanel />
              </div>
            </div>
          </div>
        </Shell>
        {liveGithub && <GithubInstallationWarning github={liveGithub} css={css} t={t} />}
        {showDevPanel && (
          <DevPanel
            organizationId={organizationId}
            snapshot={{ organizationId, repos: organizationRepos, repositories: rawRepositories, tasks } as TaskWorkspaceSnapshot}
            organization={activeOrg}
            focusedTask={null}
          />
        )}
      </>
    );
  }

  return (
    <>
      {dragRegion}
      <Shell $style={{ position: "relative" }}>
        <div
          style={{
            width: leftSidebarOpen ? `${leftWidth}px` : 0,
            flexShrink: 0,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            transition: sidebarTransition,
          }}
        >
          <div style={{ minWidth: `${leftWidth}px`, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <Sidebar
              repositories={repositories}
              newTaskRepos={organizationRepos}
              selectedNewTaskRepoId={selectedNewTaskRepoId}
              activeId={selectedTaskId ?? activeTask.id}
              onSelect={selectTask}
              onCreate={createTask}
              onSelectNewTaskRepo={setSelectedNewTaskRepoId}
              onMarkUnread={markTaskUnread}
              onRenameTask={renameTask}
              onReorderRepositories={reorderRepositories}
              taskOrderByRepository={taskOrderByRepository}
              onReorderTasks={reorderTasks}
              onReloadOrganization={() => void taskWorkspaceClient.adminReloadGithubOrganization()}
              onReloadRepository={(repoId) => void taskWorkspaceClient.adminReloadGithubRepository(repoId)}
              onToggleSidebar={() => setLeftSidebarOpen(false)}
            />
          </div>
        </div>
        {!leftSidebarOpen && leftSidebarPeeking ? (
          <>
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: "rgba(0, 0, 0, 0.4)",
                zIndex: 99,
              }}
              onClick={() => setLeftSidebarPeeking(false)}
              onMouseEnter={endPeek}
            />
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                bottom: 0,
                width: `${leftWidth}px`,
                zIndex: 100,
                display: "flex",
                flexDirection: "column",
                boxShadow: "4px 0 24px rgba(0, 0, 0, 0.5)",
              }}
              onMouseEnter={startPeek}
              onMouseLeave={endPeek}
            >
              <Sidebar
                repositories={repositories}
                newTaskRepos={organizationRepos}
                selectedNewTaskRepoId={selectedNewTaskRepoId}
                activeId={selectedTaskId ?? activeTask.id}
                onSelect={(id) => {
                  selectTask(id);
                  setLeftSidebarPeeking(false);
                }}
                onCreate={createTask}
                onSelectNewTaskRepo={setSelectedNewTaskRepoId}
                onMarkUnread={markTaskUnread}
                onRenameTask={renameTask}
                onReorderRepositories={reorderRepositories}
                taskOrderByRepository={taskOrderByRepository}
                onReorderTasks={reorderTasks}
                onReloadOrganization={() => void taskWorkspaceClient.adminReloadGithubOrganization()}
                onReloadRepository={(repoId) => void taskWorkspaceClient.adminReloadGithubRepository(repoId)}
                onToggleSidebar={() => {
                  setLeftSidebarPeeking(false);
                  setLeftSidebarOpen(true);
                }}
              />
            </div>
          </>
        ) : null}
        <div style={contentFrameStyle}>
          {leftSidebarOpen ? <PanelResizeHandle onResizeStart={onLeftResizeStart} onResize={onLeftResize} /> : null}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <TranscriptPanel
              taskWorkspaceClient={taskWorkspaceClient}
              task={activeTask}
              hasSandbox={hasSandbox}
              modelGroups={modelGroups}
              activeSessionId={activeSessionId}
              lastAgentSessionId={lastAgentSessionId}
              openDiffs={openDiffs}
              onSyncRouteSession={syncRouteSession}
              onSetActiveSessionId={(sessionId) => {
                setActiveSessionIdByTask((current) => ({ ...current, [activeTask.id]: sessionId }));
              }}
              onSetLastAgentSessionId={(sessionId) => {
                setLastAgentSessionIdByTask((current) => ({ ...current, [activeTask.id]: sessionId }));
              }}
              onSetOpenDiffs={(paths) => {
                setOpenDiffsByTask((current) => ({ ...current, [activeTask.id]: paths }));
              }}
              sidebarCollapsed={!leftSidebarOpen}
              onToggleSidebar={() => {
                setLeftSidebarPeeking(false);
                setLeftSidebarOpen(true);
              }}
              onSidebarPeekStart={startPeek}
              onSidebarPeekEnd={endPeek}
              rightSidebarCollapsed={!rightSidebarOpen}
              onToggleRightSidebar={() => setRightSidebarOpen(true)}
              selectedSessionHydrating={selectedSessionHydrating}
              onNavigateToUsage={navigateToUsage}
            />
          </div>
          {rightSidebarOpen ? <PanelResizeHandle onResizeStart={onRightResizeStart} onResize={onRightResize} /> : null}
          <div
            style={{
              width: rightSidebarOpen ? `${rightWidth}px` : 0,
              flexShrink: 0,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              transition: sidebarTransition,
            }}
          >
            <div style={{ minWidth: `${rightWidth}px`, flex: 1, display: "flex", flexDirection: "column" }}>
              <RightRail
                organizationId={organizationId}
                task={activeTask}
                activeSessionId={activeSessionId}
                onOpenDiff={openDiffTab}
                onArchive={archiveTask}
                onRevertFile={revertFile}
                onPublishPr={publishPr}
                onChangeOwner={changeOwner}
                members={getMockOrganizationById(appSnapshot, organizationId)?.members ?? []}
                onToggleSidebar={() => setRightSidebarOpen(false)}
              />
            </div>
          </div>
        </div>
        {liveGithub && <GithubInstallationWarning github={liveGithub} css={css} t={t} />}
        {showDevPanel && (
          <DevPanel
            organizationId={organizationId}
            snapshot={{ organizationId, repos: organizationRepos, repositories: rawRepositories, tasks } as TaskWorkspaceSnapshot}
            organization={activeOrg}
            focusedTask={{
              id: activeTask.id,
              repoId: activeTask.repoId,
              title: activeTask.title,
              status: activeTask.status,
              branch: activeTask.branch ?? null,
              activeSandboxId: activeTask.activeSandboxId ?? null,
              activeSessionId: activeTask.activeSessionId ?? selectedSessionId ?? activeTask.sessions[0]?.id ?? null,
              sandboxes: [],
              sessions:
                activeTask.sessions?.map((tab) => ({
                  id: tab.id,
                  sessionId: tab.sessionId ?? null,
                  sessionName: tab.sessionName ?? tab.id,
                  agent: tab.agent,
                  model: tab.model,
                  status: tab.status,
                  thinkingSinceMs: tab.thinkingSinceMs ?? null,
                  unread: tab.unread ?? false,
                  created: tab.created ?? false,
                })) ?? [],
            }}
          />
        )}
      </Shell>
    </>
  );
}
