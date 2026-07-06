import { watch } from "chokidar";

/**
 * The three filesystem happenings MeshLock cares about. Directory events and
 * chokidar's richer vocabulary are deliberately not surfaced — the daemon
 * reasons about files.
 */
export type WatchEventType = "add" | "change" | "unlink";

/**
 * One normalized filesystem event. `path` is absolute (chokidar echoes the
 * absolute root it was given); `at` is ISO-8601 UTC, the same timestamp format
 * as every other MeshLock record.
 */
export interface WatchEvent {
  type: WatchEventType;
  path: string;
  at: string;
}

/** Callback invoked once per debounced event. */
export type OnWatchEvent = (event: WatchEvent) => void;

export interface WatcherOptions {
  /** Debounce window in ms — events on one path within it coalesce. Default 100. */
  debounceMs?: number;
  /**
   * Path SEGMENTS to ignore (a file is ignored if any segment of its path
   * matches an entry exactly). REPLACES the defaults when given.
   */
  ignore?: string[];
  /**
   * Called when chokidar reports an error (vanished file mid-scan, permission
   * refusal, …). The watch itself keeps running. Default: absorb silently —
   * the M4.1 behaviour, so existing callers are unaffected; the daemon (M4.3)
   * injects its own to surface one line per error.
   */
  onError?: (err: unknown) => void;
}

/** Handle returned by {@link createWatcher}. */
export interface WatcherHandle {
  /** Resolves once chokidar's initial scan is done and events are trustworthy. */
  ready: Promise<void>;
  /** Stop watching: cancels pending (unemitted) debounced events, then closes. */
  close(): Promise<void>;
}

// 200, not 100: chokidar's atomic mode delays cross-process unlink delivery by
// ~100ms (its atomic-save detection), so a touch-then-rm transient straddled a
// 100ms window and emitted add+unlink instead of cancelling (observed live in
// M4.3's e2e). 200ms re-captures the pair so the add→unlink cancel fires.
export const DEFAULT_DEBOUNCE_MS = 200;

/**
 * Segment names ignored by default: VCS internals, dependency trees, and the
 * MeshLock data dir (~/.meshlock) — watching our own SQLite/WAL writes would
 * make the daemon feed on its own output. Matched by segment NAME so the
 * watcher stays config-free (it never resolves the actual DB path).
 */
export const DEFAULT_IGNORE = [".git", "node_modules", ".meshlock"];

/**
 * Wrap chokidar into a debounced, normalized event source. Pure sensor: it
 * knows files, not locks — no DB, no config, no MeshLock domain logic. Root and
 * callback are injected (the engine's DI discipline), so tests point it at a
 * temp dir and collect events in an array.
 *
 * Debounce: editors and tools write in bursts (write + truncate + metadata,
 * or several saves in quick succession). Each raw chokidar event for a path
 * (re)starts that path's timer; only when a path has been quiet for
 * `debounceMs` does ONE normalized event fire. Timers are per-path, so a busy
 * file never suppresses events for a different file. Within one window the
 * LAST event type wins, with one refinement: add followed by change is still
 * an "add" (the file is new to observers; the trailing change is part of its
 * creation burst).
 */
export function createWatcher(
  root: string,
  onEvent: OnWatchEvent,
  options: WatcherOptions = {}
): WatcherHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const ignore = options.ignore ?? DEFAULT_IGNORE;

  // Split on both separators so a Windows path can't smuggle a segment past
  // the check on a platform where path.sep is "/".
  const isIgnored = (p: string): boolean =>
    p.split(/[\\/]/).some((segment) => ignore.includes(segment));

  const pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; type: WatchEventType }
  >();
  let closed = false;

  const watcher = watch(root, {
    ignored: isIgnored,
    // Files that exist at startup are state, not events — do not replay them.
    ignoreInitial: true,
  });

  // Without a listener a chokidar "error" (e.g. a file vanishing mid-scan, a
  // permission hiccup) would throw as an unhandled EventEmitter error and kill
  // the process. The watcher has no logging policy of its own — the caller
  // decides via onError; the default absorbs silently. Either way the watch
  // itself keeps running.
  const onError = options.onError ?? ((): void => {});
  watcher.on("error", onError);

  const schedule = (type: WatchEventType, path: string): void => {
    if (closed) return;
    const prev = pending.get(path);
    let effective = type;
    if (prev) {
      clearTimeout(prev.timer);
      // add followed by unlink inside one window is a transient temp file:
      // observers never saw it exist, so the pair CANCELS to nothing (M4.3
      // fix — a bare "unlink" here would false-flag a delete-under-lock for
      // a file that never meaningfully existed).
      if (prev.type === "add" && type === "unlink") {
        pending.delete(path);
        return;
      }
      if (prev.type === "add" && type === "change") effective = "add";
    }
    const timer = setTimeout(() => {
      pending.delete(path);
      onEvent({ type: effective, path, at: new Date().toISOString() });
    }, debounceMs);
    pending.set(path, { timer, type: effective });
  };

  watcher.on("add", (path) => schedule("add", path));
  watcher.on("change", (path) => schedule("change", path));
  watcher.on("unlink", (path) => schedule("unlink", path));

  const ready = new Promise<void>((resolve) => {
    watcher.once("ready", () => resolve());
  });

  return {
    ready,
    async close(): Promise<void> {
      closed = true;
      // Pending events are dropped, not flushed: after close() the caller must
      // hear nothing, and a half-observed burst is not worth reporting.
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
      await watcher.close();
    },
  };
}
