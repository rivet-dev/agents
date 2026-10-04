import {
  MODEL_GROUPS,
  buildInitialMockLayoutViewModel,
  groupWorkspaceRepositories,
  nowMs,
  providerAgent,
  randomReply,
  removeFileTreePath,
  slugify,
  uid,
} from "../workspace-model.js";
import { DEFAULT_WORKSPACE_MODEL_ID, workspaceAgentForModel } from "@sandbox-agent/foundry-shared";
import type {
  TaskWorkspaceAddSessionResponse,
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
  WorkspaceSession as AgentSession,
  WorkspaceTask as Task,
  WorkspaceTranscriptEvent as TranscriptEvent,
} from "@sandbox-agent/foundry-shared";
import type { TaskWorkspaceClient } from "../workspace-client.js";

function buildTranscriptEvent(params: {
  sessionId: string;
  sender: "client" | "agent";
  createdAt: number;
  payload: unknown;
  eventIndex: number;
}): TranscriptEvent {
  return {
    id: uid(),
    sessionId: params.sessionId,
    sender: params.sender,
    createdAt: params.createdAt,
    payload: params.payload,
    connectionId: "mock-connection",
    eventIndex: params.eventIndex,
  };
}

class MockWorkspaceStore implements TaskWorkspaceClient {
  private snapshot = buildInitialMockLayoutViewModel();
  private listeners = new Set<() => void>();
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  getSnapshot(): TaskWorkspaceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async createTask(input: TaskWorkspaceCreateTaskInput): Promise<TaskWorkspaceCreateTaskResponse> {
    const id = uid();
    const sessionId = `session-${id}`;
    const repo = this.snapshot.repos.find((candidate) => candidate.id === input.repoId);
    if (!repo) {
      throw new Error(`Cannot create mock task for unknown repo ${input.repoId}`);
    }
    const nextTask: Task = {
      id,
      repoId: repo.id,
      title: input.title?.trim() || "New Task",
      status: "init_enqueue_provision",
      repoName: repo.label,
      updatedAtMs: nowMs(),
      branch: input.branch?.trim() || null,
      pullRequest: null,
      activeSessionId: sessionId,
      sessions: [
        {
          id: sessionId,
          sessionId: sessionId,
          sessionName: "Session 1",
          agent: workspaceAgentForModel(input.model ?? DEFAULT_WORKSPACE_MODEL_ID, MODEL_GROUPS),
          model: input.model ?? DEFAULT_WORKSPACE_MODEL_ID,
          status: "idle",
          thinkingSinceMs: null,
          unread: false,
          created: false,
          draft: { text: "", attachments: [], updatedAtMs: null },
          transcript: [],
        },
      ],
      fileChanges: [],
      diffs: {},
      fileTree: [],
      minutesUsed: 0,
    };

    this.updateState((current) => ({
      ...current,
      tasks: [nextTask, ...current.tasks],
    }));
    return { taskId: id, sessionId };
  }

  async markTaskUnread(input: TaskWorkspaceSelectInput): Promise<void> {
    this.updateTask(input.taskId, (task) => {
      const targetSession = task.sessions[task.sessions.length - 1] ?? null;
      if (!targetSession) {
        return task;
      }

      return {
        ...task,
        sessions: task.sessions.map((session) => (session.id === targetSession.id ? { ...session, unread: true } : session)),
      };
    });
  }

  async renameTask(input: TaskWorkspaceRenameInput): Promise<void> {
    const value = input.value.trim();
    if (!value) {
      throw new Error(`Cannot rename task ${input.taskId} to an empty title`);
    }
    this.updateTask(input.taskId, (task) => ({ ...task, title: value, updatedAtMs: nowMs() }));
  }

  async archiveTask(input: TaskWorkspaceSelectInput): Promise<void> {
    this.updateTask(input.taskId, (task) => ({ ...task, status: "archived", updatedAtMs: nowMs() }));
  }

  async publishPr(input: TaskWorkspaceSelectInput): Promise<void> {
    const nextPrNumber = Math.max(0, ...this.snapshot.tasks.map((task) => task.pullRequest?.number ?? 0)) + 1;
    this.updateTask(input.taskId, (task) => ({
      ...task,
      updatedAtMs: nowMs(),
      pullRequest: {
        number: nextPrNumber,
        status: "ready",
        title: task.title,
        state: "open",
        url: `https://example.test/pr/${nextPrNumber}`,
        headRefName: task.branch ?? `task/${task.id}`,
        baseRefName: "main",
        repoFullName: task.repoName,
        authorLogin: "mock",
        isDraft: false,
        updatedAtMs: nowMs(),
      },
    }));
  }

  async revertFile(input: TaskWorkspaceDiffInput): Promise<void> {
    this.updateTask(input.taskId, (task) => {
      const file = task.fileChanges.find((entry) => entry.path === input.path);
      const nextDiffs = { ...task.diffs };
      delete nextDiffs[input.path];

      return {
        ...task,
        fileChanges: task.fileChanges.filter((entry) => entry.path !== input.path),
        diffs: nextDiffs,
        fileTree: file?.type === "A" ? removeFileTreePath(task.fileTree, input.path) : task.fileTree,
      };
    });
  }

  async updateDraft(input: TaskWorkspaceUpdateDraftInput): Promise<void> {
    this.assertSession(input.taskId, input.sessionId);
    this.updateTask(input.taskId, (task) => ({
      ...task,
      updatedAtMs: nowMs(),
      sessions: task.sessions.map((tab) =>
        tab.id === input.sessionId
          ? {
              ...tab,
              draft: {
                text: input.text,
                attachments: input.attachments,
                updatedAtMs: nowMs(),
              },
            }
          : tab,
      ),
    }));
  }

  async sendMessage(input: TaskWorkspaceSendMessageInput): Promise<void> {
    const text = input.text.trim();
    if (!text) {
      throw new Error(`Cannot send an empty mock prompt for task ${input.taskId}`);
    }

    this.assertSession(input.taskId, input.sessionId);
    const startedAtMs = nowMs();

    this.updateTask(input.taskId, (currentTask) => {
      const isFirstOnTask = String(currentTask.status).startsWith("init_");
      const newTitle = isFirstOnTask ? (text.length > 50 ? `${text.slice(0, 47)}...` : text) : currentTask.title;
      const newBranch = isFirstOnTask ? `feat/${slugify(newTitle)}` : currentTask.branch;
      const userMessageLines = [text, ...input.attachments.map((attachment) => `@ ${attachment.filePath}:${attachment.lineNumber}`)];
      const userEvent = buildTranscriptEvent({
        sessionId: input.sessionId,
        sender: "client",
        createdAt: startedAtMs,
        eventIndex: candidateEventIndex(currentTask, input.sessionId),
        payload: {
          method: "session/prompt",
          params: {
            prompt: userMessageLines.map((line) => ({ type: "text", text: line })),
          },
        },
      });

      return {
        ...currentTask,
        title: newTitle,
        branch: newBranch,
        status: "running",
        updatedAtMs: startedAtMs,
        sessions: currentTask.sessions.map((candidate) =>
          candidate.id === input.sessionId
            ? {
                ...candidate,
                created: true,
                status: "running",
                unread: false,
                thinkingSinceMs: startedAtMs,
                draft: { text: "", attachments: [], updatedAtMs: startedAtMs },
                transcript: [...candidate.transcript, userEvent],
              }
            : candidate,
        ),
      };
    });

    const existingTimer = this.pendingTimers.get(input.sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      const task = this.requireTask(input.taskId);
      this.requireSession(task, input.sessionId);
      const completedAtMs = nowMs();
      const replyEvent = buildTranscriptEvent({
        sessionId: input.sessionId,
        sender: "agent",
        createdAt: completedAtMs,
        eventIndex: candidateEventIndex(task, input.sessionId),
        payload: {
          result: {
            text: randomReply(),
            durationMs: completedAtMs - startedAtMs,
          },
        },
      });

      this.updateTask(input.taskId, (currentTask) => {
        const updatedTabs = currentTask.sessions.map((candidate) => {
          if (candidate.id !== input.sessionId) {
            return candidate;
          }

          return {
            ...candidate,
            status: "idle" as const,
            thinkingSinceMs: null,
            unread: true,
            transcript: [...candidate.transcript, replyEvent],
          };
        });
        const anyRunning = updatedTabs.some((candidate) => candidate.status === "running");

        return {
          ...currentTask,
          updatedAtMs: completedAtMs,
          sessions: updatedTabs,
          status: currentTask.status === "archived" ? "archived" : anyRunning ? "running" : "idle",
        };
      });

      this.pendingTimers.delete(input.sessionId);
    }, 2_500);

    this.pendingTimers.set(input.sessionId, timer);
  }

  async stopAgent(input: TaskWorkspaceSessionInput): Promise<void> {
    this.assertSession(input.taskId, input.sessionId);
    const existing = this.pendingTimers.get(input.sessionId);
    if (existing) {
      clearTimeout(existing);
      this.pendingTimers.delete(input.sessionId);
    }

    this.updateTask(input.taskId, (currentTask) => {
      const updatedTabs = currentTask.sessions.map((candidate) =>
        candidate.id === input.sessionId ? { ...candidate, status: "idle" as const, thinkingSinceMs: null } : candidate,
      );
      const anyRunning = updatedTabs.some((candidate) => candidate.status === "running");

      return {
        ...currentTask,
        updatedAtMs: nowMs(),
        sessions: updatedTabs,
        status: currentTask.status === "archived" ? "archived" : anyRunning ? "running" : "idle",
      };
    });
  }

  async selectSession(input: TaskWorkspaceSessionInput): Promise<void> {
    this.assertSession(input.taskId, input.sessionId);
    this.updateTask(input.taskId, (currentTask) => ({
      ...currentTask,
      activeSessionId: input.sessionId,
    }));
  }

  async setSessionUnread(input: TaskWorkspaceSetSessionUnreadInput): Promise<void> {
    this.updateTask(input.taskId, (currentTask) => ({
      ...currentTask,
      sessions: currentTask.sessions.map((candidate) => (candidate.id === input.sessionId ? { ...candidate, unread: input.unread } : candidate)),
    }));
  }

  async renameSession(input: TaskWorkspaceRenameSessionInput): Promise<void> {
    const title = input.title.trim();
    if (!title) {
      throw new Error(`Cannot rename session ${input.sessionId} to an empty title`);
    }
    this.updateTask(input.taskId, (currentTask) => ({
      ...currentTask,
      sessions: currentTask.sessions.map((candidate) => (candidate.id === input.sessionId ? { ...candidate, sessionName: title } : candidate)),
    }));
  }

  async closeSession(input: TaskWorkspaceSessionInput): Promise<void> {
    this.updateTask(input.taskId, (currentTask) => {
      if (currentTask.sessions.length <= 1) {
        return currentTask;
      }

      return {
        ...currentTask,
        activeSessionId:
          currentTask.activeSessionId === input.sessionId
            ? (currentTask.sessions.find((candidate) => candidate.id !== input.sessionId)?.id ?? null)
            : currentTask.activeSessionId,
        sessions: currentTask.sessions.filter((candidate) => candidate.id !== input.sessionId),
      };
    });
  }

  async addSession(input: TaskWorkspaceSelectInput): Promise<TaskWorkspaceAddSessionResponse> {
    this.assertTask(input.taskId);
    const nextSessionId = uid();
    const nextSession: AgentSession = {
      id: nextSessionId,
      sessionId: nextSessionId,
      sandboxSessionId: null,
      sessionName: `Session ${this.requireTask(input.taskId).sessions.length + 1}`,
      agent: workspaceAgentForModel(DEFAULT_WORKSPACE_MODEL_ID, MODEL_GROUPS),
      model: DEFAULT_WORKSPACE_MODEL_ID,
      status: "idle",
      thinkingSinceMs: null,
      unread: false,
      created: false,
      draft: { text: "", attachments: [], updatedAtMs: null },
      transcript: [],
    };

    this.updateTask(input.taskId, (currentTask) => ({
      ...currentTask,
      updatedAtMs: nowMs(),
      activeSessionId: nextSession.id,
      sessions: [...currentTask.sessions, nextSession],
    }));
    return { sessionId: nextSession.id };
  }

  async changeModel(input: TaskWorkspaceChangeModelInput): Promise<void> {
    const group = MODEL_GROUPS.find((candidate) => candidate.models.some((entry) => entry.id === input.model));
    if (!group) {
      throw new Error(`Unable to resolve model provider for ${input.model}`);
    }

    this.updateTask(input.taskId, (currentTask) => ({
      ...currentTask,
      sessions: currentTask.sessions.map((candidate) =>
        candidate.id === input.sessionId ? { ...candidate, model: input.model, agent: workspaceAgentForModel(input.model, MODEL_GROUPS) } : candidate,
      ),
    }));
  }

  async changeOwner(input: { repoId: string; taskId: string; targetUserId: string; targetUserName: string; targetUserEmail: string }): Promise<void> {
    this.updateTask(input.taskId, (currentTask) => ({
      ...currentTask,
      primaryUserLogin: input.targetUserName,
      primaryUserAvatarUrl: null,
    }));
  }

  private updateState(updater: (current: TaskWorkspaceSnapshot) => TaskWorkspaceSnapshot): void {
    const nextSnapshot = updater(this.snapshot);
    this.snapshot = {
      ...nextSnapshot,
      repositories: groupWorkspaceRepositories(nextSnapshot.repos, nextSnapshot.tasks),
    };
    this.notify();
  }

  private updateTask(taskId: string, updater: (task: Task) => Task): void {
    this.assertTask(taskId);
    this.updateState((current) => ({
      ...current,
      tasks: current.tasks.map((task) => (task.id === taskId ? updater(task) : task)),
    }));
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private assertTask(taskId: string): void {
    this.requireTask(taskId);
  }

  private assertSession(taskId: string, sessionId: string): void {
    const task = this.requireTask(taskId);
    this.requireSession(task, sessionId);
  }

  private requireTask(taskId: string): Task {
    const task = this.snapshot.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Unable to find mock task ${taskId}`);
    }
    return task;
  }

  private requireSession(task: Task, sessionId: string): AgentSession {
    const session = task.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      throw new Error(`Unable to find mock session ${sessionId} in task ${task.id}`);
    }
    return session;
  }
}

function candidateEventIndex(task: Task, sessionId: string): number {
  const session = task.sessions.find((candidate) => candidate.id === sessionId);
  return (session?.transcript.length ?? 0) + 1;
}

let sharedMockWorkspaceClient: TaskWorkspaceClient | null = null;

export function getSharedMockWorkspaceClient(): TaskWorkspaceClient {
  if (!sharedMockWorkspaceClient) {
    sharedMockWorkspaceClient = new MockWorkspaceStore();
  }
  return sharedMockWorkspaceClient;
}
