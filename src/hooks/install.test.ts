import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_MARKER, installHook } from "./install.js";

let repoDir: string;
let hookPath: string;

beforeEach(async () => {
  // installHook only needs the .git directory shape — no real git required.
  repoDir = await mkdtemp(join(tmpdir(), "meshlock-install-"));
  await mkdir(join(repoDir, ".git", "hooks"), { recursive: true });
  hookPath = join(repoDir, ".git", "hooks", "pre-commit");
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe("installHook", () => {
  it("writes the shim: shebang, marker, PATH-relative exec line, mode 0755", async () => {
    const result = installHook(repoDir);

    expect(result.installed).toBe(true);
    if (result.installed) {
      expect(result.hookPath).toBe(hookPath);
      expect(result.replaced).toBe(false);
    }

    const content = await readFile(hookPath, "utf-8");
    expect(content.startsWith("#!/bin/sh\n")).toBe(true);
    expect(content).toContain(HOOK_MARKER);
    // PATH-relative `meshlock`, not an absolute node/dist path (M3.3b lesson).
    expect(content).toContain('exec meshlock hook pre-commit "$@"');

    const mode = (await stat(hookPath)).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("REFUSES to overwrite a foreign pre-commit hook and leaves it intact", async () => {
    const foreign = "#!/bin/sh\nexec someone-elses-linter\n";
    await writeFile(hookPath, foreign);

    const result = installHook(repoDir);

    expect(result.installed).toBe(false);
    if (!result.installed) {
      expect(result.reason).toContain("refusing to overwrite");
    }
    // Untouched, byte for byte.
    expect(await readFile(hookPath, "utf-8")).toBe(foreign);
  });

  it("is idempotent over its own marker (upgrade path overwrites)", async () => {
    expect(installHook(repoDir).installed).toBe(true);

    const second = installHook(repoDir);
    expect(second.installed).toBe(true);
    if (second.installed) expect(second.replaced).toBe(true);

    const content = await readFile(hookPath, "utf-8");
    expect(content).toContain(HOOK_MARKER);
    expect((await stat(hookPath)).mode & 0o777).toBe(0o755);
  });

  it("accepts the git dir itself (anything holding HEAD) as the target", async () => {
    await writeFile(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");

    const result = installHook(join(repoDir, ".git"));

    expect(result.installed).toBe(true);
    expect(await readFile(hookPath, "utf-8")).toContain(HOOK_MARKER);
  });

  it("refuses a directory that is not a git repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "meshlock-nogit-"));
    try {
      const result = installHook(plain);
      expect(result.installed).toBe(false);
      if (!result.installed) {
        expect(result.reason).toContain("not a git repository");
      }
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
