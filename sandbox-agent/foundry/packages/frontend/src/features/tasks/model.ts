import type { TaskRecord } from "@sandbox-agent/foundry-shared";

export interface RepoGroup {
  repoId: string;
  repoRemote: string;
  tasks: TaskRecord[];
}

export function groupTasksByRepo(tasks: TaskRecord[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();

  for (const task of tasks) {
    const group = groups.get(task.repoId);
    if (group) {
      group.tasks.push(task);
      continue;
    }

    groups.set(task.repoId, {
      repoId: task.repoId,
      repoRemote: task.repoRemote,
      tasks: [task],
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      tasks: [...group.tasks].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => {
      const aLatest = a.tasks[0]?.updatedAt ?? 0;
      const bLatest = b.tasks[0]?.updatedAt ?? 0;
      if (aLatest !== bLatest) {
        return bLatest - aLatest;
      }
      return a.repoRemote.localeCompare(b.repoRemote);
    });
}
