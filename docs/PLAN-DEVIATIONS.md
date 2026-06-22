# MeshLock — Plan Deviation Log

**Purpose:** The implementation plan (`meshlock-implementation-plan-v6.md`) is the
canonical roadmap. But as we build, the architect splits milestones, reorders them,
or inserts sub-tasks to respect the 6-file-per-prompt cap and the learning pace.
Those changes live HERE so the architect numbering (e.g. `M3.1b`) never drifts
silently from the plan's numbering, and so context survives across sessions.

**How to read this:** "Plan says" = what v6 specifies. "We did" = what was actually
built, in what order. "Why" = the reason for the deviation. Every architect-invented
sub-number (anything not in v6) is marked **[architect-invented]**.

**Status key:** ✅ done & reviewed · 🔨 in progress · ⏭️ skipped (with reason) · 📋 queued

---

## Numbering convention

- v6 defines: M1, M2, **M2.5**, M3, **M3.5**, M4, M5, M6, M7, M8, M9, M10.
- The architect may split any milestone into `Mx.1`, `Mx.2`, `Mx.1b`, etc.
  These sub-numbers are **our** invention and do **not** appear in v6.
- When reading v6, mentally map our sub-numbers back to the parent milestone.

---

## M1 — Project setup
**Plan says:** repo + tooling, `core/db.ts` (SQLite wrapper + migrations + `locks`
table), `core/config.ts` (zod schema + reader/writer). One milestone.

**We did:**
- ✅ **M1 (as built):** project skeleton + `config.ts` + `config.test.ts` only.
  The DB layer was NOT built here despite the plan bundling it into M1.

**Deviation:** `core/db.ts` and the `locks` migration slipped out of M1 and became
the first sub-task of M2. The M1 learning log confirms only config + skeleton shipped.

---

## M2 — Core lock engine
**Plan says:** `core/lock-engine.ts` (acquire/release/check/list/expireStale) with
`BEGIN IMMEDIATE` race handling + full tests. One milestone. (DB layer assumed from M1.)

**We did — split into three architect sub-tasks:**
- ✅ **M2.1 [architect-invented]:** `core/db.ts` + `001_create_locks.sql` + `db.test.ts`.
  The DB layer the plan had placed in M1. WAL mode locked (decision D2). Dep: `better-sqlite3`.
- ✅ **M2.2 [architect-invented]:** `core/lock-engine.ts` + `lock-engine.test.ts`.
  The five functions + `BEGIN IMMEDIATE` race handling. Two concurrency tests prove
  serialization. (Tests landed in a second pass — first diff shipped engine without tests.)

**Why split:** the DB layer was a genuine prerequisite the plan mis-placed in M1, and
the 6-file cap + "this is the heart, take your time" warranted isolating the engine
from its storage layer.

**Decisions locked:** better-sqlite3 over node:sqlite; WAL over journal; discriminated-union
returns (conflict as data, not exception); ISO-8601 string comparison for expiry.

---

## M2.5 — Branch-aware locking  ✅ (was skipped, caught, built & accepted)
**Plan says:** insert between M2 and M3. Add `branch` column; change uniqueness from
`UNIQUE(path)` → `UNIQUE(path, branch)`; `acquireLock` resolves git branch; cross-branch
behavior via new `cross_branch_mode` config (`warn` default / `block` / `ignore`).
Dep: `simple-git`. Files: lock-engine.ts, lock-engine.test.ts, config.ts, new migration.

**What happened:** ⏭️ **SKIPPED.** We went M2 → straight to M3 (check_lock) without
doing M2.5. Caught during the v6 plan re-read. M2.5 was a v4 insertion; the user
conceived the branch-aware idea *after* M3 had already started, so it wasn't in view
when M3 began.

**Product rationale (user's, formalized):** cross-branch hard-blocking would make
MeshLock fight git's parallel-work model — users would revert to plain git merge-conflict
resolution and uninstall. So cross-branch defaults to **warn, not block**. But the warning
isn't empty: both branches merge to main eventually, so the semantic risk persists — the
warning is the seam M3.5's change briefing later fills. This is the differentiator vs git.

**Resolution:** 🔨 doing M2.5 NOW, before M3.2 (the mutating MCP tools), because
`acquire_lock`'s conflict logic is exactly what M2.5 rewrites — building it before M2.5
would mean immediately rewriting it. `check_lock` (already built, read-only) gets branch
retrofitted into its response cheaply later.

**Scope decisions (RESOLVED):**
- D-M2.5-a: ✅ `002` rebuild migration (proper table-rebuild pattern, not amending `001`).
  `001` stays honest as "the schema at M2"; `002` demonstrates create-new/copy/drop/rename.
- D-M2.5-b: ✅ branchless locks permissive — non-git-repo / detached HEAD stores NULL and
  behaves like the M2 path-only lock. MeshLock does NOT hard-require git to lock a file.

**Scope boundary:** M2.5 builds the branch dimension + warn/block/ignore decision ONLY.
It does NOT build the change briefing — that's M3.5 (`changelog.ts`). M2.5's cross-branch
warning is just the hook M3.5 enriches.

**BUILD OUTCOME (accepted):** Built with Opus 4.8/xhigh. 6 files (db.test.ts a forced 6th —
002 changed the schema its assertions hardcoded; within cap). 36 tests pass (was 30).
Highlights: null-safe SQL (`branch IS ?` not `=`, since SQL `=` never matches NULL);
DELETE-then-INSERT replaced UPSERT (ON CONFLICT(path,branch) won't fire for NULL branches,
so upsert would silently duplicate branchless rows); branchless-same-path block enforced by
CODE not the constraint (the crucial test passed). M2 concurrency tests untouched. Engine
stayed synchronous; no simple-git added.

**Architect overrides on the build:**
- Issue #1: agent kept `otherBranch: string | null` (not spec's `string`) — ACCEPTED, the
  type shouldn't lie; a branchless lock genuinely has null branch. OPEN PRODUCT QUESTION:
  should branchless (non-git) vs branched count as cross-branch conflict at all? Current
  code: yes, warns. Architect lean: yes (branchless = no git isolation = more concerning).
  Tracked in geopadev/meshlock#1 (deferred pending user feedback; warn default holds).

**Follow-on items spawned by M2.5 (NOT done here):**
- **[M3.2 wiring]** Double-default bug: engine `crossBranchMode` defaults to `"block"`,
  config `cross_branch_mode` defaults to `"warn"`. If wiring forgets to pass config →
  silent divergence (user set warn, gets block). FIX: single shared `DEFAULT_CROSS_BRANCH_MODE`
  constant imported by both layers + an M3.2 config→engine wiring test.
- **[M2.5b, after M3.2]** Plural-holder warning: `selectCross` uses `.get()` (one row), so a
  path locked on 3 branches names only 1 in the warning. Defer until M3.2's acquire_lock tool
  exists to consume the shape — then build `others: Array<{branch, heldBy}>` to fit the real consumer.
- **[M3.2]** `check_lock` tool doesn't surface `branch` yet — engine returns it, tool output omits it.

---

## M3 — MCP server + tools
**Plan says:** ONE milestone delivering `mcp/server.ts` + all four tools
(`acquire_lock`, `release_lock`, `check_lock`, `team_status`) + `meshlock init`
registration in Claude Code/Codex/Cursor configs. Live-test by watching raw JSON-RPC.

**We did — split into architect sub-tasks (only first three done):**
- ✅ **M3.1 [architect-invented]:** server skeleton + `check_lock` (read-only tool) only,
  over stdio. Files: server.ts, tools/check-lock.ts, server.test.ts. Dep: `@modelcontextprotocol/sdk`.
- ✅ **M3.1b [architect-invented]:** refactor — centralize DB path (`getDatabasePath()` in
  config.ts) + move dir-creation into `openDatabase`. Pulled the `server.ts` workaround out.
  Files: config.ts, db.ts, server.ts, config.test.ts.
- ✅ **M3.2 [architect-invented]:** `acquire_lock` tool only (split from release_lock for cap).
  simple-git enters (branch resolved in handler, before sync engine call — git I/O never in
  the transaction). Branchless fallback (no repo/detached HEAD → null) tested. Double-default
  bug FIXED: `DEFAULT_CROSS_BRANCH_MODE` constant in config.ts, imported by both defaultConfig
  and engine fallback. Config DI'd into handler factory, loaded once in server.ts. 41 tests.
  Files: acquire-lock.ts, acquire-lock.test.ts, config.ts, lock-engine.ts (constant swap only),
  server.ts. Dep: simple-git ^3.36.0.
- ✅ **M3.2b [architect-invented]:** `release_lock` tool. Thin sync adapter over engine's
  releaseLock — branch-agnostic (no branch filter → one release drops all the session's locks
  on that path across branches), ownership-scoped (config.session_id in WHERE), no-op-not-error
  on unowned/absent locks. No git, no new dep, engine unchanged. 45 tests. Full lock lifecycle
  (check/acquire/release) now exists in the MCP layer.
- ✅ **M3.2c [architect-invented]:** `core/git.ts` — pure cached branch resolver. getCurrentBranch(cwd?)
  defaults to process.cwd() (daemon repo root), maps detached/empty/error → null, never throws,
  caches per-cwd for 5s (BRANCH_CACHE_TTL_MS) so a burst of calls = ≤1 subprocess/window. acquire-lock
  now calls it (dropped inline resolveBranch + dirname(path)). Fixes M3.2 #1 (resolution base) + #2
  (subprocess per call). git.test.ts uses real temp git repos → closes the named-branch coverage gap.
  acquire-lock.test.ts: assertions unchanged, chdir-to-non-git-tempdir in setup (disclosed). 49 tests.
  core/git.ts imports nothing from mcp/ — dependency direction intact.
- 📋 **M3.3 [architect-invented]:** `team_status` tool + `meshlock init` registration. NOT YET BUILT.
  team_status will consume getCurrentBranch. Live registration test (M3.2/b/c issue #3) gets solved
  here — registering in Claude Code + watching real JSON-RPC IS the live test.

**Why split:** four tools + init registration far exceeds the 6-file cap and mixes concerns;
`check_lock` first (read-only) de-risks the transport/registration plumbing before any
state-mutating tool touches it.

**Ordering note:** M3.1/M3.1b were built BEFORE M2.5, slightly out of plan order. Acceptable
because check_lock is read-only (cheap to retrofit branch). The mutating tools (M3.2+) are
correctly being held until M2.5 lands.

---

## M3.5 — Change briefing (the differentiator)  📋
**Plan says:** insert between M3 and M4. New `core/changelog.ts` + `file_changelog`
migration; record diff summary on release; enrich `acquire_lock` response with recent
change history. Solo only (cross-machine is M8). Files: changelog.ts, changelog.test.ts,
migration, lock-engine.ts (release hook), tools/acquire-lock.ts.

**We did:** 📋 not started. Depends on M2.5 (branch column) and M3.2 (acquire_lock existing).

---

## M4–M10 — not yet reached
- 📋 **M4** Watcher daemon (chokidar) + `daemon/index.ts`
- 📋 **M5** Git pre-commit hook
- 📋 **M6** CLI + run wrapper
- 📋 **M7** Web dashboard (buffer milestone — can ship minimal if schedule tight)
- 📋 **M8** Relay client + free self-host relay (+ team change-briefing sync)
- 📋 **M9** VSCode extension (five-state colour system — depends on M2.5 branch + M3.5 briefing)
- 📋 **M10** Integration + hardening + AGENTS.md generator

---

## Current position

**Active milestone:** ✅ M3.2c accepted → 📋 **M3.3 next** (team_status + meshlock init +
the live-agent-over-JSON-RPC payoff). team_status consumes core/git.ts's getCurrentBranch.

**Built & reviewed so far:** M1 (config), M2.1 (db), M2.2 (lock engine),
M3.1 (check_lock), M3.1b (path/dir refactor), M2.5 (branch-aware engine), M3.2 (acquire_lock),
M3.2b (release_lock), M3.2c (core/git.ts cached branch resolver). Full check/acquire/release
lifecycle live; branch resolution centralized + cached.

**Pending teaching:** Block 6 (NULL three-valued logic, undefined-vs-null, z.infer) proposed
but not yet done — M2.5 left 3 fuzzies, M3.2 left 2. Clear before they compound.

**Backlog items captured (not lost):**
- Ensure `data/migrations` ships in the published npm tarball (`files` field) — packaging risk.
- Read-only DB open path (fail-if-missing) for when the first read-only caller appears.
- Optional explicit `busy_timeout` pragma in db.ts (currently relying on better-sqlite3 default 5s).
- Note near the ISO-8601 expiry comparison that all timestamps must share format (UTC Z, ms precision).
- [M2.5b, after M3.2] Plural cross-branch holders in the warning shape (consumer now exists post-M3.2).
- [M3.2/M3.3] Surface `branch` in the check_lock tool output.
- [backlog] Real-git-repo test (named branch resolves) + live stdio-transport registration test (M3.2 issue #3).
- [ADR] ADR-004: simple-git over manual git shelling / isomorphic-git.
- [M3.3 verification] Live registration test covers all 3 tools over real transport (M3.2b issue #2). Optional cheap version: SDK in-memory transport, tools/list asserts 3 tool names.
- [M4 daemon-lifecycle] Guarantee session_id stability across a daemon run; decide regeneration policy (M3.2b issue #3). TTL is the safety net meanwhile.
- [M5 enhancement] Git hook busts the branch cache on checkout (event-driven invalidation; replaces TTL-guessing for the common case). 5s TTL stays as fallback. (M3.2c issue #1)
- [conditional] If vitest pool changes forks→threads, chdir in acquire tests breaks; replace with a cwd seam on the handler (pass cwd in rather than reading process.cwd() globally). (M3.2c issue #2)

> Product-level "revisit after September" items (selective per-branch release; branchless-vs-branched
> conflict / issue #1) live in BACKLOG.md, not here. This file tracks build-sequence follow-ons only.