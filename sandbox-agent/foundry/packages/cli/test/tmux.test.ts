import { describe, expect, it } from "vitest";
import { stripStatusPrefix } from "../src/tmux.js";

describe("tmux helpers", () => {
  it("strips running and idle markers from window names", () => {
    expect(stripStatusPrefix("▶ feature/auth")).toBe("feature/auth");
    expect(stripStatusPrefix("✓ feature/auth")).toBe("feature/auth");
    expect(stripStatusPrefix("feature/auth")).toBe("feature/auth");
  });
});
