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
A: (awaiting your answer)

Q: repo_root is NON-NULL (a sentinel) but branch is nullable. Given UNIQUE(repo_root, path, branch), what goes wrong if repo_root were allowed to be NULL?
A: (awaiting your answer)

Q: We added DEFAULT '(unknown)' to repo_root. Why was that necessary given lock-engine.ts was left untouched — what would the next acquireLock have done without it?
A: (awaiting your answer)

Q: Migration 003 rebuilds the entire table instead of using ALTER TABLE ADD COLUMN. Adding a column is actually supported in SQLite — so what specifically forces the full rebuild here?
A: (awaiting your answer)

Q: getRepoRoot returns string (never null); getCurrentBranch returns string | null. How does that difference in return type reflect how each value is meant to be used?
A: (awaiting your answer)

**Still fuzzy:**

(to be filled in after the quiz answers)
