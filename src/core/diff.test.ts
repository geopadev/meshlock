import { describe, it, expect } from "vitest";
import { diffContent } from "./diff.js";

describe("diffContent", () => {
  it("emits a unified diff with the removed and added lines", () => {
    const before = "line one\nline two\nline three\n";
    const after = "line one\nline two CHANGED\nline three\n";

    const diff = diffContent(before, after);

    // The body is what a briefing reads: the - old line and the + new line.
    expect(diff).toContain("-line two\n");
    expect(diff).toContain("+line two CHANGED\n");
    // It is git's format, so it carries the unified-diff hunk header.
    expect(diff).toContain("@@");
  });

  it("returns an empty string for identical inputs (git exit 0)", () => {
    const same = "no change here\n";
    expect(diffContent(same, same)).toBe("");
  });

  it("treats a brand-new file (empty baseline) as all additions", () => {
    // M3.5b will call this with an empty baseline for a freshly created file.
    const diff = diffContent("", "brand new content\n");
    expect(diff).toContain("+brand new content\n");
  });

  it("does not throw when the inputs differ (git exits 1, which is normal)", () => {
    // The whole point of using spawnSync over execFileSync: exit 1 is success.
    expect(() => diffContent("a\n", "b\n")).not.toThrow();
  });
});
