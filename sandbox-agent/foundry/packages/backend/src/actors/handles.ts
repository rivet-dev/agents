import { auditLogKey, githubDataKey, organizationKey, taskKey, taskSandboxKey, userKey } from "./keys.js";

export function actorClient(c: any) {
  return c.client();
}

export async function getOrCreateOrganization(c: any, organizationId: string) {
  return await actorClient(c).organization.getOrCreate(organizationKey(organizationId), {
    createWithInput: organizationId,
  });
}

export async function getOrCreateUser(c: any, userId: string) {
  return await actorClient(c).user.getOrCreate(userKey(userId), {
    createWithInput: { userId },
  });
}

export function getUser(c: any, userId: string) {
  return actorClient(c).user.get(userKey(userId));
}

export function getTask(c: any, organizationId: string, repoId: string, taskId: string) {
  return actorClient(c).task.get(taskKey(organizationId, repoId, taskId));
}

export async function getOrCreateTask(c: any, organizationId: string, repoId: string, taskId: string, createWithInput: Record<string, unknown>) {
  return await actorClient(c).task.getOrCreate(taskKey(organizationId, repoId, taskId), {
    createWithInput,
  });
}

export async function getOrCreateAuditLog(c: any, organizationId: string) {
  return await actorClient(c).auditLog.getOrCreate(auditLogKey(organizationId), {
    createWithInput: {
      organizationId,
    },
  });
}

export async function getOrCreateGithubData(c: any, organizationId: string) {
  return await actorClient(c).githubData.getOrCreate(githubDataKey(organizationId), {
    createWithInput: {
      organizationId,
    },
  });
}

export function getGithubData(c: any, organizationId: string) {
  return actorClient(c).githubData.get(githubDataKey(organizationId));
}

export function getTaskSandbox(c: any, organizationId: string, sandboxId: string) {
  return actorClient(c).taskSandbox.get(taskSandboxKey(organizationId, sandboxId));
}

export async function getOrCreateTaskSandbox(c: any, organizationId: string, sandboxId: string, createWithInput?: Record<string, unknown>) {
  return await actorClient(c).taskSandbox.getOrCreate(taskSandboxKey(organizationId, sandboxId), {
    createWithInput,
  });
}

export function selfAuditLog(c: any) {
  return actorClient(c).auditLog.getForId(c.actorId);
}

export function selfTask(c: any) {
  return actorClient(c).task.getForId(c.actorId);
}

export function selfOrganization(c: any) {
  return actorClient(c).organization.getForId(c.actorId);
}

export function selfUser(c: any) {
  return actorClient(c).user.getForId(c.actorId);
}

export function selfGithubData(c: any) {
  return actorClient(c).githubData.getForId(c.actorId);
}

export function selfTaskSandbox(c: any) {
  return actorClient(c).taskSandbox.getForId(c.actorId);
}
