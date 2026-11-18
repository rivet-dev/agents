import { describe, expect, it } from "vitest";
import { sanitizeEditorTask } from "../src/task-editor.js";

describe("task editor helpers", () => {
  it("strips comment lines and trims whitespace", () => {
    const value = sanitizeEditorTask(`
# comment
Implement feature

# another comment
with more detail
`);

    expect(value).toBe("Implement feature\n\nwith more detail");
  });

  it("returns empty string when only comments are present", () => {
    const value = sanitizeEditorTask(`
# hello
# world
`);

    expect(value).toBe("");
  });
});
