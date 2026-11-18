import type {
  AppEvent,
  CreateTaskInput,
  FoundryAppSnapshot,
  SandboxProcessesEvent,
  SessionEvent,
  TaskRecord,
  TaskSummary,
  TaskWorkspaceChangeModelInput,
  TaskWorkspaceCreateTaskInput,
  TaskWorkspaceCreateTaskResponse,
  TaskWorkspaceDiffInput,
  TaskWorkspaceRenameInput,
  TaskWorkspaceRenameSessionInput,
  TaskWorkspaceSelectInput,
  TaskWorkspaceSetSessionUnreadInput,
  TaskWorkspaceSendMessageInput,
  TaskWorkspaceSnapshot,
  TaskWorkspaceSessionInput,
  TaskWorkspaceUpdateDraftInput,
  TaskEvent,
  WorkspaceSessionDetail,
  WorkspaceModelGroup,
  WorkspaceTaskDetail,
  WorkspaceTaskSummary,
  OrganizationEvent,
  OrganizationSummarySnapshot,
  AuditLogEvent as HistoryEvent,
  HistoryQueryInput,
  SandboxProviderId,
  RepoOverview,
  RepoRecord,
  StarSandboxAgentRepoResult,
  SwitchResult,
} from "@sandbox-agent/foundry-shared";
import { DEFAULT_WORKSPACE_MODEL_GROUPS } from "@sandbox-agent/foundry-shared";
import type { ProcessCreateRequest, ProcessLogFollowQuery, ProcessLogsResponse, ProcessSignalQuery } from "sandbox-agent";
import type { ActorConn, BackendClient, SandboxProcessRecord, SandboxSessionEventRecord, SandboxSessionRecord } from "../backend-client.js";
import { getSharedMockWorkspaceClient } from "./workspace-client.js";

interface MockProcessRecord extends SandboxProcessRecord {
  logText: string;
}

function notSupported(name: string): never {
  throw new Error(`${name} is not supported by the mock backend client.`);
}

function encodeBase64Utf8(value: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "utf8").toString("base64");
  }
  return globalThis.btoa(unescape(encodeURIComponent(value)));
}

function nowMs(): number {
  return Date.now();
}

function mockRepoRemote(label: string): string {
  return `https://example.test/${label}.git`;
}

function mockCwd(repoLabel: string, taskId: string): string {
  return `/mock/${repoLabel.replace(/\//g, "-")}/${taskId}`;
}

function unsupportedAppSnapshot(): FoundryAppSnapshot {
  return {
    auth: { status: "signed_out", currentUserId: null },
    activeOrganizationId: null,
    onboarding: {
      starterRepo: {
        repoFullName: "rivet-dev/sandbox-agent",
        repoUrl: "https://github.com/rivet-dev/sandbox-agent",
        status: "pending",
        starredAt: null,
        skippedAt: null,
      },
    },
    users: [],
    organizations: [],
  };
}

function toTaskStatus(status: TaskRecord["status"], archived: boolean): TaskRecord["status"] {
  if (archived) {
    return "archived";
  }
  return status;
}

export function createMockBackendClient(defaultOrganizationId = "default"): BackendClient {
  const workspace = getSharedMockWorkspaceClient();
  const listenersBySandboxId = new Map<string, Set<() => void>>();
  const processesBySandboxId = new Map<string, MockProcessRecord[]>();
  const connectionListeners = new Map<string, Set<(payload: any) => void>>();
  let nextPid = 4000;
  let nextProcessId = 1;

  const requireTask = (taskId: string) => {
    const task = workspace.getSnapshot().tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Unknown mock task ${taskId}`);
    }
    return task;
  };

  const ensureProcessList = (sandboxId: string): MockProcessRecord[] => {
    const existing = processesBySandboxId.get(sandboxId);
    if (existing) {
      return existing;
    }
    const created: MockProcessRecord[] = [];
    processesBySandboxId.set(sandboxId, created);
    return created;
  };

  const notifySandbox = (sandboxId: string): void => {
    const listeners = listenersBySandboxId.get(sandboxId);
    if (!listeners) {
      emitSandboxProcessesUpdate(sandboxId);
      return;
    }
    for (const listener of [...listeners]) {
      listener();
    }
    emitSandboxProcessesUpdate(sandboxId);
  };

  const connectionChannel = (scope: string, event: string): string => `${scope}:${event}`;

  const emitConnectionEvent = (scope: string, event: string, payload: any): void => {
    const listeners = connectionListeners.get(connectionChannel(scope, event));
    if (!listeners) {
      return;
    }
    for (const listener of [...listeners]) {
      listener(payload);
    }
  };

  const createConn = (scope: string): ActorConn => ({
    on(event: string, listener: (payload: any) => void): () => void {
      const channel = connectionChannel(scope, event);
      let listeners = connectionListeners.get(channel);
      if (!listeners) {
        listeners = new Set();
        connectionListeners.set(channel, listeners);
      }
      listeners.add(listener);
      return () => {
        const current = connectionListeners.get(channel);
        if (!current) {
          return;
        }
        current.delete(listener);
        if (current.size === 0) {
          connectionListeners.delete(channel);
        }
      };
    },
    onError(): () => void {
      return () => {};
    },
    async dispose(): Promise<void> {},
  });

  const buildTaskSummary = (task: TaskWorkspaceSnapshot["tasks"][number]): WorkspaceTaskSummary => ({
    id: task.id,
    repoId: task.repoId,
    title: task.title,
    status: task.status,
    repoName: task.repoName,
    updatedAtMs: task.updatedAtMs,
    branch: task.branch,
    pullRequest: task.pullRequest,
    activeSessionId: task.activeSessionId ?? task.sessions[0]?.id ?? null,
    sessionsSummary: task.sessions.map((tab) => ({
      id: tab.id,
      sessionId: tab.sessionId,
      sandboxSessionId: tab.sandboxSessionId ?? tab.sessionId,
      sessionName: tab.sessionName,
      agent: tab.agent,
      model: tab.model,
      status: tab.status,
      thinkingSinceMs: tab.thinkingSinceMs,
      unread: tab.unread,
      created: tab.created,
    })),
    primaryUserLogin: null,
    primaryUserAvatarUrl: null,
  });

  const buildTaskDetail = (task: TaskWorkspaceSnapshot["tasks"][number]): WorkspaceTaskDetail => ({
    ...buildTaskSummary(task),
    task: task.title,
    fileChanges: task.fileChanges,
    diffs: task.diffs,
    fileTree: task.fileTree,
    minutesUsed: task.minutesUsed,
    sandboxes: [
      {
        sandboxProviderId: "local",
        sandboxId: task.id,
        cwd: mockCwd(task.repoName, task.id),
        url: null,
      },
    ],
    activeSandboxId: task.id,
  });

  const buildSessionDetail = (task: TaskWorkspaceSnapshot["tasks"][number], sessionId: string): WorkspaceSessionDetail => {
    const tab = task.sessions.find((candidate) => candidate.id === sessionId);
    if (!tab) {
      throw new Error(`Unknown mock session ${sessionId} for task ${task.id}`);
    }
    return {
      sessionId: tab.id,
      sandboxSessionId: tab.sandboxSessionId ?? tab.sessionId,
      sessionName: tab.sessionName,
      agent: tab.agent,
      model: tab.model,
      status: tab.status,
      thinkingSinceMs: tab.thinkingSinceMs,
      unread: tab.unread,
      created: tab.created,
      draft: tab.draft,
      transcript: tab.transcript,
    };
  };

  const buildOrganizationSummary = (): OrganizationSummarySnapshot => {
    const snapshot = workspace.getSnapshot();
    const taskSummaries = snapshot.tasks.map(buildTaskSummary);
    return {
      organizationId: defaultOrganizationId,
      github: {
        connectedAccount: "mock",
        installationStatus: "connected",
        syncStatus: "synced",
        importedRepoCount: snapshot.repos.length,
        lastSyncLabel: "Synced just now",
        lastSyncAt: nowMs(),
        lastWebhookAt: null,
        lastWebhookEvent: "",
        syncGeneration: 1,
        syncPhase: null,
        processedRepositoryCount: snapshot.repos.length,
        totalRepositoryCount: snapshot.repos.length,
      },
      repos: snapshot.repos.map((repo) => {
        const repoTasks = taskSummaries.filter((task) => task.repoId === repo.id);
        return {
          id: repo.id,
          label: repo.label,
          taskCount: repoTasks.length,
          latestActivityMs: repoTasks.reduce((latest, task) => Math.max(latest, task.updatedAtMs), 0),
        };
      }),
      taskSummaries,
    };
  };

  const organizationScope = (organizationId: string): string => `organization:${organizationId}`;
  const taskScope = (organizationId: string, repoId: string, taskId: string): string => `task:${organizationId}:${repoId}:${taskId}`;
  const sandboxScope = (organizationId: string, sandboxProviderId: string, sandboxId: string): string =>
    `sandbox:${organizationId}:${sandboxProviderId}:${sandboxId}`;

  const emitOrganizationSnapshot = (): void => {
    emitConnectionEvent(organizationScope(defaultOrganizationId), "organizationUpdated", {
      type: "organizationUpdated",
      snapshot: buildOrganizationSummary(),
    } satisfies OrganizationEvent);
  };

  const emitTaskUpdate = (taskId: string): void => {
    const task = requireTask(taskId);
    emitConnectionEvent(taskScope(defaultOrganizationId, task.repoId, task.id), "taskUpdated", {
      type: "taskUpdated",
      detail: buildTaskDetail(task),
    } satisfies TaskEvent);
  };

  const emitSessionUpdate = (taskId: string, sessionId: string): void => {
    const task = requireTask(taskId);
    emitConnectionEvent(taskScope(defaultOrganizationId, task.repoId, task.id), "sessionUpdated", {
      type: "sessionUpdated",
      session: buildSessionDetail(task, sessionId),
    } satisfies SessionEvent);
  };

  const emitSandboxProcessesUpdate = (sandboxId: string): void => {
    emitConnectionEvent(sandboxScope(defaultOrganizationId, "local", sandboxId), "processesUpdated", {
      type: "processesUpdated",
      processes: ensureProcessList(sandboxId).map((process) => cloneProcess(process)),
    } satisfies SandboxProcessesEvent);
  };

  const buildTaskRecord = (taskId: string): TaskRecord => {
    const task = requireTask(taskId);
    const cwd = mockCwd(task.repoName, task.id);
    const archived = task.status === "archived";
    return {
      organizationId: defaultOrganizationId,
      repoId: task.repoId,
      repoRemote: mockRepoRemote(task.repoName),
      taskId: task.id,
      branchName: task.branch,
      title: task.title,
      task: task.title,
      sandboxProviderId: "local",
      status: toTaskStatus(archived ? "archived" : "running", archived),
      pullRequest: null,
      activeSandboxId: task.id,
      sandboxes: [
        {
          sandboxId: task.id,
          sandboxProviderId: "local",
          sandboxActorId: "mock-sandbox",
          switchTarget: `mock://${task.id}`,
          cwd,
          createdAt: task.updatedAtMs,
          updatedAt: task.updatedAtMs,
        },
      ],
      createdAt: task.updatedAtMs,
      updatedAt: task.updatedAtMs,
    };
  };

  const cloneProcess = (process: MockProcessRecord): MockProcessRecord => ({ ...process });

  const createProcessRecord = (sandboxId: string, cwd: string, request: ProcessCreateRequest): MockProcessRecord => {
    const processId = `proc_${nextProcessId++}`;
    const createdAtMs = nowMs();
    const args = request.args ?? [];
    const interactive = request.interactive ?? false;
    const tty = request.tty ?? false;
    const statusLine = interactive && tty ? "Mock terminal session created.\nInteractive transport is unavailable in mock mode.\n" : "Mock process created.\n";
    const commandLine = `$ ${[request.command, ...args].join(" ").trim()}\n`;
    return {
      id: processId,
      command: request.command,
      args,
      createdAtMs,
      cwd: request.cwd ?? cwd,
      exitCode: null,
      exitedAtMs: null,
      interactive,
      pid: nextPid++,
      status: "running",
      tty,
      logText: `${statusLine}${commandLine}`,
    };
  };

  return {
    async getAppSnapshot(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async connectOrganization(organizationId: string): Promise<ActorConn> {
      return createConn(organizationScope(organizationId));
    },

    async connectTask(organizationId: string, repoId: string, taskId: string): Promise<ActorConn> {
      return createConn(taskScope(organizationId, repoId, taskId));
    },

    async connectSandbox(organizationId: string, sandboxProviderId: SandboxProviderId, sandboxId: string): Promise<ActorConn> {
      return createConn(sandboxScope(organizationId, sandboxProviderId, sandboxId));
    },

    subscribeApp(): () => void {
      return () => {};
    },

    async signInWithGithub(): Promise<void> {
      notSupported("signInWithGithub");
    },

    async signOutApp(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async skipAppStarterRepo(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async starAppStarterRepo(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async selectAppOrganization(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async setAppDefaultModel(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async updateAppOrganizationProfile(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async triggerAppRepoImport(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async reconnectAppGithub(): Promise<void> {
      notSupported("reconnectAppGithub");
    },

    async completeAppHostedCheckout(): Promise<void> {
      notSupported("completeAppHostedCheckout");
    },

    async openAppBillingPortal(): Promise<void> {
      notSupported("openAppBillingPortal");
    },

    async cancelAppScheduledRenewal(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async resumeAppSubscription(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async recordAppSeatUsage(): Promise<FoundryAppSnapshot> {
      return unsupportedAppSnapshot();
    },

    async listRepos(_organizationId: string): Promise<RepoRecord[]> {
      return workspace.getSnapshot().repos.map((repo) => ({
        organizationId: defaultOrganizationId,
        repoId: repo.id,
        remoteUrl: mockRepoRemote(repo.label),
        createdAt: nowMs(),
        updatedAt: nowMs(),
      }));
    },

    async createTask(_input: CreateTaskInput): Promise<TaskRecord> {
      notSupported("createTask");
    },

    async listTasks(_organizationId: string, repoId?: string): Promise<TaskSummary[]> {
      return workspace
        .getSnapshot()
        .tasks.filter((task) => !repoId || task.repoId === repoId)
        .map((task) => ({
          organizationId: defaultOrganizationId,
          repoId: task.repoId,
          taskId: task.id,
          branchName: task.branch,
          title: task.title,
          status: task.status === "archived" ? "archived" : "running",
          pullRequest: null,
          updatedAt: task.updatedAtMs,
        }));
    },

    async getRepoOverview(_organizationId: string, _repoId: string): Promise<RepoOverview> {
      notSupported("getRepoOverview");
    },
    async getTask(_organizationId: string, _repoId: string, taskId: string): Promise<TaskRecord> {
      return buildTaskRecord(taskId);
    },

    async listHistory(_input: HistoryQueryInput): Promise<HistoryEvent[]> {
      return [];
    },

    async switchTask(_organizationId: string, _repoId: string, taskId: string): Promise<SwitchResult> {
      return {
        organizationId: defaultOrganizationId,
        taskId,
        sandboxProviderId: "local",
        switchTarget: `mock://${taskId}`,
      };
    },

    async attachTask(_organizationId: string, _repoId: string, taskId: string): Promise<{ target: string; sessionId: string | null }> {
      return {
        target: `mock://${taskId}`,
        sessionId: requireTask(taskId).sessions[0]?.sessionId ?? null,
      };
    },

    async runAction(_organizationId: string, _repoId: string, _taskId: string): Promise<void> {
      notSupported("runAction");
    },

    async createSandboxSession(): Promise<{ id: string; status: "running" | "idle" | "error" }> {
      notSupported("createSandboxSession");
    },

    async listSandboxSessions(): Promise<{ items: SandboxSessionRecord[]; nextCursor?: string }> {
      return { items: [] };
    },

    async listSandboxSessionEvents(): Promise<{ items: SandboxSessionEventRecord[]; nextCursor?: string }> {
      return { items: [] };
    },

    async createSandboxProcess(input: {
      organizationId: string;
      sandboxProviderId: SandboxProviderId;
      sandboxId: string;
      request: ProcessCreateRequest;
    }): Promise<SandboxProcessRecord> {
      const task = requireTask(input.sandboxId);
      const processes = ensureProcessList(input.sandboxId);
      const created = createProcessRecord(input.sandboxId, mockCwd(task.repoName, task.id), input.request);
      processes.unshift(created);
      notifySandbox(input.sandboxId);
      return cloneProcess(created);
    },

    async listSandboxProcesses(_organizationId: string, _providerId: SandboxProviderId, sandboxId: string): Promise<{ processes: SandboxProcessRecord[] }> {
      return {
        processes: ensureProcessList(sandboxId).map((process) => cloneProcess(process)),
      };
    },

    async getSandboxProcessLogs(
      _organizationId: string,
      _providerId: SandboxProviderId,
      sandboxId: string,
      processId: string,
      query?: ProcessLogFollowQuery,
    ): Promise<ProcessLogsResponse> {
      const process = ensureProcessList(sandboxId).find((candidate) => candidate.id === processId);
      if (!process) {
        throw new Error(`Unknown mock process ${processId}`);
      }
      return {
        processId,
        stream: query?.stream ?? (process.tty ? "pty" : "combined"),
        entries: process.logText
          ? [
              {
                data: encodeBase64Utf8(process.logText),
                encoding: "base64",
                sequence: 1,
                stream: query?.stream ?? (process.tty ? "pty" : "combined"),
                timestampMs: process.createdAtMs,
              },
            ]
          : [],
      };
    },

    async stopSandboxProcess(
      _organizationId: string,
      _providerId: SandboxProviderId,
      sandboxId: string,
      processId: string,
      _query?: ProcessSignalQuery,
    ): Promise<SandboxProcessRecord> {
      const process = ensureProcessList(sandboxId).find((candidate) => candidate.id === processId);
      if (!process) {
        throw new Error(`Unknown mock process ${processId}`);
      }
      process.status = "exited";
      process.exitCode = 0;
      process.exitedAtMs = nowMs();
      process.logText += "\n[stopped]\n";
      notifySandbox(sandboxId);
      return cloneProcess(process);
    },

    async killSandboxProcess(
      _organizationId: string,
      _providerId: SandboxProviderId,
      sandboxId: string,
      processId: string,
      _query?: ProcessSignalQuery,
    ): Promise<SandboxProcessRecord> {
      const process = ensureProcessList(sandboxId).find((candidate) => candidate.id === processId);
      if (!process) {
        throw new Error(`Unknown mock process ${processId}`);
      }
      process.status = "exited";
      process.exitCode = 137;
      process.exitedAtMs = nowMs();
      process.logText += "\n[killed]\n";
      notifySandbox(sandboxId);
      return cloneProcess(process);
    },

    async deleteSandboxProcess(_organizationId: string, _providerId: SandboxProviderId, sandboxId: string, processId: string): Promise<void> {
      processesBySandboxId.set(
        sandboxId,
        ensureProcessList(sandboxId).filter((candidate) => candidate.id !== processId),
      );
      notifySandbox(sandboxId);
    },

    subscribeSandboxProcesses(_organizationId: string, _providerId: SandboxProviderId, sandboxId: string, listener: () => void): () => void {
      let listeners = listenersBySandboxId.get(sandboxId);
      if (!listeners) {
        listeners = new Set();
        listenersBySandboxId.set(sandboxId, listeners);
      }
      listeners.add(listener);
      return () => {
        const current = listenersBySandboxId.get(sandboxId);
        if (!current) {
          return;
        }
        current.delete(listener);
        if (current.size === 0) {
          listenersBySandboxId.delete(sandboxId);
        }
      };
    },

    async sendSandboxPrompt(): Promise<void> {
      notSupported("sendSandboxPrompt");
    },

    async sandboxSessionStatus(sessionId: string): Promise<{ id: string; status: "running" | "idle" | "error" }> {
      return { id: sessionId, status: "idle" };
    },

    async sandboxProviderState(
      _organizationId: string,
      _providerId: SandboxProviderId,
      sandboxId: string,
    ): Promise<{ sandboxProviderId: SandboxProviderId; sandboxId: string; state: string; at: number }> {
      return { sandboxProviderId: "local", sandboxId, state: "running", at: nowMs() };
    },

    async getSandboxAgentConnection(): Promise<{ endpoint: string; token?: string }> {
      return { endpoint: "mock://terminal-unavailable" };
    },

    async getSandboxWorkspaceModelGroups(_organizationId: string, _sandboxProviderId: SandboxProviderId, _sandboxId: string): Promise<WorkspaceModelGroup[]> {
      return DEFAULT_WORKSPACE_MODEL_GROUPS;
    },

    async getOrganizationSummary(): Promise<OrganizationSummarySnapshot> {
      return buildOrganizationSummary();
    },

    async getTaskDetail(_organizationId: string, _repoId: string, taskId: string): Promise<WorkspaceTaskDetail> {
      return buildTaskDetail(requireTask(taskId));
    },

    async getSessionDetail(_organizationId: string, _repoId: string, taskId: string, sessionId: string): Promise<WorkspaceSessionDetail> {
      return buildSessionDetail(requireTask(taskId), sessionId);
    },

    async getWorkspace(): Promise<TaskWorkspaceSnapshot> {
      return workspace.getSnapshot();
    },

    subscribeWorkspace(_organizationId: string, listener: () => void): () => void {
      return workspace.subscribe(listener);
    },

    async createWorkspaceTask(_organizationId: string, input: TaskWorkspaceCreateTaskInput): Promise<TaskWorkspaceCreateTaskResponse> {
      const created = await workspace.createTask(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(created.taskId);
      if (created.sessionId) {
        emitSessionUpdate(created.taskId, created.sessionId);
      }
      return created;
    },

    async markWorkspaceUnread(_organizationId: string, input: TaskWorkspaceSelectInput): Promise<void> {
      await workspace.markTaskUnread(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
    },

    async renameWorkspaceTask(_organizationId: string, input: TaskWorkspaceRenameInput): Promise<void> {
      await workspace.renameTask(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
    },

    async createWorkspaceSession(_organizationId: string, input: TaskWorkspaceSelectInput & { model?: string }): Promise<{ sessionId: string }> {
      const created = await workspace.addSession(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
      emitSessionUpdate(input.taskId, created.sessionId);
      return created;
    },

    async renameWorkspaceSession(_organizationId: string, input: TaskWorkspaceRenameSessionInput): Promise<void> {
      await workspace.renameSession(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
      emitSessionUpdate(input.taskId, input.sessionId);
    },

    async selectWorkspaceSession(_organizationId: string, input: TaskWorkspaceSessionInput): Promise<void> {
      await workspace.selectSession(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
      emitSessionUpdate(input.taskId, input.sessionId);
    },

    async setWorkspaceSessionUnread(_organizationId: string, input: TaskWorkspaceSetSessionUnreadInput): Promise<void> {
      await workspace.setSessionUnread(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
      emitSessionUpdate(input.taskId, input.sessionId);
    },

    async updateWorkspaceDraft(_organizationId: string, input: TaskWorkspaceUpdateDraftInput): Promise<void> {
      await workspace.updateDraft(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
      emitSessionUpdate(input.taskId, input.sessionId);
    },

    async changeWorkspaceModel(_organizationId: string, input: TaskWorkspaceChangeModelInput): Promise<void> {
      await workspace.changeModel(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
      emitSessionUpdate(input.taskId, input.sessionId);
    },

    async sendWorkspaceMessage(_organizationId: string, input: TaskWorkspaceSendMessageInput): Promise<void> {
      await workspace.sendMessage(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
      emitSessionUpdate(input.taskId, input.sessionId);
    },

    async stopWorkspaceSession(_organizationId: string, input: TaskWorkspaceSessionInput): Promise<void> {
      await workspace.stopAgent(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
      emitSessionUpdate(input.taskId, input.sessionId);
    },

    async closeWorkspaceSession(_organizationId: string, input: TaskWorkspaceSessionInput): Promise<void> {
      await workspace.closeSession(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
    },

    async publishWorkspacePr(_organizationId: string, input: TaskWorkspaceSelectInput): Promise<void> {
      await workspace.publishPr(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
    },

    async changeWorkspaceTaskOwner(
      _organizationId: string,
      input: { repoId: string; taskId: string; targetUserId: string; targetUserName: string; targetUserEmail: string },
    ): Promise<void> {
      await workspace.changeOwner(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
    },

    async revertWorkspaceFile(_organizationId: string, input: TaskWorkspaceDiffInput): Promise<void> {
      await workspace.revertFile(input);
      emitOrganizationSnapshot();
      emitTaskUpdate(input.taskId);
    },

    async adminReloadGithubOrganization(): Promise<void> {},
    async adminReloadGithubRepository(): Promise<void> {},

    async health(): Promise<{ ok: true }> {
      return { ok: true };
    },

    async useOrganization(organizationId: string): Promise<{ organizationId: string }> {
      return { organizationId };
    },

    async starSandboxAgentRepo(): Promise<StarSandboxAgentRepoResult> {
      return {
        repo: "rivet-dev/sandbox-agent",
        starredAt: nowMs(),
      };
    },
  };
}
