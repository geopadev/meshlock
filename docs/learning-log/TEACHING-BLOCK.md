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

## M4.1 — watcher core (`daemon/watcher.ts`)

### TS syntax
- **`export type WatchEventType = "add" | "change" | "unlink"`** — a union of string LITERALS. In JS
  you'd pass any string and typo silently; here `schedule("chnage", p)` is a compile error. The type is
  the whitelist.
- **`ReturnType<typeof setTimeout>`** — a utility type: "whatever setTimeout returns." Used because
  Node's setTimeout returns a `Timeout` object while the browser's returns a number; this stays correct
  in both without naming either.
- **`Map<string, {timer; type}>`** — generics on built-ins: TS knows `pending.get(path)` yields
  `{timer, type} | undefined`, which forces the `if (prev)` check (narrowing again).
- **`options: WatcherOptions = {}` + `options.debounceMs ?? DEFAULT`** — the optional-object-with-
  defaults pattern; `??` (not `||`) so a legitimate `0` wouldn't be clobbered.
- **Closure state.** `pending`, `closed`, `schedule` live in `createWatcher`'s closure — a factory
  returning a handle over private state. Same JS pattern you know; TS just types the handle
  (`WatcherHandle`).

### Concepts
- **Debounce, per-path.** Editors write in bursts (write+truncate+metadata). Each raw event restarts
  THAT PATH's timer; only after `debounceMs` of quiet does one normalized event fire. Per-path timers
  mean a busy file never suppresses a different file's events. Coalesce rule: last type wins, except
  add→change stays "add" (the trailing change is part of the creation burst).
- **Pure sensor / DI again.** The watcher knows files, not locks — no DB/config imports; root and
  callback injected. Same discipline as the engine: side effects at the edges, logic testable with a
  temp dir and an array.
- **`ignoreInitial: true`** — files existing at startup are STATE, not EVENTS. Replaying them would
  flood the daemon with thousands of fake "adds" on boot.
- **Why `.meshlock` is ignored** — the daemon must not feed on its own SQLite/WAL writes (a feedback
  loop: observe own write → process → write → observe…).
- **The no-op error listener.** An EventEmitter "error" with no listener THROWS and kills the process —
  so an empty handler is load-bearing, not laziness. Policy (log where? warn who?) is deferred to the
  daemon layer (M4.3) because the sensor has no logging opinion.
- **Async teardown.** `close()` cancels pending timers (drops, doesn't flush — after close the caller
  must hear nothing) then awaits chokidar's close. Leaked watchers keep the event loop alive → vitest
  "open handle" warnings; hence close-in-afterEach BEFORE deleting the temp dir.
- **Test technique:** poll-based `waitFor(predicate)` + a settle window instead of fixed sleeps
  (less flaky); a CONTROL WRITE in the ignore test so "no events" proves "ignored," not "broken."

---

## M4.2 — lock-aware classification (`daemon/classify.ts`)

### TS syntax
- **Discriminated union, consumed.** `Verdict = {kind:"guarded"; event; lock} | {kind:"unguarded";
  event}` — same pattern as the engine's `AcquireResult`. The magic is at the USE site: after
  `if (verdict.kind === "guarded")`, TS narrows the type so `verdict.lock` exists in that branch and is
  a compile ERROR in the other. In JS you'd check a string and hope the fields are there; TS proves it.
  The tests use exactly this (`if (verdict.kind === "guarded") { verdict.lock... }`).
- **`WatchEvent["type"]`** (in the test helper) — an indexed-access type: "the type of the `type` field
  of WatchEvent," i.e. the add/change/unlink union, without restating it. Rename the union, the helper
  follows.
- **`import type` again** — classify imports the `Lock`/`WatchEvent`/db TYPES plus one runtime function
  (`checkLock`). Note the mix: `import { checkLock, type Lock }` pulls one value and one type from the
  same module.

### Concepts
- **Sensor / judge / policy separation.** M4.1 sees (files), M4.2 judges (guarded/unguarded), M4.3 acts
  (what to do about it). Each layer is testable alone: classify's tests need a DB and a synthetic event
  object — no chokidar, no timers, no real fs.
- **Carry the evidence, don't re-query.** Both variants carry the full event; guarded also carries the
  lock row. M4.3's policy can distinguish delete-under-lock or read the holder/expiry without a second
  lookup. Design rule: the layer that fetched the data hands it forward.
- **Reuse the engine's semantics, don't restate them.** classify calls `checkLock`, so "expired = free"
  is decided in ONE place (the engine). If classify re-implemented expiry math, the two could drift.
- **Honest-limits doc-commenting.** Attribution (no OS identity on writes → guarded ≠ holder-did-this;
  M8) and branch blindness (guarded = locked on SOME branch) are written INLINE at the type, so the next
  reader can't over-trust the verdict. Naming what a component does NOT know is part of its contract.
- **Test technique:** `seedExpired` INSERTs the row directly because `acquireLock` can't create the
  past — when the public API can't produce a state you must test, go under it deliberately (and say so).

---

## M4.3 — daemon process + CLI (`daemon/index.ts`, `cli/index.ts`, watcher fixes)

### TS syntax
- **Deps object + optional field defaulting:** `startDaemon(deps: DaemonDeps)` with
  `deps.sink ?? ((line) => process.stderr.write(...))` — the injectable-dependency pattern typed: the
  interface documents what the daemon needs; the `??` supplies the production default so tests inject
  an array-collector instead of capturing stderr.
- **`err: unknown` (not `any`).** chokidar's error payload is untyped, so it arrives as `unknown` —
  which FORCES the narrowing `err instanceof Error ? err.message : String(err)` before use. `any` would
  let you `.message` blindly and crash on a non-Error; `unknown` makes the check mandatory.
- **`void daemon.close().then(...)`** in the signal handler — the `void` operator explicitly discards a
  promise in a place that can't await (a sync signal callback), telling the linter "not awaited, on
  purpose."

### Concepts
- **Factory vs process layer.** `startDaemon` has NO process.exit, NO signal handlers — it runs anywhere
  (tests included). The CLI owns everything process-shaped: config load, DB open, repoRoot resolution,
  signals, exit codes. Same edge-vs-core split as tool-vs-engine.
- **Alarm-fatigue policy.** Guarded events are deliberately silent: the daemon's value is the UNGUARDED
  signal, and logging the steady state buries it. "What to log" is a product decision, not plumbing.
- **stdout vs stderr discipline.** stdout belongs to the MCP protocol (serve); ALL daemon output goes to
  stderr — a banner on stdout would corrupt a JSON-RPC stream if streams were ever shared.
- **Control writes, again.** The guarded-silence test writes an unlocked control file: one warning for
  the control proves the pipeline is alive, so silence about the locked file means "guarded," not
  "broken." Testing an absence requires proving the detector works.
- **Self-feeding loops.** The test DB lives OUTSIDE the watched tree; live finding: a warning log inside
  the repo loops forever (warn → write → event → warn). Any observer that writes into what it observes
  feeds itself — the .meshlock ignore exists for exactly this.
- **Real-error testing.** The error path uses a genuine EACCES (chmod-000 subdir) rather than a mock —
  deterministic, and it proves chokidar's actual behaviour, not an assumption about it.

---

## M5.1 — pre-commit decision logic (`hooks/pre-commit.ts`)

### TS syntax
- **Narrowing on the NEGATIVE variant.** `if (!verdict.allowed) { verdict.conflicts... }` — the
  discriminated union narrows both ways: `allowed: false` proves `conflicts` exists, `allowed: true`
  proves it doesn't. Third module using the pattern (AcquireResult, Verdict, now HookVerdict) — it's the
  project's house style for "result with reasons."
- **`null === null` is `true` in JS.** The one-line branch rule `result.lock.branch !== input.branch`
  works for branchless-vs-branchless because JS strict equality on two nulls is true — deliberately
  reproducing SQL's `branch IS ?` in JS. Contrast: in SQL, `NULL = NULL` is NOT true (three-valued
  logic); `IS` exists for exactly that. Same rule, two languages, two different operators.
- **`continue` as rule-listing.** The loop body is three guard-continues (free/expired, own, cross-
  branch) then a push — each rule one line, readable as the spec itself.

### Concepts
- **Warn layer vs enforce layer.** The daemon (M4) warns and must tolerate ambiguity; the hook BLOCKS
  and must not. That asymmetry is why classify may stay path-level ("locked on any branch = guarded" is
  fine for a warning) but the hook's arbitrary-row exposure was a shippable-blocking bug.
- **The find: `.get()` without a filter is a hidden decision.** checkLock returns ONE arbitrary row of
  possibly several (one live lock per branch is legal). Every consumer inherited that silently: the hook
  could be handed the non-blocking branch's row (wrongly allow), release could be handed a FOREIGN row
  (diff against someone else's baseline). Lesson: an API returning "one of possibly many, unspecified
  which" bakes nondeterminism into every caller — either filter (M5.1b) or return all.
- **Collect all conflicts, don't fail-fast.** One failed commit shows the full fix list. Error UX rule:
  when a human must act on failures, report the complete set, not the first.
- **Mirror-don't-reinvent has limits.** The spec said mirror the engine; the Builder did, then flagged
  that the mirror reflects a flaw. Correct behaviour on both counts: follow the spec, surface what the
  spec inherits.

---

## M5.1b — checkLock branch filter (`lock-engine.ts`, `hooks/pre-commit.ts`)

### TS syntax
- **`branch?: string | null` — the full three-state optional.** Omitted → `undefined` → any-branch;
  a string → that branch; explicit `null` → branchless only. The API works BECAUSE null ≠ undefined in
  JS — third place the project leans on it (getChanges filter, ChangeQuery, now checkLock). If TS had
  only one "empty" value, this API couldn't exist in this shape.
- **`branch === undefined ? queryA : queryB`** — branching to two different prepared statements rather
  than one clever SQL string. Two honest queries beat one query with conditional-clause gymnastics;
  each is independently readable and the omitted path stays byte-identical (zero risk to old callers).

### Concepts
- **`IS ?` vs `= ?`, the recurring SQL rule.** Under three-valued logic `NULL = NULL` is not true, so
  a `= ?` filter bound to null silently matches nothing. `IS ?` treats null as comparable. Contrast with
  JS where `null === null` IS true — M5.1's hook used the JS side of this; M5.1b moved the comparison
  into SQL and had to switch operators. Same rule, per-language operator.
- **Additive API change.** An optional trailing param means zero callers change to compile — classify
  and check_lock keep their any-branch semantics untouched, the hook opts in. When a fix can be additive,
  it should be: the blast radius is exactly the callers who need the new behaviour.
- **Fix the lookup, not the caller.** M5.1 compared branches AFTER an arbitrary fetch — unfixable at the
  caller because the wrong row is already in hand. Determinism had to move INTO the query. General rule:
  nondeterministic selection can't be patched downstream.
- **Pin old behaviour when changing near it.** The "omitted still returns SOME live row" test exists so
  the historical semantics are asserted, not assumed — the next refactor can't silently change them.
- **Finds cascade.** Closing the arbitrary-row gap exposed the next one (expired-arbitrary-row under the
  omitted path). Each fix narrows the question enough to see the next flaw — that's the review loop
  working, not churn.

---

## M5.1c — releaseLock returns deleted rows + liveness fix (`lock-engine.ts`, `release-lock.ts`)

### TS syntax
- **Return-type change as a refactor forcing function.** `releaseLock(): boolean → Lock[]` — the
  compiler finds every caller that must change (here: one tool + tests). In JS you'd grep and hope;
  in TS the old `if (released)` on an array still compiles (truthy!), so note the trap: a TYPE change
  is loud, a boolean→array SEMANTIC change can be quiet — the tests (`toEqual([])`) carry the real
  guarantee.
- **`db.transaction(...).immediate()`** — better-sqlite3's transaction wrapper: the function runs
  atomically under BEGIN IMMEDIATE, and whatever it returns becomes the call's return value. Second
  use in the engine (acquireLock's txn is the first) — the house pattern for read-then-write pairs.

### Concepts
- **Read-then-delete must be one transaction.** SELECT the rows, DELETE them, return what you saw —
  under BEGIN IMMEDIATE nothing can change between the two statements, so the returned rows are
  EXACTLY what was deleted. Split across transactions, another connection could slip in between and
  the return value would lie.
- **Causal data flow beats look-then-act.** The old shape (checkLock, then releaseLock, then record
  from the checkLock row) had two reads with DIFFERENT semantics — checkLock's liveness view dropped
  expired baselines and multi-branch releases collapsed to one arbitrary row. Returning what the
  delete itself removed makes the recorded data causally tied to the action. General rule: when an
  operation needs to report on what it affected, have IT return that — don't reconstruct it with a
  second query.
- **Where liveness lives depends on candidate count.** Omitted-branch lookup chooses among SEVERAL
  rows → the expiry filter must be in the WHERE (before the choice). Branch-filtered lookup has ≤1
  candidate → post-fetch check is equivalent. Same rule, different placement, one comment explaining
  why — asymmetry is fine when it's reasoned and written down.
- **"Intended consequences" belong in the diff.** Expired-owned-now-records and per-branch records
  are behaviour changes a future reader could mistake for bugs; the tool comments name them as
  deliberate. If a change alters observable behaviour on purpose, say so at the change site.
- **Transactions don't nest.** releaseLock owning its transaction means a future caller inside an
  outer txn throws loudly. Composability trade: safety for the common case, a known trap for the
  exotic one — logged, not hidden.

---

## M5.2 — hook shim + installer + CLI (`hooks/run.ts`, `hooks/install.ts`, `cli/index.ts`)

### TS syntax
- **Result objects over thrown errors at boundaries.** `InstallHookResult` and `PreCommitRunResult`
  are discriminated results — refusals and verdicts are DATA the CLI formats, not exceptions. The
  house rule since AcquireResult: expected outcomes return, unexpected ones throw.
- **`0 | 1` as a type.** `exitCode: 0 | 1` — a numeric literal union. The compiler rejects
  `exitCode: 2`; the type IS the exit-code contract with git.
- **Template-literal constant with interpolation** (`HOOK_SCRIPT` embedding `HOOK_MARKER`) — one
  source of truth for the marker, used by both writer and detector.

### Concepts
- **Fail-open vs fail-closed is a POLICY, chosen per layer.** The hook fails OPEN (broken meshlock
  must not brick commits — an uninstalled gate protects nobody); a security gate would fail CLOSED.
  Neither is "correct" in general; what matters is choosing deliberately and reserving the blocking
  signal (exit 1) for the positive verdict only. Two belts: the runtime catches its own internals,
  the CLI catches deps-assembly failures BEFORE the runtime exists.
- **NUL-delimited output (`-z`).** Filenames can contain newlines; git quotes them in line mode; NUL
  is the one byte a path cannot contain. Rule: when consuming tool output programmatically, prefer
  the machine format over parsing the human one.
- **Ownership markers.** The installer may only overwrite what carries its own marker — the
  refuse-to-clobber discipline (M3.3b's config rule) generalized: never destroy state you didn't
  create and can't parse. Versioned marker = future migration hook.
- **Canonicalize both sides or you haven't canonicalized.** The hook realpaths its side; locks store
  agent paths raw — so the comparison is still unsound (the residual ISSUE). Normalization must
  happen where data ENTERS the system (M6.1), not just where it's compared.
- **`writeFileSync` mode only applies on CREATE** — the unconditional `chmodSync` after an upgrade
  overwrite is load-bearing, not paranoia.
- **PATH-relative over pinned paths** (shim `exec meshlock`) — the M3.3b lesson again: pinned
  interpreter paths die on environment upgrades and fail SILENTLY; PATH failures are rare and loud.

---

## M6.1 — path canonicalization (`core/paths.ts`)

### TS syntax
- **Destructure-rename at the boundary:** `({ path: rawPath }) => { const path = canonicalizePath(rawPath) }`
  — the raw input gets a name that marks it untrusted, and the familiar name `path` is REBOUND to the
  sanitized form, so all downstream code (unchanged) uses the safe value. A naming convention doing
  security work.
- **Nested try/catch as a tier ladder** — three fallbacks, each catch delegating one level down;
  never-throws as an API guarantee (documented), matching getRepoRoot's sentinel contract.

### Concepts
- **Identity is the stored string.** Lock identity = (repo_root, path, branch) as STRINGS; the
  filesystem's many names for one file (symlinks, `..`, case) all collapse or don't at ingestion.
  If they don't, every comparison site inherits the ambiguity.
- **Normalize where data ENTERS, not where it's compared.** There are many comparison sites (engine,
  hook, daemon, briefing) and one ingestion point per tool — fix the funnel, not the fan-out. Same
  shape as validation-at-the-boundary (zod on config).
- **Canonicalizing a file that doesn't exist yet:** the variance lives in the DIRECTORIES, so
  realpath(parent)+basename fixes the alias even pre-creation. Tier design = ask "which part of this
  path has fs reality?"
- **Test hygiene: canonicalize your EXPECTATIONS too.** The OS tmp dir itself may be a symlink
  (macOS /tmp → /private/tmp) — expected values must be realpath'd or the test fails on some machines
  for reasons unrelated to the code.
- **No migration as a reasoned choice:** TTL-short rows age out; a migration would be complexity for
  data that expires on its own. "Do nothing" is a valid option when data has a half-life.

---

<!-- Fable-sprint milestones append below as they're reviewed. -->