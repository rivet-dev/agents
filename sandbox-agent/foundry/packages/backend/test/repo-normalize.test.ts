import { describe, expect, test } from "vitest";
import { normalizeRemoteUrl, repoIdFromRemote } from "../src/services/repo.js";

describe("normalizeRemoteUrl", () => {
  test("accepts GitHub shorthand owner/repo", () => {
    expect(normalizeRemoteUrl("rivet-dev/sandbox-agent")).toBe("https://github.com/rivet-dev/sandbox-agent.git");
  });

  test("accepts github.com/owner/repo without scheme", () => {
    expect(normalizeRemoteUrl("github.com/rivet-dev/sandbox-agent")).toBe("https://github.com/rivet-dev/sandbox-agent.git");
  });

  test("canonicalizes GitHub repo URLs without .git", () => {
    expect(normalizeRemoteUrl("https://github.com/rivet-dev/sandbox-agent")).toBe("https://github.com/rivet-dev/sandbox-agent.git");
  });

  test("canonicalizes GitHub non-clone URLs (e.g. /tree/main)", () => {
    expect(normalizeRemoteUrl("https://github.com/rivet-dev/sandbox-agent/tree/main")).toBe("https://github.com/rivet-dev/sandbox-agent.git");
  });

  test("does not rewrite scp-style ssh remotes", () => {
    expect(normalizeRemoteUrl("git@github.com:rivet-dev/sandbox-agent.git")).toBe("git@github.com:rivet-dev/sandbox-agent.git");
  });
});

describe("repoIdFromRemote", () => {
  test("repoId is stable across equivalent GitHub inputs", () => {
    const a = repoIdFromRemote("rivet-dev/sandbox-agent");
    const b = repoIdFromRemote("https://github.com/rivet-dev/sandbox-agent.git");
    const c = repoIdFromRemote("https://github.com/rivet-dev/sandbox-agent/tree/main");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
