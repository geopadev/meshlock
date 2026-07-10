import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalizePath } from "./paths.js";

let tempDir: string;
let realDir: string; // canonical form of tempDir/real
let linkDir: string; // tempDir/alias -> tempDir/real

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-paths-test-"));
  await mkdir(join(tempDir, "real"));
  await symlink(join(tempDir, "real"), join(tempDir, "alias"));
  // realpath() the base too: the OS tmp dir itself may be a symlink (macOS
  // /tmp -> /private/tmp), and expected values must be fully canonical.
  realDir = await realpath(join(tempDir, "real"));
  linkDir = join(tempDir, "alias");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("canonicalizePath", () => {
  it("resolves an existing file reached through a symlinked directory", async () => {
    await writeFile(join(realDir, "file.ts"), "content\n");

    const canonical = canonicalizePath(join(linkDir, "file.ts"));

    expect(canonical).toBe(join(realDir, "file.ts"));
  });

  it("resolves a MISSING file under a symlinked directory via its parent", () => {
    // The file does not exist (about to be created) — tier 2: the parent's
    // realpath fixes the aliased prefix, the basename rides along.
    const canonical = canonicalizePath(join(linkDir, "ghost.ts"));

    expect(canonical).toBe(join(realDir, "ghost.ts"));
  });

  it("falls back to resolve() for a fully missing path and never throws", () => {
    const missing = "/no/such/dir/anywhere/file.ts";

    expect(() => canonicalizePath(missing)).not.toThrow();
    expect(canonicalizePath(missing)).toBe(resolve(missing));
  });
});
