export type ActorKey = string[];

export function organizationKey(organizationId: string): ActorKey {
  return ["org", organizationId];
}

export function userKey(userId: string): ActorKey {
  return ["org", "app", "user", userId];
}

export function taskKey(organizationId: string, repoId: string, taskId: string): ActorKey {
  return ["org", organizationId, "task", repoId, taskId];
}

export function taskSandboxKey(organizationId: string, sandboxId: string): ActorKey {
  return ["org", organizationId, "sandbox", sandboxId];
}

/** One audit log per org (not per repo) — see audit-log/index.ts for rationale. */
export function auditLogKey(organizationId: string): ActorKey {
  return ["org", organizationId, "audit-log"];
}

export function githubDataKey(organizationId: string): ActorKey {
  return ["org", organizationId, "github-data"];
}
