# Backlog — ideas to revisit after September 6

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