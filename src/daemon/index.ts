import type { MeshLockDatabase } from "../core/db.js";
import { classifyEvent } from "./classify.js";
import { createWatcher } from "./watcher.js";

/**
 * Everything the daemon needs, injected (the engine's DI discipline): no
 * config reads, no path resolution, no globals in here. The CLI layer (which
 * owns process concerns) assembles these once at startup.
 */
export interface DaemonDeps {
  db: MeshLockDatabase;
  /** The repo this daemon guards — resolved ONCE by the caller. */
  repoRoot: string;
  /**
   * Where warning lines go, one call per line (no trailing newline). Default
   * writes to stderr — stdout stays clean by project discipline. Injectable so
   * tests collect lines in an array instead of capturing real stderr.
   */
  sink?: (line: string) => void;
}

/** Handle returned by {@link startDaemon}. */
export interface DaemonHandle {
  /** Resolves when the underlying watcher's initial scan is done. */
  ready: Promise<void>;
  /** Stop watching. Does NOT close the DB or the process — the caller owns those. */
  close(): Promise<void>;
}

/**
 * Compose watcher → classify → policy into a running detector.
 *
 * Policy (M4.3):
 *  - unguarded event → ONE warning line: the flag this daemon exists to raise.
 *  - guarded event   → silence. It is the expected steady state, and logging
 *    it would bury the unguarded signal in noise.
 *  - watcher error   → one line, keep running. A transient fs hiccup must not
 *    kill a long-running detector.
 *
 * No process.exit and no signal handling in here — the factory runs anywhere
 * (tests included); process lifecycle belongs to the CLI layer.
 */
export function startDaemon(deps: DaemonDeps): DaemonHandle {
  const sink =
    deps.sink ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });

  const watcher = createWatcher(
    deps.repoRoot,
    (event) => {
      const verdict = classifyEvent(deps.db, deps.repoRoot, event);
      if (verdict.kind === "unguarded") {
        sink(
          `[meshlock] UNGUARDED ${event.type} ${event.at} ${event.path} (no live lock)`
        );
      }
      // guarded: deliberately silent.
    },
    {
      onError: (err) => {
        const detail = err instanceof Error ? err.message : String(err);
        sink(`[meshlock] watcher error: ${detail} — still watching`);
      },
    }
  );

  return {
    ready: watcher.ready,
    close: (): Promise<void> => watcher.close(),
  };
}
