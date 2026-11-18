import type { BackendDriver, GithubDriver, TmuxDriver } from "../../src/driver.js";

export function createTestDriver(overrides?: Partial<BackendDriver>): BackendDriver {
  return {
    github: overrides?.github ?? createTestGithubDriver(),
    tmux: overrides?.tmux ?? createTestTmuxDriver(),
  };
}

export function createTestGithubDriver(overrides?: Partial<GithubDriver>): GithubDriver {
  return {
    createPr: async (_repoFullName, _headBranch, _title) => ({
      number: 1,
      url: `https://github.com/test/repo/pull/1`,
    }),
    starRepository: async () => {},
    ...overrides,
  };
}

export function createTestTmuxDriver(overrides?: Partial<TmuxDriver>): TmuxDriver {
  return {
    setWindowStatus: () => 0,
    ...overrides,
  };
}
