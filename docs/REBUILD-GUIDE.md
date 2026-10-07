# MeshLock Rebuild Guide

You write every line. The Architect plans and checks your understanding; the Tutor teaches and reviews. Neither writes your code.

## The two roles

- **Architect:** the MeshLock project in the Claude desktop app. It picks the next step, writes the brief for the Tutor, checks your explanation afterwards, and handles design decisions and the academic side.
- **Tutor:** Claude Code in this repository. It reads your actual code, teaches the concepts for each step, reviews your tests and code, and compares your version with the original. Editing is blocked in `.claude/settings.json`.

## One session

1. **Claude Code:** start it with `claude --add-dir ../meshlock-reference`, then run `/recall`.
2. **Desktop app:** say which step you're starting. The Architect gives you a short brief.
3. **Claude Code:** `/step <id>` followed by the brief. Write the tests, watch them fail, then write the code. Use `/hint` when stuck and `/review` when done.
4. **Claude Code:** once the tests pass, run `/compare`.
5. **Desktop app:** paste a three or four sentence explanation of what you built and why. The Architect checks it.
6. **You:** tick the step below, commit, and add a row to `LEARNING-LOG.md`.

## Rules that make it stick

- **Type everything.** Never paste code into the rebuild.
- **Predict before you run.** The surprises are the lessons.
- **Debug alone for 15 minutes before asking.** Then say what you expected and what you got.
- **Keep steps small:** one behaviour, 30 to 60 minutes, then commit.
- **Commit prefixes:** `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- **Never start Claude Code inside `meshlock-reference`.** Its `CLAUDE.md` still holds the old instructions to write code.

## The steps

**Phase 0: Project setup**
- [x] 0.1 TypeScript, ESM and pnpm project, with `.gitignore`
- [x] 0.2 vitest and a first passing test

**Phase 1: Configuration**
- [x] 1.1 Config schema with zod, and the type derived from it
- [ ] 1.2 Loading: a missing file creates and saves the defaults
- [ ] 1.3 Loading: malformed or unreadable files throw and are never overwritten
- [ ] 1.4 Saving atomically, with a temporary file and rename

**Phase 2: Database and migrations**
- [ ] 2.1 Opening the database in WAL mode
- [ ] 2.2 The migration runner, and migration 001 creating the locks table

**Phase 3: Lock engine**
- [ ] 3.1 The lock types and result unions
- [ ] 3.2 `acquireLock`: a free path, and a path held by someone else
- [ ] 3.3 `checkLock`
- [ ] 3.4 `releaseLock`, returning the rows it deleted
- [ ] 3.5 Lease expiry and `expireStaleLocks`
- [ ] 3.6 Race safety: `BEGIN IMMEDIATE` and the two-connection test
- [ ] 3.7 `forceReleaseLock` and `listLocks`

**Phase 4: Branch awareness**
- [ ] 4.1 Migration 002, and branch as part of a lock's identity (`IS` versus `=`)
- [ ] 4.2 Cross-branch modes: warn, block and ignore

**Phase 5: Repository scoping and paths**
- [ ] 5.1 Finding the repository root and current branch, with caching
- [ ] 5.2 Migrations 003 and 004, adding the repository to a lock's identity
- [ ] 5.3 `canonicalizePath` and the walk-up algorithm

**Phase 6: Change briefing**
- [ ] 6.1 Migration 005 and recording changes
- [ ] 6.2 Producing a diff, and why git's exit code 1 means success
- [ ] 6.3 Snapshot at acquire, record at release

**Phase 7: MCP server and agent tools**
- [ ] 7.1 A server skeleton over stdio
- [ ] 7.2 The `acquire_lock` tool
- [ ] 7.3 The `check_lock`, `release_lock` and `team_status` tools
- [ ] 7.4 `init`: registering with Claude Code

**Phase 8: Filesystem watcher**
- [ ] 8.1 A debounced watcher
- [ ] 8.2 Classifying edits, and the watcher process

**Phase 9: Pre-commit enforcement**
- [ ] 9.1 `checkCommit`, the pure decision
- [ ] 9.2 The hook runtime, and failing open
- [ ] 9.3 The installer, and refusing to overwrite another tool's hook

**Phase 10: Command line**
- [ ] 10.1 Dispatching `status`, `unlock`, `watch`, `serve`, `install-hook` and `hook`

**Deferred: add only when built** (a config value exists only once the code honours it)
- [ ] D.1 `lock_mode: "advisory"`: a lock that warns but never blocks
- [ ] D.2 `granularity: "directory"`: one lock covering a whole folder
- [ ] D.3 Team mode: `mode: "team"` and `relay_url`, with the relay itself

**Silent failures to handle in their steps**
- 8.1: a custom watcher ignore list must not drop the defaults (`.git`, `node_modules`)
- 9.3: refuse to install when `core.hooksPath` points git elsewhere

## Checkpoints

- **After the design stage, 30 October:** the identity model decision may change where the session identifier comes from. That touches configuration and the agent tools, not the lock engine.
- **From Phase 7 onwards:** running the CLI uses `~/.meshlock`, which the old build shares. Point `HOME` at a temporary directory first.
- **Priorities:** the PID by 9 October and the requirements specification come before rebuild steps.
