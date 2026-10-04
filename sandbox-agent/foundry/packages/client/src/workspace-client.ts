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
import type { BackendClient } from "./backend-client.js";
import { getSharedMockWorkspaceClient } from "./mock/workspace-client.js";
import { createRemoteWorkspaceClient } from "./remote/workspace-client.js";

export type TaskWorkspaceClientMode = "mock" | "remote";

export interface CreateTaskWorkspaceClientOptions {
  mode: TaskWorkspaceClientMode;
  backend?: BackendClient;
  organizationId?: string;
}

export interface TaskWorkspaceClient {
  getSnapshot(): TaskWorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
  createTask(input: TaskWorkspaceCreateTaskInput): Promise<TaskWorkspaceCreateTaskResponse>;
  markTaskUnread(input: TaskWorkspaceSelectInput): Promise<void>;
  renameTask(input: TaskWorkspaceRenameInput): Promise<void>;
  archiveTask(input: TaskWorkspaceSelectInput): Promise<void>;
  publishPr(input: TaskWorkspaceSelectInput): Promise<void>;
  revertFile(input: TaskWorkspaceDiffInput): Promise<void>;
  updateDraft(input: TaskWorkspaceUpdateDraftInput): Promise<void>;
  sendMessage(input: TaskWorkspaceSendMessageInput): Promise<void>;
  stopAgent(input: TaskWorkspaceSessionInput): Promise<void>;
  selectSession(input: TaskWorkspaceSessionInput): Promise<void>;
  setSessionUnread(input: TaskWorkspaceSetSessionUnreadInput): Promise<void>;
  renameSession(input: TaskWorkspaceRenameSessionInput): Promise<void>;
  closeSession(input: TaskWorkspaceSessionInput): Promise<void>;
  addSession(input: TaskWorkspaceSelectInput): Promise<TaskWorkspaceAddSessionResponse>;
  changeModel(input: TaskWorkspaceChangeModelInput): Promise<void>;
  changeOwner(input: TaskWorkspaceChangeOwnerInput): Promise<void>;
}

export function createTaskWorkspaceClient(options: CreateTaskWorkspaceClientOptions): TaskWorkspaceClient {
  if (options.mode === "mock") {
    return getSharedMockWorkspaceClient();
  }

  if (!options.backend) {
    throw new Error("Remote task workspace client requires a backend client");
  }
  if (!options.organizationId) {
    throw new Error("Remote task workspace client requires a organization id");
  }

  return createRemoteWorkspaceClient({
    backend: options.backend,
    organizationId: options.organizationId,
  });
}
