import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWatcher,
  DEFAULT_DEBOUNCE_MS,
  type WatchEvent,
  type WatcherHandle,
} from "./watcher.js";

let tempDir: string;
let events: WatchEvent[];
let handle: WatcherHandle | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-watcher-test-"));
  events = [];
});

afterEach(async () => {
  // Always tear the watcher down BEFORE deleting its root — a leaked watcher
  // keeps the suite's event loop alive (open-handle warning).
  await handle?.close();
  handle = undefined;
  await rm(tempDir, { recursive: true, force: true });
});

/** Start watching tempDir, collecting events; resolves when chokidar is ready. */
async function start(ignore?: string[]): Promise<void> {
  handle = createWatcher(tempDir, (e) => events.push(e), { ignore });
  await handle.ready;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` holds, failing loudly on timeout. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(20);
  }
}

/** Wait for at least one event, then a quiet period to let any stragglers land. */
async function settle(): Promise<void> {
  await waitFor(() => events.length >= 1);
  await sleep(DEFAULT_DEBOUNCE_MS * 3);
}

describe("createWatcher", () => {
  it("fires exactly one normalized change event for a single write", async () => {
    const file = join(tempDir, "watched.ts");
    await writeFile(file, "before\n"); // exists pre-start: no add replay
    await start();

    await writeFile(file, "after\n");
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("change");
    expect(events[0]!.path).toBe(file);
    // `at` is a real ISO-8601 timestamp.
    expect(Number.isNaN(Date.parse(events[0]!.at))).toBe(false);
  });

  it("coalesces a burst of rapid writes to one path into a single event", async () => {
    const file = join(tempDir, "bursty.ts");
    await writeFile(file, "v0\n");
    await start();

    // Back-to-back sync writes — the shape of an editor save burst. Every raw
    // event restarts the debounce timer, so only ONE event may emerge.
    for (let i = 1; i <= 5; i++) {
      writeFileSync(file, `v${String(i)}\n`);
    }
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("change");
    expect(events[0]!.path).toBe(file);
  });

  it("fires add for a new file and unlink for a deleted one", async () => {
    const existing = join(tempDir, "doomed.ts");
    await writeFile(existing, "bye\n");
    await start();

    const created = join(tempDir, "fresh.ts");
    await writeFile(created, "hi\n");
    await waitFor(() => events.some((e) => e.type === "add"));

    await rm(existing);
    await waitFor(() => events.some((e) => e.type === "unlink"));
    await sleep(DEFAULT_DEBOUNCE_MS * 3);

    expect(events).toHaveLength(2);
    expect(events.find((e) => e.type === "add")!.path).toBe(created);
    expect(events.find((e) => e.type === "unlink")!.path).toBe(existing);
  });

  it("stays silent for writes under ignored directories", async () => {
    await mkdir(join(tempDir, ".git"));
    await mkdir(join(tempDir, "node_modules"));
    await start();

    await writeFile(join(tempDir, ".git", "HEAD"), "ref: nowhere\n");
    await writeFile(join(tempDir, "node_modules", "pkg.js"), "module\n");
    // Control write: proves the watcher is alive, so "no ignored events" means
    // "ignored", not "watcher broken".
    const control = join(tempDir, "control.ts");
    await writeFile(control, "seen\n");
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0]!.path).toBe(control);
  });

  it("emits nothing after close()", async () => {
    const file = join(tempDir, "late.ts");
    await writeFile(file, "before\n");
    await start();

    await handle!.close();
    await writeFile(file, "after\n");
    await sleep(DEFAULT_DEBOUNCE_MS * 4);

    expect(events).toHaveLength(0);
  });
});
