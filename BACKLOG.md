# Backlog — ideas to revisit after September 6

## Agent identity model — OPEN QUESTION (surfaced by live stress test B, 2026-06-23)
Today session_id is per-config (one id in ~/.meshlock/config.json). Live test B showed that
Claude Code SUBAGENTS inherit the parent's single config session_id, so three concurrent
subagents acquiring the same path all "succeed" — the engine correctly sees them as ONE session
refreshing its own lock (DELETE-then-INSERT on (repo_root, path, session_id); one row results).
This is CORRECT for the solo model (one human + one Claude) and is NOT a bug — the DB serialized
fine (BEGIN IMMEDIATE held; exactly one row), and same-session refresh is intended M3.2 behavior.

But it means independent concurrent callers are invisible to each other under a shared session_id.
The deeper question — "where does an agent's identity come from?" — is foundational for M8 (team
relay): team mode needs identity per-agent/per-developer, not per-config. Options to decide at M8
(NOT now): (a) keep session_id per-config [current, fine for solo]; (b) inject session_id per call
so each agent/subagent is distinct; (c) per-init-context identity. Defer to M8 where the full
team-mode context makes the right choice clear. Logged so M8 doesn't rediscover it cold.

## Advisory lock mode — declared but NOT enforced (false affordance, found 2026-06-26)
Resolved the pre-M3.5a investigation gate. `lock_mode: z.enum(["exclusive","advisory"])` is declared
in config.ts (default "exclusive"), the `mode` column exists on the locks table (migration 001), and
the value is threaded all the way through lock-engine.ts (LockMode type, INSERT, SELECT, return) and
round-trips correctly. BUT acquireLock NEVER branches on it — a grep of lock-engine.ts shows no
`mode === "advisory"` conditional anywhere in the conflict logic. An advisory lock blocks exactly
like an exclusive one. The promised semantics (advisory = a soft "I'm here" signal that does NOT
block) are unimplemented. A user can set lock_mode:"advisory", it validates and stores, and they
silently still get blocked. This is a false affordance: the config promises behaviour the engine ignores.
- FALSE-CONFIDENCE TEST: lock-engine.test.ts asserts a stored advisory lock round-trips its label
  (`result.lock.mode).toBe("advisory")`). That tests the COLUMN, not the non-blocking behaviour, so
  it makes advisory look tested when it isn't. If advisory is ever implemented, add a test proving two
  advisory holders on the same (repo_root, path, branch) COEXIST (today they would not).
- DECISION DEFERRED (off the Sept critical path): either (a) implement non-blocking advisory semantics
  — a single branch in acquireLock's conflict check — or (b) drop "advisory" from the schema until it's
  real, so config can't promise what the engine ignores. Lean: (b) now (don't ship a false affordance),
  revisit (a) post-September if a concrete use case appears.
- VOCABULARY TRAP for future readers: "advisory" also appears in lock-engine.ts comments meaning
  "informational" (the cross-branch warn message) — unrelated to lock_mode "advisory". Do not conflate.

## Lock granularity "directory" — declared, enforcement unverified
Sibling to the above. config.ts declares `granularity: z.enum(["file","directory"])` (default "file").
Whether the engine actually locks at directory granularity — vs only ever per-file — is unverified;
same declared-vs-delivered class as advisory. Not in M3.5 scope. Investigate with the same
grep-the-engine method before relying on it; likely another label-only field today.

## Change-log retention / pruning (noted at M3.5a)
change_log is append-only with NO retention policy. A long-lived watcher daemon (M4+) accumulates
change history forever. Needs an age- or count-based prune eventually (e.g. keep last N records per
path, or drop records older than X days). Not urgent at solo/manual-release cadence; revisit when the
M4 watcher makes capture continuous and the table can grow without bound.

## Phase-2 / post-September
- AgentMesh full hub (prompt engine, pipeline tools, multi-team)
- MeshLearn (learning-as-you-build product)
- meshlock-cloud: hosted relay, billing, seat enforcement
- Git worktree isolation (L6 enforcement layer) — Phase 2
- Mobile app

## M2.5 — Branch-aware locking (now in implementation plan)
- Add `branch` column to locks table; UNIQUE(file_path, branch)
- acquireLock reads current git branch via simple-git
- Same-branch conflict = hard block; cross-branch = warn (configurable)
- Config toggle: cross_branch_mode = "warn" | "block" | "ignore"

## Change Briefing (M3.5, now in implementation plan)
- On release: record file_changelog row (path, session, branch, summary,
  diff_stat, changed_at) from git diff
- On acquire_lock: MCP response includes recent change history
- Team version (cross-machine) extends in M8 via relay
- Strongest differentiator — feature in README + Show HN

## VSCode five-state colors (M9, now in implementation plan)
- green=yours, red=locked same-branch, yellow=free-with-briefing,
  amber=active-cross-branch, grey=free
- hover=summary, click=full briefing panel

## Naming: avoid "handoff"/"context lock" — candidate "change briefing"

## Lock lifecycle refinements (deferred during M3.2 / M3.2b)
- Selective per-branch release_lock — currently release is all-or-nothing per
  path (drops all the session's locks on that path across branches). Revisit
  whether an agent should be able to release just one branch's lock.
- Branchless (non-git / disconnected-checkout) vs branched: should it count as
  a cross-branch conflict? Currently yes (warn default). Tracked in
  geopadev/meshlock#1 — needs real user feedback before changing.

## MCP tool surface refinements (deferred during M3.3a)
- Structured (JSON) team_status output variant alongside the human-readable text,
  for reliable machine consumption by agents that act programmatically. Decide if
  consumers want machine-readable status once there's real usage.
- acquire_lock denial message: include the lock's EXPIRY time, not just the holding
  session. A blocked agent wants to know "until when" to decide whether to wait or
  back off. (Surfaced in live stress test A — denial names the holder + gives guidance
  but not the expiry.) Small UX win.

## Change-briefing storage / perf optimization (noted at M3.5a, revisit if files get large or capture goes hot)
- M3.5a stores the full acquire-time file content as `locks.content_snapshot` for per-agent diff
  precision. For large or binary files this is heavy. SHA variant: `git hash-object` the file at
  acquire, store the 40-char blob id, diff the blob at release. Tiny storage, but git-coupled and
  breaks for non-git files. Only worth it if real usage shows snapshot bloat.
- diff.ts writes both sides to a scratch temp dir and spawns a git process per diffContent call.
  Fine at release cadence; would matter if capture ever moved onto a hot path (the M4 continuous
  watcher). Revisit alongside the SHA variant if perf shows up.