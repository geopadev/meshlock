# ADR-003: Branch as part of lock identity

**Status:** accepted
**Date:** M2.5

## Decision

A lock's identity is the pair `(path, branch)`, not `path` alone. The same file
locked on two different git branches is two distinct locks. Cross-branch contention
defaults to a soft warning (`cross_branch_mode: "warn"`), not a hard block. A
branchless lock (non-git repo or detached HEAD) stores `NULL`; the engine treats all
NULL branches as one shared logical branch via SQL `IS` / `IS NOT` rather than `=`.

## Alternatives considered

- `path` as sole identity, hard-blocking any second locker regardless of branch:
  simplest model, but fights git's own branching model — parallel branch work is
  deliberate and git already handles the textual merge.
- Ignore branch entirely: loses the ability to warn about semantic conflicts that
  will surface when both branches merge to main.
- Hard-block cross-branch too: maximally safe but eliminates the value of branches
  as a parallel-work primitive.

## Why this choice

Branches exist for deliberate parallel work. Hard-blocking cross-branch would push
users back to plain merge-conflict resolution and make MeshLock fight git's model.
But the semantic-conflict risk doesn't vanish — both branches eventually merge to
main — so the default warns rather than ignores. The warning is the hook the change
briefing (M3.5) later enriches with a diff summary. The engine stores branch as a
parameter supplied by the caller (the MCP tool), never resolved internally, keeping
the lock engine synchronous and pure.
