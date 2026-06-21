# M2 — lock engine and DB layer

## M2.1 — SQLite wrapper and first migration (2026-06-21)

**Built:** A better-sqlite3 wrapper (openDatabase) that opens a SQLite file at a
parameterized path, enables WAL journal mode, ensures a migrations bookkeeping
table, and applies any unrecorded .sql files in data/migrations in filename
order, one transaction per migration. The first migration creates a locks table
whose columns reuse config.ts terminology (mode, path).

**Why this design:** A migrations table plus one-transaction-per-migration makes
schema setup idempotent and crash-safe — reopening the DB skips already-applied
migrations, and a crash mid-migration rolls back cleanly instead of leaving a
half-applied schema that can never re-run.

**Concepts:** sync vs async I/O APIs, default vs named imports, type aliases,
@types packages, type assertions (as), non-null assertions (!), import.meta.url
vs __dirname, PRAGMA/WAL, parameterized queries, database transactions

**Interview Qs:**
Q: Why did db.ts use readFileSync (from node:fs) while config.ts used await readFile (from node:fs/promises)? What is it about better-sqlite3 that drives this choice?
A: (did not attempt — said "I don't know if I answered this correctly nor how to answer the rest")

Q: We installed two packages for SQLite: better-sqlite3 and @types/better-sqlite3. What does the second one contain, why is it a devDependency, and how is this different from how we installed zod?
A: (did not attempt)

Q: In the test, db.prepare("...").all() returns unknown[], and we wrote as { name: string }[]. What is that as doing, and what's the risk of using it — i.e., what could go wrong that TypeScript would not catch for you?
A: It identifies the type since we don't have a way of knowing it without it. (Got that the assertion supplies a type TypeScript otherwise can't know, but did not mention the risk — that TypeScript trusts the assertion blindly and won't catch a mismatch with the real runtime data.)

Q: import.meta.url and fileURLToPath appear together to build MIGRATIONS_DIR. What CommonJS feature are they replacing, and why couldn't we just use that older feature in this project?
A: (did not attempt)

Q: Each migration runs inside db.transaction(...) that does both the schema change and the INSERT into the migrations table. Why bundle those two operations together rather than running the SQL first and recording it afterward as two separate steps?
A: (did not attempt)

**Still fuzzy:**

Why better-sqlite3 is synchronous and when sync I/O is the right choice over async (Q1)
The two-package pattern: what @types/* packages contain and why some libraries need them while others (zod) don't (Q2)
The risk side of type assertions — that `as` overrides the checker and won't catch a runtime mismatch (Q3, partial)
The ESM replacement for __dirname and why __dirname doesn't exist under "type": "module" (Q4)
Why atomic transactions matter for crash safety — what breaks if the schema change and the bookkeeping insert are separate steps (Q5)
