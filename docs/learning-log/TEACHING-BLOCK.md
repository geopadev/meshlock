# MeshLock — Teaching Block (study later)

Dense study material accumulated during the Fable-5 velocity sprint, when live teaching passes were
skipped. Read alongside the real files. Each entry: the concept, its JS equivalent (you know JS/Python,
not TS), and why it's written that way HERE. Ask the Architect to run an interactive read-along on any
of this once Fable access ends.

---

## M3.5a — change_log storage + diff helper (`core/changes.ts`, `core/diff.ts`, migration 005)

### TS syntax
- **`interface ChangeRecord { ... }`** — a compile-time shape for an object. JS has no equivalent; you'd
  just pass a plain object and hope. The interface is erased at runtime (it produces no JS) — it only
  makes the compiler check callers.
- **`string | null` (union) vs `summary?:` (optional)** — two DIFFERENT ideas that look similar.
  `x: string | null` = the field is ALWAYS present but its value may be null. `x?: string` = the field
  may be ABSENT entirely (its runtime value when absent is `undefined`). `changes.ts` uses both:
  `branch: string | null` (always there, may be null) vs `summary?: string | null` (may be omitted).
- **`db.prepare<[params], ChangeRow>(sql)`** — the two generic args tell TS "these are the bind
  parameters, this is the row shape returned." It is a CAST, not a runtime check — better-sqlite3 hands
  back whatever the SQL selected and TS just trusts it matches `ChangeRow`. (This bites in M3.5b.)
- **`import type { MeshLockDatabase }`** — imports only the TYPE, not runtime code. Compiles to nothing.
  Signals "I need this for type-checking, don't emit a require for it."
- **`./db.js` import even though the file is `db.ts`** — ESM/TS quirk: you write the `.js` extension the
  compiled output will have, not the `.ts` source name. Feels wrong; it's correct for Node ESM.
- **`record.summary ?? null`** — `??` returns the right side only when the left is null/undefined. Needed
  because an omitted optional is `undefined` at runtime (the `?` erased), and better-sqlite3 THROWS on a
  bound `undefined` — so you convert it to a real SQL NULL. **The type gives no runtime guard; `?? null`
  is the runtime guard.** (This was a repeatedly-fuzzy point — nail it.)

### Concepts
- **State table vs log table.** `locks` is STATE: one row per identity `(repo_root, path, branch)`,
  UNIQUE-enforced, "what's true now." `change_log` is a LOG: many rows per identity over time, surrogate
  `id`, NO uniqueness — the accumulated history IS the feature. Same data instinct, opposite table
  design. (The surrogate `id` + no-UNIQUE is the log archetype.)
- **snake_case DB / camelCase TS, mapped at the boundary.** `rowToRecord` converts `session_id` →
  `sessionId` so callers never see SQL column names. Keeps the SQL naming and the JS naming conventions
  each idiomatic.
- **Storage is dumb on purpose.** `recordChange` stores unconditionally; the "should we even record
  this?" policy lives in the caller. Lets policy change without touching the table.
- **`git diff --no-index` exit codes.** git exits 0 when files are IDENTICAL, 1 when they DIFFER. For us
  "they differ" is the success case — so `diff.ts` uses `spawnSync` (inspects `.status`: 0→"", 1→stdout,
  else→throw), NOT `execFileSync` (which throws on any non-zero and would treat every real diff as an
  error).

---

## M3.5b — acquire-time snapshot capture (`lock-engine.ts`, `acquire-lock.ts`)

### TS syntax
- **Optional `contentSnapshot?: string | null` + `input.contentSnapshot ?? null`** — same erasure lesson
  as M3.5a: the `?` is compile-time only; the `?? null` makes an absent value safe before SQL.
- **Type narrowing inside `if`.** `if (same !== undefined && same.session_id === sessionId) { ... }` —
  inside the block, TS NARROWS `same` from `Lock | undefined` down to `Lock`, so `same.content_snapshot`
  needs no `!`. In JS you'd just access and hope; TS proves non-undefined from the condition you wrote.
- **The cast lies if SELECTs drift.** `db.prepare<…, Lock>(…)` doesn't verify the SQL returns every
  `Lock` column. When `Lock` grew `content_snapshot`, any SELECT still omitting it would return an object
  secretly missing the field while the compiler believes it's there — a silent `undefined`. That's why
  ALL FOUR Lock-returning SELECTs had to gain the column in lockstep with the interface.

### Concepts
- **Dependency injection / engine purity.** The engine takes all data as arguments (db, repoRoot, branch,
  contentSnapshot) and never touches the filesystem. The TOOL reads the file and injects the bytes. Payoff:
  the engine is a pure function of its inputs — its tests pass literal `"A"`/`"B"` strings, no real files.
  Same reason `branch` is resolved in the tool, not the engine.
- **Capture vs preserve (the keystone).** `content_snapshot` = the file's content when the session FIRST
  locked it — the "before" photo. On a same-session REFRESH (renewal to dodge expiry) you must NOT retake
  it; re-snapshotting mid-edit would make the release diff only show changes AFTER the refresh. So the
  engine preserves the existing snapshot and discards the incoming one. A DIFFERENT-session expired row is
  a TAKEOVER, not a refresh, so it correctly captures the new holder's baseline.
- **null as a domain value, not an error.** Agents often lock a file they're about to CREATE. A read
  failure isn't a fault — `captureSnapshot` catches it and returns null, meaning "no baseline (new file)."
  M3.5c treats null as "" so a new file diffs as all-additions.

---

## M3.5c — release records, acquire briefs (`release-lock.ts`, `acquire-lock.ts`)

### TS syntax
- **Optional input in a zod schema:** `summary: z.string().optional()` — validates "a string or absent."
  The handler destructures `{ path, summary }: { path: string; summary?: string }`.

### Concepts
- **Capture-before-delete ordering.** `releaseLock` DELETES the row that holds `content_snapshot`, so the
  tool must `checkLock` FIRST to read the baseline. Reverse the order and every diff is measured against
  nothing → silently empty history. A type-invisible invariant; the "records a diff" test guards it.
- **The two-condition record gate `if (released && held.held)`.** `released === false` → you were releasing
  a lock you don't own (nothing to record). `held.held === false` → the lock was expired (no live baseline
  to diff). Both must be true to record.
- **Floor vs skip (truth vs garbage).** An empty diff IS recorded — "nothing changed" is TRUE information
  (the floor). Binary content (NUL byte either side) is SKIPPED, not stored — a utf-8 diff of binary is
  garbage, i.e. a lie. Record truth, refuse garbage.
- **Single responsibility — binary check at the tool, not in `diffContent`.** `diffContent`'s one job is to
  diff; whether a diff is even APPLICABLE (is this text?) is the caller's contextual judgment. Keeps the
  helper reusable and unopinionated.
- **Branch-scoped briefing.** `getChanges({ ..., branch })` passes the current branch; `null` means
  branchless-only (`branch IS NULL`), mirroring the lock's own `(repo_root, path, branch)` scoping. Don't
  confuse this filter behaviour with the display `??` fallback in the headline.

---

<!-- Fable-sprint milestones (M4+) append below as they're reviewed. -->
