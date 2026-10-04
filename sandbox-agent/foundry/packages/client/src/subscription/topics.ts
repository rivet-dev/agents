import type {
  AppEvent,
  FoundryAppSnapshot,
  SandboxProviderId,
  SandboxProcessesEvent,
  SessionEvent,
  TaskEvent,
  WorkspaceSessionDetail,
  WorkspaceTaskDetail,
  OrganizationEvent,
  OrganizationSummarySnapshot,
} from "@sandbox-agent/foundry-shared";
import type { ActorConn, BackendClient, SandboxProcessRecord } from "../backend-client.js";

/**
 * Topic definitions for the subscription manager.
 *
 * Each topic describes one actor connection plus one materialized read model.
 * Some topics can apply broadcast payloads directly, while others refetch
 * through BackendClient so auth-scoped state stays user-specific.
 */
export interface TopicDefinition<TData, TParams, TEvent> {
  key: (params: TParams) => string;
  event: string;
  connect: (backend: BackendClient, params: TParams) => Promise<ActorConn>;
  fetchInitial: (backend: BackendClient, params: TParams) => Promise<TData>;
  applyEvent: (backend: BackendClient, params: TParams, current: TData, event: TEvent) => Promise<TData> | TData;
}

export interface AppTopicParams {}
export interface OrganizationTopicParams {
  organizationId: string;
}
export interface TaskTopicParams {
  organizationId: string;
  repoId: string;
  taskId: string;
}
export interface SessionTopicParams {
  organizationId: string;
  repoId: string;
  taskId: string;
  sessionId: string;
}
export interface SandboxProcessesTopicParams {
  organizationId: string;
  sandboxProviderId: SandboxProviderId;
  sandboxId: string;
}

export const topicDefinitions = {
  app: {
    key: () => "app",
    event: "appUpdated",
    connect: (backend: BackendClient, _params: AppTopicParams) => backend.connectOrganization("app"),
    fetchInitial: (backend: BackendClient, _params: AppTopicParams) => backend.getAppSnapshot(),
    applyEvent: (_backend: BackendClient, _params: AppTopicParams, _current: FoundryAppSnapshot, event: AppEvent) => event.snapshot,
  } satisfies TopicDefinition<FoundryAppSnapshot, AppTopicParams, AppEvent>,

  organization: {
    key: (params: OrganizationTopicParams) => `organization:${params.organizationId}`,
    event: "organizationUpdated",
    connect: (backend: BackendClient, params: OrganizationTopicParams) => backend.connectOrganization(params.organizationId),
    fetchInitial: (backend: BackendClient, params: OrganizationTopicParams) => backend.getOrganizationSummary(params.organizationId),
    applyEvent: (_backend: BackendClient, _params: OrganizationTopicParams, _current: OrganizationSummarySnapshot, event: OrganizationEvent) => event.snapshot,
  } satisfies TopicDefinition<OrganizationSummarySnapshot, OrganizationTopicParams, OrganizationEvent>,

  task: {
    key: (params: TaskTopicParams) => `task:${params.organizationId}:${params.taskId}`,
    event: "taskUpdated",
    connect: (backend: BackendClient, params: TaskTopicParams) => backend.connectTask(params.organizationId, params.repoId, params.taskId),
    fetchInitial: (backend: BackendClient, params: TaskTopicParams) => backend.getTaskDetail(params.organizationId, params.repoId, params.taskId),
    applyEvent: (backend: BackendClient, params: TaskTopicParams, _current: WorkspaceTaskDetail, _event: TaskEvent) =>
      backend.getTaskDetail(params.organizationId, params.repoId, params.taskId),
  } satisfies TopicDefinition<WorkspaceTaskDetail, TaskTopicParams, TaskEvent>,

  session: {
    key: (params: SessionTopicParams) => `session:${params.organizationId}:${params.taskId}:${params.sessionId}`,
    event: "sessionUpdated",
    connect: (backend: BackendClient, params: SessionTopicParams) => backend.connectTask(params.organizationId, params.repoId, params.taskId),
    fetchInitial: (backend: BackendClient, params: SessionTopicParams) =>
      backend.getSessionDetail(params.organizationId, params.repoId, params.taskId, params.sessionId),
    applyEvent: async (backend: BackendClient, params: SessionTopicParams, current: WorkspaceSessionDetail, event: SessionEvent) => {
      if (event.session.sessionId !== params.sessionId) {
        return current;
      }
      return await backend.getSessionDetail(params.organizationId, params.repoId, params.taskId, params.sessionId);
    },
  } satisfies TopicDefinition<WorkspaceSessionDetail, SessionTopicParams, SessionEvent>,

  sandboxProcesses: {
    key: (params: SandboxProcessesTopicParams) => `sandbox:${params.organizationId}:${params.sandboxProviderId}:${params.sandboxId}`,
    event: "processesUpdated",
    connect: (backend: BackendClient, params: SandboxProcessesTopicParams) =>
      backend.connectSandbox(params.organizationId, params.sandboxProviderId, params.sandboxId),
    fetchInitial: async (backend: BackendClient, params: SandboxProcessesTopicParams) =>
      (await backend.listSandboxProcesses(params.organizationId, params.sandboxProviderId, params.sandboxId)).processes,
    applyEvent: (_backend: BackendClient, _params: SandboxProcessesTopicParams, _current: SandboxProcessRecord[], event: SandboxProcessesEvent) =>
      event.processes,
  } satisfies TopicDefinition<SandboxProcessRecord[], SandboxProcessesTopicParams, SandboxProcessesEvent>,
} as const;

export type TopicKey = keyof typeof topicDefinitions;
export type TopicParams<K extends TopicKey> = Parameters<(typeof topicDefinitions)[K]["fetchInitial"]>[1];
export type TopicData<K extends TopicKey> = Awaited<ReturnType<(typeof topicDefinitions)[K]["fetchInitial"]>>;
