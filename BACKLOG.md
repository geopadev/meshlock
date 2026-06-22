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
