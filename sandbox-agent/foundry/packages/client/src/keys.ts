export type ActorKey = string[];

export function organizationKey(organizationId: string): ActorKey {
  return ["org", organizationId];
}

export function taskKey(organizationId: string, repoId: string, taskId: string): ActorKey {
  return ["org", organizationId, "task", repoId, taskId];
}

export function taskSandboxKey(organizationId: string, sandboxId: string): ActorKey {
  return ["org", organizationId, "sandbox", sandboxId];
}

export function auditLogKey(organizationId: string): ActorKey {
  return ["org", organizationId, "audit-log"];
}
