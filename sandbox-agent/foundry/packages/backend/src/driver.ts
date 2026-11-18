import { createPr, starRepository } from "./integrations/github/index.js";

export interface GithubDriver {
  createPr(
    repoFullName: string,
    headBranch: string,
    title: string,
    body?: string,
    options?: { githubToken?: string | null; baseBranch?: string | null },
  ): Promise<{ number: number; url: string }>;
  starRepository(repoFullName: string, options?: { githubToken?: string | null }): Promise<void>;
}

export interface TmuxDriver {
  setWindowStatus(branchName: string, status: string): number;
}

export interface BackendDriver {
  github: GithubDriver;
  tmux: TmuxDriver;
}

export function createDefaultDriver(): BackendDriver {
  return {
    github: {
      createPr,
      starRepository,
    },
    tmux: {
      setWindowStatus: () => 0,
    },
  };
}
