import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type MeshLockDatabase } from "../core/db.js";
import { acquireLock } from "../core/lock-engine.js";
import { DEFAULT_DEBOUNCE_MS } from "./watcher.js";
import { startDaemon, type DaemonHandle } from "./index.js";

// Two SEPARATE temp dirs: the watched tree and the DB's home. The DB must live
// OUTSIDE the watched tree, or every SQLite/WAL write would itself fire watch
// events — the self-feeding loop the .meshlock default-ignore exists to prevent.
let watchDir: string;
let dbDir: string;
let db: MeshLockDatabase;
let lines: string[];
let handle: DaemonHandle | undefined;

const SESSION = "99999999-9999-4999-8999-999999999999";

beforeEach(async () => {
  watchDir = await mkdtemp(join(tmpdir(), "meshlock-daemon-watch-"));
  dbDir = await mkdtemp(join(tmpdir(), "meshlock-daemon-db-"));
  db = openDatabase(join(dbDir, "test.db"));
  lines = [];
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  db.close();
  await rm(watchDir, { recursive: true, force: true });
  await rm(dbDir, { recursive: true, force: true });
});

/** Start the daemon over watchDir, collecting sink lines; awaits readiness. */
async function start(): Promise<void> {
  handle = startDaemon({ db, repoRoot: watchDir, sink: (l) => lines.push(l) });
  await handle.ready;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(20);
  }
}

describe("startDaemon", () => {
  it("emits exactly one UNGUARDED line for a write to an unlocked path", async () => {
    await start();

    const path = join(watchDir, "unlocked.ts");
    await writeFile(path, "nobody holds me\n");
    await waitFor(() => lines.length >= 1);
    await sleep(DEFAULT_DEBOUNCE_MS * 3); // stragglers would betray a double-fire

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("UNGUARDED");
    expect(lines[0]).toContain("add");
    expect(lines[0]).toContain(path);
  });

  it("stays silent for a write to a live-locked path", async () => {
    const locked = join(watchDir, "locked.ts");
    await writeFile(locked, "v1\n"); // exists pre-start: the edit is a change
    acquireLock(db, {
      repoRoot: watchDir,
      path: locked,
      sessionId: SESSION,
      mode: "exclusive",
      timeoutSeconds: 1800,
    });
    await start();

    await writeFile(locked, "v2\n");
    // Control: an unlocked write must produce a line — proving the pipeline is
    // alive, so silence about `locked` means "guarded", not "daemon broken".
    const control = join(watchDir, "control.ts");
    await writeFile(control, "flag me\n");
    await waitFor(() => lines.length >= 1);
    await sleep(DEFAULT_DEBOUNCE_MS * 3);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(control);
    expect(lines.some((l) => l.includes(locked))).toBe(false);
  });

  it("surfaces a watcher error as one line and keeps running", async () => {
    // Unreadable subdir → EACCES during chokidar's initial scan (see
    // watcher.test.ts — verified deterministic against the installed chokidar).
    const noperm = join(watchDir, "noperm");
    await mkdir(noperm);
    await chmod(noperm, 0o000);

    try {
      await start();
      await waitFor(() => lines.some((l) => l.includes("watcher error")));

      // Still running: an unguarded write still gets flagged.
      const alive = join(watchDir, "alive.ts");
      await writeFile(alive, "post-error\n");
      await waitFor(() => lines.some((l) => l.includes(alive)));
    } finally {
      await chmod(noperm, 0o755); // let afterEach's rm traverse it
    }
  });

  it("emits nothing after close()", async () => {
    await start();
    await handle!.close();

    await writeFile(join(watchDir, "late.ts"), "after close\n");
    await sleep(DEFAULT_DEBOUNCE_MS * 4);

    expect(lines).toHaveLength(0);
  });
});
