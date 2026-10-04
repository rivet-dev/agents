import type {
  TaskWorkspaceAddSessionResponse,
  TaskWorkspaceChangeModelInput,
  TaskWorkspaceChangeOwnerInput,
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
} from "@sandbox-agent/foundry-shared";
import type { BackendClient } from "../backend-client.js";
import { groupWorkspaceRepositories } from "../workspace-model.js";
import type { TaskWorkspaceClient } from "../workspace-client.js";

export interface RemoteWorkspaceClientOptions {
  backend: BackendClient;
  organizationId: string;
}

class RemoteWorkspaceStore implements TaskWorkspaceClient {
  private readonly backend: BackendClient;
  private readonly organizationId: string;
  private snapshot: TaskWorkspaceSnapshot;
  private readonly listeners = new Set<() => void>();
  private unsubscribeWorkspace: (() => void) | null = null;
  private refreshPromise: Promise<void> | null = null;
  private refreshRetryTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RemoteWorkspaceClientOptions) {
    this.backend = options.backend;
    this.organizationId = options.organizationId;
    this.snapshot = {
      organizationId: options.organizationId,
      repos: [],
      repositories: [],
      tasks: [],
    };
  }

  getSnapshot(): TaskWorkspaceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.ensureStarted();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.refreshRetryTimeout) {
        clearTimeout(this.refreshRetryTimeout);
        this.refreshRetryTimeout = null;
      }
      if (this.listeners.size === 0 && this.unsubscribeWorkspace) {
        this.unsubscribeWorkspace();
        this.unsubscribeWorkspace = null;
      }
    };
  }

  async createTask(input: TaskWorkspaceCreateTaskInput): Promise<TaskWorkspaceCreateTaskResponse> {
    const created = await this.backend.createWorkspaceTask(this.organizationId, input);
    await this.refresh();
    return created;
  }

  async markTaskUnread(input: TaskWorkspaceSelectInput): Promise<void> {
    await this.backend.markWorkspaceUnread(this.organizationId, input);
    await this.refresh();
  }

  async renameTask(input: TaskWorkspaceRenameInput): Promise<void> {
    await this.backend.renameWorkspaceTask(this.organizationId, input);
    await this.refresh();
  }

  async archiveTask(input: TaskWorkspaceSelectInput): Promise<void> {
    await this.backend.runAction(this.organizationId, input.repoId, input.taskId, "archive");
    await this.refresh();
  }

  async publishPr(input: TaskWorkspaceSelectInput): Promise<void> {
    await this.backend.publishWorkspacePr(this.organizationId, input);
    await this.refresh();
  }

  async revertFile(input: TaskWorkspaceDiffInput): Promise<void> {
    await this.backend.revertWorkspaceFile(this.organizationId, input);
    await this.refresh();
  }

  async updateDraft(input: TaskWorkspaceUpdateDraftInput): Promise<void> {
    await this.backend.updateWorkspaceDraft(this.organizationId, input);
    // Skip refresh — the server broadcast will trigger it, and the frontend
    // holds local draft state to avoid the round-trip overwriting user input.
  }

  async sendMessage(input: TaskWorkspaceSendMessageInput): Promise<void> {
    await this.backend.sendWorkspaceMessage(this.organizationId, input);
    await this.refresh();
  }

  async stopAgent(input: TaskWorkspaceSessionInput): Promise<void> {
    await this.backend.stopWorkspaceSession(this.organizationId, input);
    await this.refresh();
  }

  async selectSession(input: TaskWorkspaceSessionInput): Promise<void> {
    await this.backend.selectWorkspaceSession(this.organizationId, input);
    await this.refresh();
  }

  async setSessionUnread(input: TaskWorkspaceSetSessionUnreadInput): Promise<void> {
    await this.backend.setWorkspaceSessionUnread(this.organizationId, input);
    await this.refresh();
  }

  async renameSession(input: TaskWorkspaceRenameSessionInput): Promise<void> {
    await this.backend.renameWorkspaceSession(this.organizationId, input);
    await this.refresh();
  }

  async closeSession(input: TaskWorkspaceSessionInput): Promise<void> {
    await this.backend.closeWorkspaceSession(this.organizationId, input);
    await this.refresh();
  }

  async addSession(input: TaskWorkspaceSelectInput): Promise<TaskWorkspaceAddSessionResponse> {
    const created = await this.backend.createWorkspaceSession(this.organizationId, input);
    await this.refresh();
    return created;
  }

  async changeModel(input: TaskWorkspaceChangeModelInput): Promise<void> {
    await this.backend.changeWorkspaceModel(this.organizationId, input);
    await this.refresh();
  }

  async changeOwner(input: TaskWorkspaceChangeOwnerInput): Promise<void> {
    await this.backend.changeWorkspaceTaskOwner(this.organizationId, input);
    await this.refresh();
  }

  private ensureStarted(): void {
    if (!this.unsubscribeWorkspace) {
      this.unsubscribeWorkspace = this.backend.subscribeWorkspace(this.organizationId, () => {
        void this.refresh().catch(() => {
          this.scheduleRefreshRetry();
        });
      });
    }
    void this.refresh().catch(() => {
      this.scheduleRefreshRetry();
    });
  }

  private scheduleRefreshRetry(): void {
    if (this.refreshRetryTimeout || this.listeners.size === 0) {
      return;
    }

    this.refreshRetryTimeout = setTimeout(() => {
      this.refreshRetryTimeout = null;
      void this.refresh().catch(() => {
        this.scheduleRefreshRetry();
      });
    }, 1_000);
  }

  private async refresh(): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = (async () => {
      const nextSnapshot = await this.backend.getWorkspace(this.organizationId);
      if (this.refreshRetryTimeout) {
        clearTimeout(this.refreshRetryTimeout);
        this.refreshRetryTimeout = null;
      }
      this.snapshot = {
        ...nextSnapshot,
        repositories: nextSnapshot.repositories ?? groupWorkspaceRepositories(nextSnapshot.repos, nextSnapshot.tasks),
      };
      for (const listener of [...this.listeners]) {
        listener();
      }
    })().finally(() => {
      this.refreshPromise = null;
    });

    await this.refreshPromise;
  }
}

export function createRemoteWorkspaceClient(options: RemoteWorkspaceClientOptions): TaskWorkspaceClient {
  return new RemoteWorkspaceStore(options);
}
