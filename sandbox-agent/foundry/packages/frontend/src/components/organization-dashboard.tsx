import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { RepoBranchRecord, RepoOverview, TaskWorkspaceSnapshot, WorkspaceTaskStatus } from "@sandbox-agent/foundry-shared";
import { currentFoundryOrganization, useSubscription } from "@sandbox-agent/foundry-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "baseui/button";
import { Input } from "baseui/input";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "baseui/modal";
import { Select, type OnChangeParams, type Option, type Value } from "baseui/select";
import { Skeleton } from "baseui/skeleton";
import { Tag } from "baseui/tag";
import { Textarea } from "baseui/textarea";
import { StyledDivider } from "baseui/divider";
import { styled, useStyletron } from "baseui";
import { HeadingSmall, HeadingXSmall, LabelSmall, LabelXSmall, MonoLabelSmall, ParagraphSmall } from "baseui/typography";
import { Bot, CircleAlert, FolderGit2, GitBranch, MessageSquareText, SendHorizontal } from "lucide-react";
import { deriveHeaderStatus, describeTaskState } from "../features/tasks/status";
import { HeaderStatusPill } from "./mock-layout/ui";
import { buildTranscript, resolveSessionSelection } from "../features/sessions/model";
import { backendClient } from "../lib/backend";
import { subscriptionManager } from "../lib/subscription";
import { DevPanel, useDevPanel } from "./dev-panel";

interface OrganizationDashboardProps {
  organizationId: string;
  selectedTaskId?: string;
  selectedRepoId?: string;
}

type RepoOverviewFilter = "active" | "archived" | "unmapped" | "all";
type StatusTagKind = "neutral" | "positive" | "warning" | "negative";
type SelectItem = Readonly<{ id: string; label: string; disabled?: boolean }>;

const AppShell = styled("main", ({ $theme }) => ({
  minHeight: "100dvh",
  backgroundColor: $theme.colors.backgroundPrimary,
}));

const DashboardGrid = styled("div", ({ $theme }) => ({
  display: "grid",
  gap: "1px",
  minHeight: "100dvh",
  backgroundColor: $theme.colors.borderOpaque,
  gridTemplateColumns: "minmax(0, 1fr)",
  "@media screen and (min-width: 960px)": {
    gridTemplateColumns: "260px minmax(0, 1fr)",
  },
  "@media screen and (min-width: 1480px)": {
    gridTemplateColumns: "260px minmax(0, 1fr) 280px",
  },
}));

const Panel = styled("section", ({ $theme }) => ({
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  backgroundColor: $theme.colors.backgroundSecondary,
  overflow: "hidden",
}));

const PanelHeader = styled("div", ({ $theme }) => ({
  padding: "10px 12px",
  borderBottom: `1px solid ${$theme.colors.borderOpaque}`,
  display: "flex",
  flexDirection: "column",
  gap: "8px",
}));

const ScrollBody = styled("div", ({ $theme }) => ({
  minHeight: 0,
  flex: 1,
  overflowY: "auto",
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
}));

const DetailRail = styled("aside", ({ $theme }) => ({
  minHeight: 0,
  display: "none",
  backgroundColor: $theme.colors.backgroundSecondary,
  overflow: "hidden",
  "@media screen and (min-width: 1480px)": {
    display: "flex",
    flexDirection: "column",
  },
}));

const FILTER_OPTIONS: SelectItem[] = [
  { id: "active", label: "Active + Unmapped" },
  { id: "archived", label: "Archived Tasks" },
  { id: "unmapped", label: "Unmapped Only" },
  { id: "all", label: "All Branches" },
];

function statusKind(status: WorkspaceTaskStatus): StatusTagKind {
  if (status === "running") return "positive";
  if (status === "error") return "negative";
  if (String(status).startsWith("init_")) return "warning";
  return "neutral";
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRelativeAge(value: number): string {
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function branchTestIdToken(value: string): string {
  const token = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return token || "branch";
}

function repoSummary(overview: RepoOverview | undefined): {
  total: number;
  mapped: number;
  unmapped: number;
  openPrs: number;
} {
  if (!overview) {
    return {
      total: 0,
      mapped: 0,
      unmapped: 0,
      openPrs: 0,
    };
  }

  let mapped = 0;
  let openPrs = 0;

  for (const row of overview.branches) {
    if (row.taskId) {
      mapped += 1;
    }
    if (row.pullRequest && row.pullRequest.state !== "MERGED" && row.pullRequest.state !== "CLOSED") {
      openPrs += 1;
    }
  }

  return {
    total: overview.branches.length,
    mapped,
    unmapped: Math.max(0, overview.branches.length - mapped),
    openPrs,
  };
}

function branchKind(row: RepoBranchRecord): StatusTagKind {
  if (row.pullRequest?.isDraft || row.pullRequest?.state === "OPEN") {
    return "warning";
  }
  if (row.pullRequest?.state === "MERGED") {
    return "positive";
  }
  return "neutral";
}

function branchPullRequestLabel(branch: RepoBranchRecord): string {
  if (!branch.pullRequest) {
    return "no pr";
  }
  if (branch.pullRequest.isDraft) {
    return "draft";
  }
  return branch.pullRequest.state.toLowerCase();
}

function matchesOverviewFilter(branch: RepoBranchRecord, filter: RepoOverviewFilter): boolean {
  if (filter === "archived") {
    return branch.taskStatus === "archived";
  }
  if (filter === "unmapped") {
    return branch.taskId === null;
  }
  if (filter === "active") {
    return branch.taskStatus !== "archived";
  }
  return true;
}

function selectValue(option: Option | null | undefined): Value {
  return option ? [option] : [];
}

function optionId(value: Value): string | null {
  const id = value[0]?.id;
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  return null;
}

function createOption(item: SelectItem): Option {
  return {
    id: item.id,
    label: item.label,
    disabled: item.disabled,
  };
}

function inputTestIdOverrides(testId?: string) {
  return testId
    ? {
        Input: {
          props: {
            "data-testid": testId,
          },
        },
      }
    : undefined;
}

function textareaTestIdOverrides(testId?: string) {
  return testId
    ? {
        Input: {
          props: {
            "data-testid": testId,
          },
        },
      }
    : undefined;
}

function selectTestIdOverrides(testId?: string) {
  return testId
    ? {
        ControlContainer: {
          props: {
            "data-testid": testId,
          },
        },
      }
    : undefined;
}

function EmptyState({ children, testId }: { children: string; testId?: string }) {
  return (
    <div
      data-testid={testId}
      style={{
        padding: "12px",
        borderRadius: "0",
        border: "1px dashed rgba(166, 176, 191, 0.24)",
        background: "rgba(255, 255, 255, 0.02)",
      }}
    >
      <ParagraphSmall marginTop="0" marginBottom="0" color="contentSecondary">
        {children}
      </ParagraphSmall>
    </div>
  );
}

function StatusPill({ children, kind }: { children: ReactNode; kind: StatusTagKind }) {
  return (
    <Tag
      closeable={false}
      kind={kind}
      hierarchy="secondary"
      size="small"
      overrides={{
        Root: {
          style: {
            borderRadius: "2px",
            minHeight: "20px",
            fontFamily: '"IBM Plex Mono", "SFMono-Regular", monospace',
            letterSpacing: "0.02em",
          },
        },
      }}
    >
      {children}
    </Tag>
  );
}

function MetaRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: "12px",
        alignItems: "flex-start",
      }}
    >
      <LabelXSmall color="contentSecondary">{label}</LabelXSmall>
      {mono ? (
        <MonoLabelSmall marginTop="0" marginBottom="0" overrides={{ Block: { style: { textAlign: "right", wordBreak: "break-word" } } }}>
          {value}
        </MonoLabelSmall>
      ) : (
        <LabelSmall marginTop="0" marginBottom="0" overrides={{ Block: { style: { textAlign: "right", wordBreak: "break-word" } } }}>
          {value}
        </LabelSmall>
      )}
    </div>
  );
}

export function OrganizationDashboard({ organizationId, selectedTaskId, selectedRepoId }: OrganizationDashboardProps) {
  const [css, theme] = useStyletron();
  const navigate = useNavigate();
  const showDevPanel = useDevPanel();
  const repoOverviewMode = typeof selectedRepoId === "string" && selectedRepoId.length > 0;

  const [draft, setDraft] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [createRepoId, setCreateRepoId] = useState("");
  const [newTask, setNewTask] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [createOnBranch, setCreateOnBranch] = useState<string | null>(null);
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [selectedOverviewBranch, setSelectedOverviewBranch] = useState<string | null>(null);
  const [overviewFilter, setOverviewFilter] = useState<RepoOverviewFilter>("active");
  const [createError, setCreateError] = useState<string | null>(null);

  const appState = useSubscription(subscriptionManager, "app", {});
  const activeOrg = appState.data ? currentFoundryOrganization(appState.data) : null;

  const organizationState = useSubscription(subscriptionManager, "organization", { organizationId });
  const reposData = organizationState.data?.repos;
  const rowsData = organizationState.data?.taskSummaries;
  const repos = reposData ?? [];
  const rows = rowsData ?? [];
  const selectedSummary = useMemo(() => rows.find((row) => row.id === selectedTaskId) ?? rows[0] ?? null, [rowsData, selectedTaskId]);
  const taskState = useSubscription(
    subscriptionManager,
    "task",
    !repoOverviewMode && selectedSummary
      ? {
          organizationId,
          repoId: selectedSummary.repoId,
          taskId: selectedSummary.id,
        }
      : null,
  );
  const activeRepoId = selectedRepoId ?? createRepoId;

  const repoOverviewQuery = useQuery({
    queryKey: ["organization", organizationId, "repo-overview", activeRepoId],
    enabled: Boolean(repoOverviewMode && activeRepoId),
    queryFn: async () => {
      if (!activeRepoId) {
        throw new Error("No repo selected");
      }
      return backendClient.getRepoOverview(organizationId, activeRepoId);
    },
  });

  useEffect(() => {
    const repos = reposData ?? [];
    if (repoOverviewMode && selectedRepoId) {
      setCreateRepoId(selectedRepoId);
      return;
    }
    if (!createRepoId && repos.length > 0) {
      setCreateRepoId(repos[0]!.id);
    }
  }, [createRepoId, repoOverviewMode, reposData, selectedRepoId]);

  const repoGroups = useMemo(() => {
    const repos = reposData ?? [];
    const rows = rowsData ?? [];
    const byRepo = new Map<string, typeof rows>();
    for (const row of rows) {
      const bucket = byRepo.get(row.repoId);
      if (bucket) {
        bucket.push(row);
      } else {
        byRepo.set(row.repoId, [row]);
      }
    }

    return repos
      .map((repo) => {
        const tasks = [...(byRepo.get(repo.id) ?? [])].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
        const latestTaskAt = tasks[0]?.updatedAtMs ?? 0;
        return {
          repoId: repo.id,
          repoLabel: repo.label,
          latestActivityAt: Math.max(repo.latestActivityMs, latestTaskAt),
          tasks,
        };
      })
      .sort((a, b) => {
        if (a.latestActivityAt !== b.latestActivityAt) {
          return b.latestActivityAt - a.latestActivityAt;
        }
        return a.repoLabel.localeCompare(b.repoLabel);
      });
  }, [reposData, rowsData]);

  const selectedForSession = repoOverviewMode ? null : (taskState.data ?? null);

  const activeSandbox = useMemo(() => {
    if (!selectedForSession) return null;
    const byActive = selectedForSession.activeSandboxId
      ? (selectedForSession.sandboxes.find((sandbox) => sandbox.sandboxId === selectedForSession.activeSandboxId) ?? null)
      : null;
    return byActive ?? selectedForSession.sandboxes[0] ?? null;
  }, [selectedForSession]);

  useEffect(() => {
    const rows = rowsData ?? [];
    if (!repoOverviewMode && !selectedTaskId && rows.length > 0) {
      void navigate({
        to: "/organizations/$organizationId/tasks/$taskId",
        params: {
          organizationId,
          taskId: rows[0]!.id,
        },
        search: { sessionId: undefined },
        replace: true,
      });
    }
  }, [navigate, repoOverviewMode, rowsData, selectedTaskId, organizationId]);

  useEffect(() => {
    setActiveSessionId(null);
    setDraft("");
  }, [selectedForSession?.id]);

  const sessionRowsData = selectedForSession?.sessionsSummary;
  const sessionRows = sessionRowsData ?? [];
  const taskStatus = selectedForSession?.status ?? null;
  const taskStatusState = describeTaskState(taskStatus);
  const taskStateSummary = `${taskStatusState.title}. ${taskStatusState.detail}`;
  const shouldUseTaskStateEmptyState = Boolean(selectedForSession && taskStatus && taskStatus !== "running" && taskStatus !== "idle");
  const sessionSelection = useMemo(
    () =>
      resolveSessionSelection({
        explicitSessionId: activeSessionId,
        taskSessionId: selectedForSession?.activeSessionId ?? null,
        sessions: sessionRows.map((session) => ({
          id: session.id,
          agent: session.agent,
          agentSessionId: session.sessionId ?? "",
          lastConnectionId: "",
          createdAt: 0,
          status: session.status,
        })),
      }),
    [activeSessionId, selectedForSession?.activeSessionId, sessionRowsData],
  );
  const resolvedSessionId = sessionSelection.sessionId;
  const staleSessionId = sessionSelection.staleSessionId;
  const sessionState = useSubscription(
    subscriptionManager,
    "session",
    selectedForSession && resolvedSessionId
      ? {
          organizationId,
          repoId: selectedForSession.repoId,
          taskId: selectedForSession.id,
          sessionId: resolvedSessionId,
        }
      : null,
  );
  const selectedSessionSummary = useMemo(() => sessionRows.find((session) => session.id === resolvedSessionId) ?? null, [resolvedSessionId, sessionRowsData]);
  const isPendingProvision = selectedSessionSummary?.status === "pending_provision";
  const isPendingSessionCreate = selectedSessionSummary?.status === "pending_session_create";
  const isSessionError = selectedSessionSummary?.status === "error";
  const canStartSession = Boolean(selectedForSession && activeSandbox?.sandboxId);
  const devPanelFocusedTask = useMemo(() => {
    if (repoOverviewMode) {
      return null;
    }

    const task = selectedForSession ?? selectedSummary;
    if (!task) {
      return null;
    }

    return {
      id: task.id,
      repoId: task.repoId,
      title: task.title,
      status: task.status,
      branch: task.branch ?? null,
      activeSandboxId: selectedForSession?.activeSandboxId ?? null,
      activeSessionId: selectedForSession?.activeSessionId ?? null,
      sandboxes: selectedForSession?.sandboxes ?? [],
      sessions: selectedForSession?.sessionsSummary ?? [],
    };
  }, [repoOverviewMode, selectedForSession, selectedSummary]);
  const devPanelSnapshot = useMemo(
    (): TaskWorkspaceSnapshot => ({
      organizationId,
      repos: repos.map((repo) => ({ id: repo.id, label: repo.label })),
      repositories: [],
      tasks: rows.map((task) => ({
        id: task.id,
        repoId: task.repoId,
        title: task.title,
        status: task.status,
        repoName: task.repoName,
        updatedAtMs: task.updatedAtMs,
        branch: task.branch ?? null,
        pullRequest: task.pullRequest,
        sessions: task.sessionsSummary.map((session) => ({
          ...session,
          draft: {
            text: "",
            attachments: [],
            updatedAtMs: null,
          },
          transcript: [],
        })),
        fileChanges: [],
        diffs: {},
        fileTree: [],
        minutesUsed: 0,
        activeSandboxId: selectedForSession?.id === task.id ? selectedForSession.activeSandboxId : null,
      })),
    }),
    [reposData, rowsData, selectedForSession, organizationId],
  );

  const startSessionFromTask = async (): Promise<{ id: string; status: "running" | "idle" | "error" }> => {
    if (!selectedForSession || !activeSandbox?.sandboxId) {
      throw new Error("No sandbox is available for this task");
    }
    const preferredAgent = selectedSessionSummary?.agent === "Claude" ? "claude" : selectedSessionSummary?.agent === "Codex" ? "codex" : undefined;
    return backendClient.createSandboxSession({
      organizationId,
      sandboxProviderId: activeSandbox.sandboxProviderId,
      sandboxId: activeSandbox.sandboxId,
      prompt: selectedForSession.task,
      cwd: activeSandbox.cwd ?? undefined,
      agent: preferredAgent,
    });
  };

  const createSession = useMutation({
    mutationFn: async () => startSessionFromTask(),
    onSuccess: (session) => {
      setActiveSessionId(session.id);
    },
  });

  const ensureSessionForPrompt = async (): Promise<string> => {
    if (resolvedSessionId) {
      return resolvedSessionId;
    }
    const created = await startSessionFromTask();
    setActiveSessionId(created.id);
    return created.id;
  };

  const sendPrompt = useMutation({
    mutationFn: async (prompt: string) => {
      if (!selectedForSession || !activeSandbox?.sandboxId) {
        throw new Error("No sandbox is available for this task");
      }
      const sessionId = await ensureSessionForPrompt();
      await backendClient.sendSandboxPrompt({
        organizationId,
        sandboxProviderId: activeSandbox.sandboxProviderId,
        sandboxId: activeSandbox.sandboxId,
        sessionId,
        prompt,
      });
    },
    onSuccess: () => {
      setDraft("");
    },
  });

  const transcript = buildTranscript(sessionState.data?.transcript ?? []);
  const canCreateTask = createRepoId.trim().length > 0 && newTask.trim().length > 0;

  const createTask = useMutation({
    mutationFn: async () => {
      const repoId = createRepoId.trim();
      const task = newTask.trim();
      if (!repoId || !task) {
        throw new Error("Repository and task are required");
      }

      const draftTitle = newTitle.trim();
      const draftBranchName = newBranchName.trim();

      return backendClient.createTask({
        organizationId,
        repoId,
        task,
        explicitTitle: draftTitle || undefined,
        explicitBranchName: createOnBranch ? undefined : draftBranchName || undefined,
        onBranch: createOnBranch ?? undefined,
      });
    },
    onSuccess: async (task) => {
      setCreateError(null);
      setNewTask("");
      setNewTitle("");
      setNewBranchName("");
      setCreateOnBranch(null);
      setCreateTaskOpen(false);
      await navigate({
        to: "/organizations/$organizationId/tasks/$taskId",
        params: {
          organizationId,
          taskId: task.taskId,
        },
        search: { sessionId: undefined },
      });
    },
    onError: (error) => {
      setCreateError(error instanceof Error ? error.message : String(error));
    },
  });

  const openCreateFromBranch = (repoId: string, branchName: string): void => {
    setCreateRepoId(repoId);
    setCreateOnBranch(branchName);
    setNewBranchName("");
    setCreateError(null);
    if (!newTask.trim()) {
      setNewTask(`Continue work on ${branchName}`);
    }
    setCreateTaskOpen(true);
  };

  const repoOptions = useMemo(() => repos.map((repo) => createOption({ id: repo.id, label: repo.label })), [reposData]);
  const selectedRepoOption = repoOptions.find((option) => option.id === createRepoId) ?? null;
  const selectedFilterOption = useMemo(
    () => createOption(FILTER_OPTIONS.find((option) => option.id === overviewFilter) ?? FILTER_OPTIONS[0]!),
    [overviewFilter],
  );
  const sessionOptions = useMemo(
    () => sessionRows.map((session) => createOption({ id: session.id, label: `${session.sessionName} (${session.status})` })),
    [sessionRowsData],
  );
  const selectedSessionOption = sessionOptions.find((option) => option.id === resolvedSessionId) ?? null;

  const overview = repoOverviewQuery.data;
  const overviewStats = repoSummary(overview);
  const filteredOverviewBranches = useMemo(() => {
    if (!overview?.branches?.length) {
      return [];
    }
    return overview.branches.filter((branch) => matchesOverviewFilter(branch, overviewFilter));
  }, [overview, overviewFilter]);
  const selectedBranchOverview = useMemo(() => {
    if (!filteredOverviewBranches.length) {
      return null;
    }
    if (!selectedOverviewBranch) {
      return filteredOverviewBranches[0] ?? null;
    }
    return filteredOverviewBranches.find((row) => row.branchName === selectedOverviewBranch) ?? filteredOverviewBranches[0] ?? null;
  }, [filteredOverviewBranches, selectedOverviewBranch]);

  useEffect(() => {
    if (!filteredOverviewBranches.length) {
      setSelectedOverviewBranch(null);
      return;
    }
    if (!selectedOverviewBranch || !filteredOverviewBranches.some((row) => row.branchName === selectedOverviewBranch)) {
      setSelectedOverviewBranch(filteredOverviewBranches[0]?.branchName ?? null);
    }
  }, [filteredOverviewBranches, selectedOverviewBranch]);

  const modalOverrides = useMemo(
    () => ({
      Dialog: {
        style: {
          borderRadius: "0",
          backgroundColor: theme.colors.backgroundSecondary,
          border: `1px solid ${theme.colors.borderOpaque}`,
          boxShadow: "0 18px 40px rgba(0, 0, 0, 0.45)",
        },
      },
      Close: {
        style: {
          borderRadius: "0",
        },
      },
    }),
    [theme.colors.backgroundSecondary, theme.colors.borderOpaque],
  );

  return (
    <AppShell>
      <DashboardGrid>
        <Panel>
          <PanelHeader>
            <div
              className={css({
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: theme.sizing.scale400,
              })}
            >
              <div
                className={css({
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: "2px",
                })}
              >
                <LabelXSmall color="contentTertiary">Organization</LabelXSmall>
                <div
                  className={css({
                    display: "flex",
                    alignItems: "center",
                    gap: theme.sizing.scale300,
                  })}
                >
                  <FolderGit2 size={14} />
                  <HeadingXSmall marginTop="0" marginBottom="0">
                    {organizationId}
                  </HeadingXSmall>
                </div>
              </div>

              <Button
                size="compact"
                kind="secondary"
                onClick={() => {
                  void navigate({
                    to: "/organizations/$organizationId/settings",
                    params: { organizationId },
                  });
                }}
                data-testid="organization-settings-open"
              >
                GitHub Settings
              </Button>
            </div>

            <div
              className={css({
                paddingTop: theme.sizing.scale200,
                borderTop: `1px solid ${theme.colors.borderOpaque}`,
              })}
            >
              <LabelXSmall color="contentSecondary">Tasks</LabelXSmall>
            </div>
          </PanelHeader>

          <ScrollBody>
            {organizationState.status === "loading" ? (
              <>
                <Skeleton rows={3} height="72px" />
              </>
            ) : null}

            {organizationState.status !== "loading" && repoGroups.length === 0 ? (
              <EmptyState>No repos or tasks yet. Create the repository in GitHub, then sync repos from organization settings.</EmptyState>
            ) : null}

            {repoGroups.map((group) => (
              <section
                key={group.repoId}
                className={css({
                  marginLeft: "-12px",
                  marginRight: "-12px",
                  paddingBottom: "8px",
                  borderBottom: `1px solid ${theme.colors.borderOpaque}`,
                })}
              >
                <Link
                  to="/organizations/$organizationId/repos/$repoId"
                  params={{ organizationId, repoId: group.repoId }}
                  className={css({
                    display: "block",
                    textDecoration: "none",
                    fontSize: theme.typography.LabelSmall.fontSize,
                    fontWeight: 600,
                    lineHeight: "1.35",
                    color: theme.colors.contentSecondary,
                    padding: "10px 12px 8px",
                    wordBreak: "break-word",
                    ":hover": {
                      color: theme.colors.contentPrimary,
                      backgroundColor: "rgba(255, 255, 255, 0.02)",
                    },
                  })}
                  data-testid={group.repoId === activeRepoId ? "repo-overview-open" : `repo-overview-open-${group.repoId}`}
                >
                  {group.repoLabel}
                </Link>

                <div
                  className={css({
                    display: "flex",
                    flexDirection: "column",
                    gap: "0",
                  })}
                >
                  {group.tasks
                    .filter((task) => task.status !== "archived" || task.id === selectedSummary?.id)
                    .map((task) => {
                      const isActive = !repoOverviewMode && task.id === selectedSummary?.id;
                      return (
                        <Link
                          key={task.id}
                          to="/organizations/$organizationId/tasks/$taskId"
                          params={{ organizationId, taskId: task.id }}
                          search={{ sessionId: undefined }}
                          className={css({
                            display: "block",
                            textDecoration: "none",
                            borderLeft: `2px solid ${isActive ? theme.colors.primary : "transparent"}`,
                            borderTop: `1px solid ${theme.colors.borderOpaque}`,
                            backgroundColor: isActive ? "rgba(143, 180, 255, 0.08)" : task.status === "archived" ? "rgba(255, 255, 255, 0.02)" : "transparent",
                            padding: "10px 12px 10px 14px",
                            transition: "background-color 0.15s ease, border-color 0.15s ease",
                            ":hover": {
                              backgroundColor: isActive ? "rgba(143, 180, 255, 0.1)" : "rgba(255, 255, 255, 0.03)",
                            },
                          })}
                        >
                          <LabelSmall marginTop="0" marginBottom="0">
                            {task.title ?? "Determining title..."}
                          </LabelSmall>
                          <div
                            className={css({
                              marginTop: "8px",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: theme.sizing.scale300,
                            })}
                          >
                            <ParagraphSmall
                              marginTop="0"
                              marginBottom="0"
                              color="contentSecondary"
                              overrides={{ Block: { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } } }}
                            >
                              {task.branch ?? "Determining branch..."}
                            </ParagraphSmall>
                            <StatusPill kind={statusKind(task.status)}>{task.status}</StatusPill>
                          </div>
                        </Link>
                      );
                    })}

                  <Button
                    size="compact"
                    kind="tertiary"
                    overrides={{
                      BaseButton: {
                        style: {
                          justifyContent: "flex-start",
                          borderRadius: "0",
                          paddingLeft: "12px",
                          paddingRight: "12px",
                        },
                      },
                    }}
                    onClick={() => {
                      setCreateRepoId(group.repoId);
                      setCreateOnBranch(null);
                      setCreateError(null);
                      setCreateTaskOpen(true);
                    }}
                    data-testid={group.repoId === createRepoId ? "task-create-open" : `task-create-open-${group.repoId}`}
                  >
                    Create Task
                  </Button>
                </div>
              </section>
            ))}
          </ScrollBody>
        </Panel>

        <Panel>
          {repoOverviewMode ? (
            <>
              <PanelHeader>
                <div
                  className={css({
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: theme.sizing.scale400,
                    flexWrap: "wrap",
                  })}
                >
                  <div
                    className={css({
                      display: "flex",
                      alignItems: "center",
                      gap: theme.sizing.scale300,
                    })}
                  >
                    <GitBranch size={16} />
                    <HeadingXSmall marginTop="0" marginBottom="0">
                      Repo Overview
                    </HeadingXSmall>
                  </div>

                  <div
                    className={css({
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: theme.sizing.scale300,
                    })}
                  >
                    <div className={css({ minWidth: "220px" })}>
                      <Select
                        options={FILTER_OPTIONS.map(createOption)}
                        value={selectValue(selectedFilterOption)}
                        clearable={false}
                        searchable={false}
                        size="compact"
                        onChange={(params: OnChangeParams) => {
                          const next = optionId(params.value) as RepoOverviewFilter | null;
                          if (next) {
                            setOverviewFilter(next);
                          }
                        }}
                        aria-label="Filter branches"
                        overrides={selectTestIdOverrides("repo-overview-filter")}
                      />
                    </div>
                  </div>
                </div>

                <div
                  className={css({
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "8px",
                  })}
                >
                  <StatusPill kind="neutral">Branches {overviewStats.total}</StatusPill>
                  <StatusPill kind="positive">Mapped {overviewStats.mapped}</StatusPill>
                  <StatusPill kind="warning">Unmapped {overviewStats.unmapped}</StatusPill>
                  <StatusPill kind="neutral">Open PRs {overviewStats.openPrs}</StatusPill>
                </div>
              </PanelHeader>

              <ScrollBody data-testid="repo-overview-center">
                {repoOverviewQuery.isLoading ? <Skeleton rows={4} height="72px" /> : null}

                {!repoOverviewQuery.isLoading && !overview ? <EmptyState>No repo overview is available yet.</EmptyState> : null}

                {overview ? (
                  <div
                    className={css({
                      overflowX: "auto",
                      border: `1px solid ${theme.colors.borderOpaque}`,
                    })}
                  >
                    <div
                      className={css({
                        minWidth: "980px",
                        display: "grid",
                        gridTemplateColumns: "2fr 1.3fr 1fr 1fr 0.9fr 1.2fr",
                      })}
                    >
                      {["Branch", "Task", "PR", "CI / Review", "Updated", "Actions"].map((label) => (
                        <div
                          key={label}
                          className={css({
                            padding: `12px ${theme.sizing.scale400}`,
                            backgroundColor: theme.colors.backgroundTertiary,
                            borderBottom: `1px solid ${theme.colors.borderOpaque}`,
                          })}
                        >
                          <LabelXSmall color="contentSecondary">{label}</LabelXSmall>
                        </div>
                      ))}

                      {filteredOverviewBranches.length === 0 ? (
                        <div
                          className={css({
                            gridColumn: "1 / -1",
                            padding: theme.sizing.scale600,
                          })}
                          data-testid="repo-overview-filter-empty"
                        >
                          <ParagraphSmall marginTop="0" marginBottom="0" color="contentSecondary">
                            No branches match the selected filter.
                          </ParagraphSmall>
                        </div>
                      ) : (
                        filteredOverviewBranches.map((branch) => {
                          const selectedRow = selectedBranchOverview?.branchName === branch.branchName;
                          const branchToken = branchTestIdToken(branch.branchName);
                          const rowClass = css({
                            display: "contents",
                          });
                          const cellClass = css({
                            padding: `${theme.sizing.scale400} ${theme.sizing.scale400}`,
                            borderBottom: `1px solid ${theme.colors.borderOpaque}`,
                            backgroundColor: selectedRow ? "rgba(29, 111, 95, 0.08)" : theme.colors.backgroundSecondary,
                            fontSize: theme.typography.ParagraphSmall.fontSize,
                            cursor: "pointer",
                          });
                          return (
                            <div
                              key={branch.branchName}
                              className={rowClass}
                              onClick={() => setSelectedOverviewBranch(branch.branchName)}
                              data-testid={`repo-overview-row-${branchToken}`}
                            >
                              <div className={cellClass}>
                                <LabelSmall marginTop="0" marginBottom="0">
                                  {branch.branchName}
                                </LabelSmall>
                                <div
                                  className={css({
                                    marginTop: "8px",
                                    display: "flex",
                                    alignItems: "center",
                                    flexWrap: "wrap",
                                    gap: theme.sizing.scale200,
                                  })}
                                >
                                  <StatusPill kind={branch.taskId ? "positive" : "warning"}>{branch.taskId ? "task" : "unmapped"}</StatusPill>
                                  <ParagraphSmall marginTop="0" marginBottom="0" color="contentSecondary">
                                    {branch.commitSha.slice(0, 10) || "-"}
                                  </ParagraphSmall>
                                </div>
                              </div>
                              <div className={cellClass}>{branch.taskTitle ?? branch.taskId ?? "-"}</div>
                              <div className={cellClass}>
                                {branch.pullRequest ? (
                                  <a
                                    href={branch.pullRequest.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className={css({
                                      color: theme.colors.contentPrimary,
                                    })}
                                  >
                                    #{branch.pullRequest.number} {branchPullRequestLabel(branch)}
                                  </a>
                                ) : (
                                  <span className={css({ color: theme.colors.contentSecondary })}>-</span>
                                )}
                              </div>
                              <div className={cellClass}>
                                {branch.ciStatus ?? "-"} / {branch.pullRequest ? (branch.pullRequest.isDraft ? "draft" : "ready") : "-"}
                              </div>
                              <div className={cellClass}>{formatRelativeAge(branch.updatedAt)}</div>
                              <div className={cellClass}>
                                <div
                                  className={css({
                                    display: "flex",
                                    flexWrap: "wrap",
                                    gap: theme.sizing.scale200,
                                  })}
                                >
                                  {!branch.taskId ? (
                                    <Button
                                      size="compact"
                                      kind="secondary"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        openCreateFromBranch(activeRepoId, branch.branchName);
                                      }}
                                      data-testid={`repo-overview-create-${branchToken}`}
                                    >
                                      Create Task
                                    </Button>
                                  ) : null}

                                  <StatusPill kind={branchKind(branch)}>{branchPullRequestLabel(branch)}</StatusPill>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                ) : null}
              </ScrollBody>
            </>
          ) : (
            <>
              <PanelHeader>
                <div
                  className={css({
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: theme.sizing.scale400,
                    flexWrap: "wrap",
                  })}
                >
                  <div
                    className={css({
                      display: "flex",
                      alignItems: "center",
                      gap: theme.sizing.scale300,
                      flexWrap: "wrap",
                    })}
                  >
                    <Bot size={16} />
                    <HeadingXSmall marginTop="0" marginBottom="0">
                      {selectedForSession ? (selectedForSession.title ?? "Determining title...") : "No task selected"}
                    </HeadingXSmall>
                    {selectedForSession ? (
                      <HeaderStatusPill
                        status={deriveHeaderStatus(
                          taskStatus ?? selectedForSession.status,
                          selectedSessionSummary?.status ?? null,
                          selectedSessionSummary?.errorMessage ?? null,
                          Boolean(activeSandbox?.sandboxId),
                        )}
                      />
                    ) : null}
                  </div>

                  {selectedForSession && !resolvedSessionId ? (
                    <Button
                      size="compact"
                      onClick={() => {
                        void createSession.mutateAsync();
                      }}
                      disabled={createSession.isPending || !canStartSession}
                    >
                      {staleSessionId ? "Start New Session" : "Start Session"}
                    </Button>
                  ) : null}
                </div>
                {selectedForSession ? (
                  <ParagraphSmall marginTop="0" marginBottom="0" color="contentSecondary" data-testid="task-runtime-state">
                    {taskStateSummary}
                  </ParagraphSmall>
                ) : null}
              </PanelHeader>

              <div
                className={css({
                  minHeight: 0,
                  flex: 1,
                  display: "grid",
                  gridTemplateRows: "minmax(0, 1fr) auto",
                  gap: "1px",
                  padding: 0,
                  backgroundColor: theme.colors.borderOpaque,
                })}
              >
                {!selectedForSession ? (
                  <EmptyState>Select a task from the left sidebar.</EmptyState>
                ) : (
                  <>
                    <div
                      className={css({
                        minHeight: 0,
                        display: "flex",
                        flexDirection: "column",
                        backgroundColor: theme.colors.backgroundSecondary,
                        overflow: "hidden",
                      })}
                    >
                      <div
                        className={css({
                          padding: `${theme.sizing.scale400} ${theme.sizing.scale500}`,
                          borderBottom: `1px solid ${theme.colors.borderOpaque}`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: theme.sizing.scale400,
                          flexWrap: "wrap",
                          backgroundColor: theme.colors.backgroundTertiary,
                        })}
                      >
                        <div
                          className={css({
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            color: theme.colors.contentSecondary,
                          })}
                        >
                          <MessageSquareText size={14} />
                          <LabelSmall marginTop="0" marginBottom="0">
                            Session {resolvedSessionId ?? staleSessionId ?? "(none)"}
                          </LabelSmall>
                        </div>

                        {sessionRows.length > 0 ? (
                          <div className={css({ minWidth: "280px", maxWidth: "100%" })}>
                            <Select
                              options={sessionOptions}
                              value={selectValue(selectedSessionOption)}
                              clearable={false}
                              searchable={false}
                              size="compact"
                              onChange={(params: OnChangeParams) => {
                                const next = optionId(params.value);
                                if (next) {
                                  setActiveSessionId(next);
                                }
                              }}
                              overrides={selectTestIdOverrides("task-session-select")}
                            />
                          </div>
                        ) : null}
                      </div>

                      <div
                        className={css({
                          minHeight: 0,
                          flex: 1,
                          overflowY: "auto",
                          padding: theme.sizing.scale400,
                          backgroundColor: theme.colors.backgroundPrimary,
                        })}
                      >
                        {resolvedSessionId && sessionState.status === "loading" ? <Skeleton rows={2} height="90px" /> : null}

                        {selectedSessionSummary && (isPendingProvision || isPendingSessionCreate) ? (
                          <div
                            className={css({
                              display: "flex",
                              flexDirection: "column",
                              gap: theme.sizing.scale300,
                              padding: theme.sizing.scale500,
                              border: `1px solid ${theme.colors.borderOpaque}`,
                              backgroundColor: theme.colors.backgroundSecondary,
                              marginBottom: theme.sizing.scale400,
                            })}
                          >
                            <LabelSmall marginTop="0" marginBottom="0">
                              {shouldUseTaskStateEmptyState ? taskStatusState.title : isPendingProvision ? "Provisioning sandbox..." : "Creating session..."}
                            </LabelSmall>
                            <Skeleton rows={1} height="32px" />
                            <ParagraphSmall marginTop="0" marginBottom="0" color="contentSecondary">
                              {shouldUseTaskStateEmptyState
                                ? taskStateSummary
                                : isPendingProvision
                                  ? "The task is still provisioning."
                                  : "The session is being created."}
                            </ParagraphSmall>
                          </div>
                        ) : null}

                        {transcript.length === 0 && !(resolvedSessionId && sessionState.status === "loading") ? (
                          <EmptyState testId="session-transcript-empty">
                            {shouldUseTaskStateEmptyState
                              ? taskStateSummary
                              : isPendingProvision
                                ? "Provisioning sandbox..."
                                : isPendingSessionCreate
                                  ? "Creating session..."
                                  : isSessionError
                                    ? (selectedSessionSummary?.errorMessage ?? "Session failed to start.")
                                    : !activeSandbox?.sandboxId
                                      ? "This task is still provisioning its sandbox."
                                      : staleSessionId
                                        ? `Session ${staleSessionId} is unavailable. Start a new session to continue.`
                                        : resolvedSessionId
                                          ? "No transcript events yet. Send a prompt to start this session."
                                          : "No active session for this task."}
                          </EmptyState>
                        ) : null}

                        <div
                          className={css({
                            display: "flex",
                            flexDirection: "column",
                            gap: theme.sizing.scale400,
                          })}
                          data-testid="session-transcript"
                        >
                          {transcript.map((entry) => (
                            <article
                              key={entry.id}
                              data-testid="session-transcript-entry"
                              className={css({
                                borderLeft: `2px solid ${entry.sender === "agent" ? "rgba(29, 111, 95, 0.45)" : "rgba(32, 108, 176, 0.45)"}`,
                                border: `1px solid ${entry.sender === "agent" ? "rgba(29, 111, 95, 0.22)" : "rgba(32, 108, 176, 0.22)"}`,
                                backgroundColor: entry.sender === "agent" ? "rgba(29, 111, 95, 0.07)" : "rgba(32, 108, 176, 0.07)",
                                padding: `12px ${theme.sizing.scale400}`,
                              })}
                            >
                              <header
                                className={css({
                                  marginBottom: "8px",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: theme.sizing.scale300,
                                })}
                              >
                                <LabelXSmall color="contentSecondary">{entry.sender}</LabelXSmall>
                                <LabelXSmall color="contentSecondary">{formatTime(entry.createdAt)}</LabelXSmall>
                              </header>
                              <pre
                                className={css({
                                  margin: 0,
                                  whiteSpace: "pre-wrap",
                                  overflowX: "auto",
                                  fontFamily: '"IBM Plex Mono", "SFMono-Regular", monospace',
                                  fontSize: theme.typography.MonoParagraphSmall.fontSize,
                                  lineHeight: theme.typography.MonoParagraphSmall.lineHeight,
                                })}
                              >
                                {entry.text}
                              </pre>
                            </article>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div
                      className={css({
                        display: "flex",
                        flexDirection: "column",
                        gap: "1px",
                        padding: "10px 12px",
                        backgroundColor: theme.colors.backgroundSecondary,
                      })}
                    >
                      <Textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder="Send a follow-up prompt to this session"
                        rows={5}
                        disabled={!activeSandbox?.sandboxId || isPendingProvision || isPendingSessionCreate || isSessionError}
                        overrides={textareaTestIdOverrides("task-session-prompt")}
                      />
                      <div
                        className={css({
                          display: "flex",
                          justifyContent: "flex-end",
                        })}
                      >
                        <Button
                          onClick={() => {
                            const prompt = draft.trim();
                            if (!prompt) {
                              return;
                            }
                            void sendPrompt.mutateAsync(prompt);
                          }}
                          disabled={
                            sendPrompt.isPending ||
                            createSession.isPending ||
                            !selectedForSession ||
                            !activeSandbox?.sandboxId ||
                            isPendingProvision ||
                            isPendingSessionCreate ||
                            isSessionError ||
                            draft.trim().length === 0
                          }
                        >
                          <span
                            className={css({
                              display: "inline-flex",
                              alignItems: "center",
                              gap: theme.sizing.scale200,
                            })}
                          >
                            <SendHorizontal size={14} />
                            Send
                          </span>
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </Panel>

        <DetailRail>
          <PanelHeader>
            <HeadingSmall marginTop="0" marginBottom="0">
              {repoOverviewMode ? "Repo Details" : "Task Details"}
            </HeadingSmall>
          </PanelHeader>

          <ScrollBody>
            {repoOverviewMode ? (
              !overview ? (
                <ParagraphSmall marginTop="0" marginBottom="0" color="contentSecondary">
                  No repo overview available.
                </ParagraphSmall>
              ) : (
                <>
                  <section>
                    <HeadingXSmall marginTop="0" marginBottom="0">
                      Repository
                    </HeadingXSmall>
                    <StyledDivider />
                    <div
                      className={css({
                        display: "flex",
                        flexDirection: "column",
                        gap: theme.sizing.scale300,
                      })}
                    >
                      <MetaRow label="Remote" value={overview.remoteUrl} />
                      <MetaRow label="Base Ref" value={overview.baseRef ?? "-"} mono />
                      <MetaRow label="Fetched" value={new Date(overview.fetchedAt).toLocaleTimeString()} />
                    </div>
                  </section>

                  <section>
                    <HeadingXSmall marginTop="0" marginBottom="0">
                      Selected Branch
                    </HeadingXSmall>
                    <StyledDivider />
                    {!selectedBranchOverview ? (
                      <ParagraphSmall marginTop="0" marginBottom="0" color="contentSecondary">
                        Select a branch in the center panel.
                      </ParagraphSmall>
                    ) : (
                      <div
                        className={css({
                          display: "flex",
                          flexDirection: "column",
                          gap: theme.sizing.scale300,
                        })}
                      >
                        <MetaRow label="Branch" value={selectedBranchOverview.branchName} mono />
                        <MetaRow label="Commit" value={selectedBranchOverview.commitSha.slice(0, 10)} mono />
                        <MetaRow label="Task" value={selectedBranchOverview.taskTitle ?? selectedBranchOverview.taskId ?? "-"} />
                        <MetaRow label="PR" value={selectedBranchOverview.pullRequest?.url ?? "-"} />
                        <MetaRow label="Updated" value={new Date(selectedBranchOverview.updatedAt).toLocaleTimeString()} />
                      </div>
                    )}
                  </section>
                </>
              )
            ) : !selectedForSession ? (
              <ParagraphSmall marginTop="0" marginBottom="0" color="contentSecondary">
                No task selected.
              </ParagraphSmall>
            ) : (
              <>
                <section>
                  <HeadingXSmall marginTop="0" marginBottom="0">
                    Identifiers
                  </HeadingXSmall>
                  <StyledDivider />
                  <div
                    className={css({
                      display: "flex",
                      flexDirection: "column",
                      gap: theme.sizing.scale300,
                    })}
                  >
                    <MetaRow label="State" value={taskStatus ?? "-"} mono />
                    <MetaRow label="State detail" value={taskStatusState.detail} />
                    <MetaRow label="Task" value={selectedForSession.id} mono />
                    <MetaRow label="Sandbox" value={selectedForSession.activeSandboxId ?? "-"} mono />
                    <MetaRow label="Session" value={resolvedSessionId ?? "-"} mono />
                  </div>
                </section>

                <section>
                  <HeadingXSmall marginTop="0" marginBottom="0">
                    Branch + PR
                  </HeadingXSmall>
                  <StyledDivider />
                  <div
                    className={css({
                      display: "flex",
                      flexDirection: "column",
                      gap: theme.sizing.scale300,
                    })}
                  >
                    <MetaRow label="Branch" value={selectedForSession.branch ?? "-"} mono />
                    <MetaRow label="PR" value={selectedForSession.pullRequest?.url ?? "-"} />
                    <MetaRow label="Review" value={selectedForSession.pullRequest ? (selectedForSession.pullRequest.isDraft ? "draft" : "ready") : "-"} />
                  </div>
                </section>

                <section>
                  <HeadingXSmall marginTop="0" marginBottom="0">
                    Task
                  </HeadingXSmall>
                  <StyledDivider />
                  <div
                    className={css({
                      padding: theme.sizing.scale400,
                      borderRadius: "0",
                      backgroundColor: theme.colors.backgroundTertiary,
                      border: `1px solid ${theme.colors.borderOpaque}`,
                    })}
                  >
                    <ParagraphSmall marginTop="0" marginBottom="0">
                      {selectedForSession.task}
                    </ParagraphSmall>
                  </div>
                </section>

                {taskStatus === "error" ? (
                  <div
                    className={css({
                      padding: "12px",
                      borderRadius: "0",
                      border: `1px solid rgba(188, 57, 74, 0.28)`,
                      backgroundColor: "rgba(188, 57, 74, 0.06)",
                    })}
                  >
                    <div
                      className={css({
                        display: "flex",
                        alignItems: "center",
                        gap: theme.sizing.scale200,
                        marginBottom: theme.sizing.scale200,
                      })}
                    >
                      <CircleAlert size={14} />
                      <LabelSmall marginTop="0" marginBottom="0">
                        Task reported an error state
                      </LabelSmall>
                    </div>
                    <ParagraphSmall marginTop="0" marginBottom="0" color="contentSecondary">
                      {taskStatusState.detail}
                    </ParagraphSmall>
                  </div>
                ) : null}
              </>
            )}
          </ScrollBody>
        </DetailRail>

        <Modal
          isOpen={createTaskOpen}
          onClose={() => {
            setCreateTaskOpen(false);
            setCreateOnBranch(null);
          }}
          overrides={modalOverrides}
        >
          <ModalHeader>Create Task</ModalHeader>
          <ModalBody>
            <div
              className={css({
                display: "flex",
                flexDirection: "column",
                gap: theme.sizing.scale500,
              })}
            >
              <ParagraphSmall marginTop="0" marginBottom="0" color="contentSecondary">
                Pick a repo, describe the task, and the backend will create a task.
              </ParagraphSmall>

              <div>
                <LabelXSmall color="contentSecondary" marginBottom="scale200">
                  Repo
                </LabelXSmall>
                <Select
                  options={repoOptions}
                  value={selectValue(selectedRepoOption)}
                  clearable={false}
                  searchable={false}
                  disabled={repos.length === 0}
                  onChange={(params: OnChangeParams) => {
                    const next = optionId(params.value);
                    if (next) {
                      setCreateRepoId(next);
                    }
                  }}
                  overrides={selectTestIdOverrides("task-create-repo")}
                />
                {repos.length === 0 ? (
                  <ParagraphSmall marginTop="8px" marginBottom="0" color="contentSecondary">
                    No imported repos yet. Create the repository in GitHub first, then sync repos from organization settings.
                  </ParagraphSmall>
                ) : null}
              </div>

              <div>
                <LabelXSmall color="contentSecondary" marginBottom="scale200">
                  Task
                </LabelXSmall>
                <Textarea
                  value={newTask}
                  onChange={(event) => setNewTask(event.target.value)}
                  placeholder="Task"
                  rows={6}
                  overrides={textareaTestIdOverrides("task-create-task")}
                />
              </div>

              <div>
                <LabelXSmall color="contentSecondary" marginBottom="scale200">
                  Title
                </LabelXSmall>
                <Input
                  placeholder="Title (optional)"
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                  overrides={inputTestIdOverrides("task-create-title")}
                />
              </div>

              <div>
                <LabelXSmall color="contentSecondary" marginBottom="scale200">
                  Branch
                </LabelXSmall>
                {createOnBranch ? (
                  <Input value={createOnBranch} disabled overrides={inputTestIdOverrides("task-create-branch")} />
                ) : (
                  <Input
                    placeholder="Branch name (optional)"
                    value={newBranchName}
                    onChange={(event) => setNewBranchName(event.target.value)}
                    overrides={inputTestIdOverrides("task-create-branch")}
                  />
                )}
              </div>

              {createError ? (
                <ParagraphSmall marginTop="0" marginBottom="0" color="negative" data-testid="task-create-error">
                  {createError}
                </ParagraphSmall>
              ) : null}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button
              kind="tertiary"
              onClick={() => {
                setCreateTaskOpen(false);
                setCreateOnBranch(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!canCreateTask || createTask.isPending}
              onClick={() => {
                setCreateError(null);
                void createTask.mutateAsync();
              }}
              data-testid="task-create-submit"
            >
              {createTask.isPending ? "Creating..." : "Create Task"}
            </Button>
          </ModalFooter>
        </Modal>
      </DashboardGrid>
      {showDevPanel ? (
        <DevPanel organizationId={organizationId} snapshot={devPanelSnapshot} organization={activeOrg} focusedTask={devPanelFocusedTask} />
      ) : null}
    </AppShell>
  );
}
