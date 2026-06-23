# S1 — repo scoping

## S1a — getRepoRoot helper + 003 migration (storage foundation) (2026-06-23)

**Built:** The storage foundation for scoping locks per repository (so one global
`meshlock init` registration can serve every repo). Two pieces, no engine change:

- `core/git.ts` gains `getRepoRoot(cwd?)`, a sibling to `getCurrentBranch`. It resolves the
  git repo root via `git rev-parse --show-toplevel`, and — unlike branch — returns a non-null
  SENTINEL: when cwd is not in a git repo (or any git error), it returns `resolve(cwd)`, the
  directory's own absolute path. Cached per cwd in a separate Map with the same TTL;
  `clearBranchCache()` now clears both the branch and repo-root caches.
- Migration `003` rebuilds the locks table (same create/copy/drop/rename pattern as 002) to add
  `repo_root TEXT NOT NULL DEFAULT '(unknown)'` and change uniqueness to
  `UNIQUE(repo_root, path, branch)`.

`db.test.ts` updated for the post-003 schema (column set, repo_root NOT NULL, the three-way
unique index, and 003 recorded). `git.test.ts` adds real-repo getRepoRoot tests.

**Why this design:** Lock identity is becoming `(repo_root, path, branch)`. repo_root is resolved
from the FILE's directory (dirname(path)) because repo membership is a property of where the file
lives — the same input that was WRONG for branch in M3.2c (branch is a whole-repo property,
resolved from cwd) is RIGHT here, because it's a different question. repo_root is a non-null
sentinel rather than nullable so it never falls into the NULL-uniqueness trap that branch
deliberately uses: SQLite treats NULLs as distinct, so a nullable repo_root would let duplicate
"unknown-repo" rows slip past UNIQUE — a non-null sentinel makes the constraint behave normally.
The DEFAULT '(unknown)' is what lets the still-untouched engine (whose INSERT does not list
repo_root) keep writing valid rows until S1b/S1c wire a real value through.

**Concepts:** sentinel value vs NULL, NULL-uniqueness trap (why a column in a UNIQUE constraint
wants to be non-null), column DEFAULT as a compatibility shim for an unmodified writer, "same
input, different question" (dirname(path) for repo membership vs cwd for branch), SQLite
table-rebuild for constraint changes (ALTER can't change a UNIQUE constraint in place), separate
caches for separate facts, return type string vs string | null encoding "always present" vs "may
be absent".

**Interview Qs:**
Q: getRepoRoot resolves from the file's directory (dirname(path), in S1c) while getCurrentBranch resolves from cwd. Why is dirname(path) the right base for repo_root when it was the wrong base for branch?
A: because unlike branches, repos are the directories actual path. (Partial. The real distinction is which directory we resolve FROM: repo_root is resolved from dirname(path) — where the FILE lives — because "which repo does this file belong to?" depends on the file's location. branch is a whole-repo property (one HEAD), so it's resolved from the daemon's cwd. Same kind of input, different question.)

Q: repo_root is NON-NULL (a sentinel) but branch is nullable. Given UNIQUE(repo_root, path, branch), what goes wrong if repo_root were allowed to be NULL?
A: because for the repo we need the root to be the cwd. (Two corrections. First, repo_root is resolved from dirname(path), NOT cwd — that's branch's base, not repo_root's. Second, the actual answer is the NULL-uniqueness trap: SQLite treats every NULL as distinct, so if repo_root were NULL, two rows with the same (path, branch) but NULL repo_root would BOTH be allowed past UNIQUE — duplicate locks for one location. A non-null sentinel makes the constraint compare normally.)

Q: We added DEFAULT '(unknown)' to repo_root. Why was that necessary given lock-engine.ts was left untouched — what would the next acquireLock have done without it?
A: I don't know. (The engine's INSERT lists explicit columns and does not include repo_root. A NOT NULL column with no default + an INSERT that omits it = "NOT NULL constraint failed" — so the next acquireLock would have thrown and every acquire would fail. The DEFAULT supplies the sentinel for the omitted column, keeping the untouched engine working until S1b/S1c list repo_root explicitly.)

Q: Migration 003 rebuilds the entire table instead of using ALTER TABLE ADD COLUMN. Adding a column is actually supported in SQLite — so what specifically forces the full rebuild here?
A: Because it can't change the tables unique constraint in place. (Correct. ADD COLUMN could add repo_root, but the UNIQUE constraint is changing from (path, branch) to (repo_root, path, branch), and SQLite cannot alter a constraint in place — so the table must be rebuilt.)

Q: getRepoRoot returns string (never null); getCurrentBranch returns string | null. How does that difference in return type reflect how each value is meant to be used?
A: the repos root needs to be the users cwd which is a string unlike branchless that is allowed to be null. (The return-type half is right: repo_root is always a string, so callers never null-check it; branch may be null, so callers must handle "no branch". The "users cwd" part is the same mix-up — repo_root is resolved from dirname(path), and even outside a repo it's a real string (the sentinel), never null.)

**Still fuzzy:**

The resolution base — repo_root comes from dirname(path) (where the file lives), branch from cwd (whole-repo property); they are NOT the same source (Q1, Q2, Q5)
The NULL-uniqueness trap — why a nullable repo_root would let duplicate rows past UNIQUE, and why a non-null sentinel avoids it (Q2)
Why the NOT NULL column needed a DEFAULT — the untouched engine's INSERT omits repo_root, so without a default the next acquireLock throws (Q3)

---

## S1b — repo-scoped engine identity (+ 004 migration) (2026-06-23)

**Built:** The engine's five functions became repo-scoped — lock identity went from
(path, branch) to (repo_root, path, branch) — and migration 004 removed the S1a
DEFAULT '(unknown)' shim. AcquireInput and ReleaseInput gained a REQUIRED repoRoot
string; Lock gained repo_root. Every engine WHERE now leads with repo_root = ?
(plain `=`, since repo_root is a non-null sentinel; branch keeps `IS` for null-safety):
acquireLock's same/cross selects + delete + insert, releaseLock's delete, checkLock and
listLocks (both now take a repoRoot param). expireStaleLocks is the one exception — it
stays global, because reaping expired rows is repo-agnostic housekeeping. The M2.5 branch
logic is unchanged in spirit; it now runs inside the repo filter. 004 rebuilds the table
with repo_root NOT NULL and NO default, so a missing repo_root now throws.

The MCP tools were deliberately NOT updated, so they no longer typecheck — that compile
failure is the intended forcing function for S1c. The three core suites (engine, db, git)
pass in isolation; the mcp suites are expected to fail until S1c supplies repoRoot.

**Why this design:** The cross-repo-leak risk is the whole story: one global MCP server
serves many repos, so if a single WHERE omitted repo_root, that operation would see locks
across repos (acquiring src/index.ts in repo A would block because repo B holds the same
path). Leading every WHERE with repo_root prevents it; the two-repo isolation test (same
path, same branch, different repo → both succeed, neither conflicts) is the proof. Making
repoRoot a required param (not optional) turns "forgot to scope" into a compile error at
every call site. Removing the default makes a missing repo_root fail loud instead of being
silently absorbed into a fake '(unknown)' repo — the worst outcome for an identity column.

**Concepts:** identity as a composite key (repo_root, path, branch), repo-scoped WHERE on
every query, required param as a type-level guard (compile error if omitted), fail-loud vs
fail-silent for identity columns (dropping the DEFAULT), `=` for a non-null sentinel vs `IS`
for a nullable column in the same WHERE, the one intentional exception (expireStaleLocks
stays global), an intentional compile break as a forcing function for the next milestone.

**Interview Qs:**
Q: The cross-repo-leak risk: if ONE engine WHERE (say selectSame) forgot `repo_root = ?`, what would the bug look like at runtime, and which test would catch it?
A: it would throw loudly at runtime missing root directory string. (Incorrect — and this is the crucial point. Forgetting repo_root in a WHERE does NOT throw; it fails SILENTLY. The query would match rows from OTHER repos: e.g. acquiring src/index.ts in repo A would find repo B's lock and wrongly block, or checkLock/listLocks would return another repo's rows. No error at all — that quietness is exactly why it's dangerous. (A throw happens in a different case: omitting repo_root from an INSERT value, since the column is NOT NULL — that's Q3.) The two-repo isolation test catches the WHERE leak: B's acquire would fail instead of succeeding.)

Q: repoRoot is a REQUIRED field on AcquireInput, not optional-with-a-default. What does making it required buy us at the call sites, and what did that choice do to the MCP tools right now?
A: it bought us certainty that it isn't allowed to work without a directory on accident. (Correct. A required field makes "forgot to scope" a compile error, not a runtime surprise — you cannot call the engine without a repo by accident. The cost/effect right now: the MCP tools, which don't pass repoRoot yet, no longer typecheck — that compile break is the deliberate forcing function for S1c.)

Q: Migration 004 removes the DEFAULT '(unknown)'. Why is "throw when repo_root is missing" the better failure mode than "absorb it into '(unknown)'" for an identity column?
A: because it would have phantom locks not contributing to anything. (Right direction. With the default, a missing repo_root would silently create real-looking locks in a fake '(unknown)' repo — phantom locks that never match the real repo and hide the bug. Throwing surfaces the bug immediately. The principle: for an identity column, fail loud beats fail silent.)

Q: expireStaleLocks is the one function that does NOT filter by repo_root. Why is that correct rather than a cross-repo leak?
A: because they are garbage and we don't care about them since anyway they are going to get swept away. (Correct. An expired lock is garbage regardless of which repo it belonged to, so reaping them all in one global sweep is right — there's nothing to "leak" because we're deleting dead rows, not reading or comparing live ones.)

Q: In selectSame the WHERE is `repo_root = ? AND path = ? AND branch IS ?` — plain `=` for repo_root but `IS` for branch. Why the two different operators in one query?
A: because branch can be null and null = null in sql is false so is makes it true. (Right that branch needs IS for null-safety — small fix: NULL = NULL evaluates to NULL/unknown, not false, though in a WHERE that still excludes the row. The other half: repo_root uses = because it's a non-null sentinel — it can never be null, so plain = is correct and honest.)

**Still fuzzy:**

The cross-repo leak fails SILENTLY, not loudly — a forgotten repo_root in a WHERE reads other repos' rows with no error; the isolation test is what catches it (Q1)
INSERT-omits-repo_root (throws, NOT NULL) vs WHERE-omits-repo_root (silent leak) are two different failure modes (Q1, Q3)
NULL = NULL is unknown (not false); repo_root uses = only because it is a guaranteed non-null sentinel (Q5)
