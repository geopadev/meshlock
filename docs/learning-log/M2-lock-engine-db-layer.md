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

---

## M2.2 — lock engine functions and race handling (2026-06-21)

**Built:** Five exported functions over MeshLockDatabase: acquireLock (check-and-set
inside a BEGIN IMMEDIATE transaction, returns a discriminated union — ok/conflict —
not a throw), releaseLock (ownership-guarded delete), checkLock (live vs expired
vs free), listLocks (non-expired rows), expireStaleLocks (sweep by expiry). Exported
TypeScript types for inputs and results (Lock, LockMode, AcquireResult, CheckResult).
11 tests covering conflict, same-session refresh, release ownership, TTL expiry,
stale sweep, and IMMEDIATE concurrency contention.

**Why this design:** Conflict is an expected outcome, not a programmer error — returning
a discriminated union forces callers to handle it explicitly rather than catching an
exception they might silently swallow. BEGIN IMMEDIATE serializes the read-then-write
at BEGIN so two connections can never both pass the "no lock" check and collide on
the write. ISO-8601 strings sort lexically in chronological order, so expiry checks
work as plain string comparisons without parsing.

**Concepts:** discriminated unions, type narrowing, interface vs type, UPSERT
(INSERT ON CONFLICT DO UPDATE), BEGIN IMMEDIATE vs deferred transactions,
error.code vs error.message, SQLite changes count, ISO-8601 lexical ordering

**Interview Qs:**
Q: AcquireResult is a discriminated union with ok as the discriminant. After you write if (result.ok === false), why does TypeScript let you access result.heldBy inside that block but not result.lock? What's this behaviour called?
A: it's because we implicitely told it to use held by and it doesn't know what .lock is. (Got the outcome right — inside the block .lock isn't accessible — but the mechanism was vague. Did not name "type narrowing" or explain that TypeScript eliminates the ok: true branch from the union based on the if condition alone.)

Q: Why does acquireLock use BEGIN IMMEDIATE instead of the default deferred transaction? Describe the specific bad sequence that could happen between two connections if it used deferred.
A: it uses begin immediate instead of the default deferred because with deferred two agents can aquire the same lock whereas with begin immediate it goes through the database and the first one who acquires gets it and the one who doesn't has to wait. (Got the conclusion right but skipped the mechanism: both connections read "no lock," both decide to write, only then do they collide — the check and the act aren't atomic with deferred.)

Q: The code compares timestamps with existing.expires_at > now — plain string > on two ISO-8601 strings, no Date parsing. Why is that correct rather than a lucky accident?
A: I don't know.

Q: releaseLock deletes with WHERE path = ? AND session_id = ? and returns result.changes > 0. Explain how this one query makes "releasing a lock you don't own" a harmless no-op rather than an error — without any explicit ownership if check.
A: because it doesn't match with any tables so no harm done. (Right direction — zero rows affected — but imprecise: it matches the right table, just zero rows, because the session_id in the WHERE doesn't match the holder's.)

Q: My concurrency test first failed because I wrote /SQLITE_BUSY/.test(String(err)) and the error message was actually "database is locked". What was the underlying mistake about where SQLITE_BUSY lives on the error object, and what's the general lesson about asserting on caught errors?
A: I didn't fully grasp the concept nor understand.

**Still fuzzy:**

What type narrowing is mechanically — that TypeScript eliminates union branches based on what the if condition proves, not what you "told it" (Q1)
The exact deferred failure sequence — both connections passing the read before either writes (Q2, partial)
Why ISO-8601 string comparison is correct: fixed-width, zero-padded, largest unit first (Q3)
The distinction between "matching no rows" and "matching no tables" — the WHERE filters rows within the right table (Q4, partial)
Error object structure: .code vs .message, and why structured properties are more reliable than stringified messages (Q5)

---

## M2.2 (cont.) — lock engine test file (2026-06-21)

**Built:** 12-test file for lock-engine.ts covering: conflict (ok:false, reason:held,
heldBy, one row owned by A), same-session re-acquire (expires_at advances, one row),
release ownership (B gets false, A gets true, checkLock reports free), TTL expiry via
seeded past-expiry row (checkLock free, fresh acquire succeeds), listLocks (expired
excluded), expireStaleLocks (count returned, live rows survive), and two concurrency
tests (SQLITE_BUSY proof of write-lock contention; one-winner-one-conflict outcome
across two connections).

**Why this design:** seedLock helper inserts rows with arbitrary expiry timestamps,
bypassing acquireLock which always sets expiry in the future — needed for expired-lock
tests without real waiting. Split concurrency into two tests: one proves the IMMEDIATE
write lock serializes connections (SQLITE_BUSY), one proves the winner/conflict outcome.
Neither alone satisfies both requirements.

**Concepts:** test helpers, optional parameters (path?), toEqual vs toBe for objects,
seeding vs real calls, finally cleanup for leaked transactions, why two concurrency
tests are needed

**Interview Qs:**
Q: Why did I write a separate seedLock helper that inserts rows with raw SQL, instead of just calling acquireLock to set up the expired-lock tests?
A: (did not attempt)

Q: In rowCount(conn, path?), the ? makes path optional. Why does TypeScript force the if (path === undefined) check before I can use path in .get(path)?
A: (did not attempt)

Q: The conflict test uses one expect(b).toEqual({...}) instead of three separate field checks. What does toEqual on the whole object catch that three separate toBe checks would not?
A: (did not attempt)

Q: There are two concurrency tests. Why isn't test 2 alone (one winner, one conflict) sufficient to prove the connections contend through BEGIN IMMEDIATE?
A: (did not attempt)

Q: In the finally block, why does if (connA.inTransaction) connA.exec("ROLLBACK") matter for other tests in the file, not just this one?
A: for one agent to not stay locked after the test runs. (Right — an open transaction holds the write lock on the DB file; without the rollback, cleanup might not fully release it and the next test's openDatabase could be affected. Correct instinct, mechanism slightly incomplete.)

**Still fuzzy:**

Why seedLock exists — that acquireLock always writes future expiry, making past-expiry rows impossible without raw SQL (Q1)
Optional parameters and TypeScript's string | undefined narrowing — why the check is required before use (Q2)
toEqual vs three toBe checks — toEqual catches extra or misnamed fields, three checks don't (Q3)
Why test 1 (SQLITE_BUSY) is needed alongside test 2 — sequential calls would pass test 2 even without IMMEDIATE (Q4)
Transaction leak mechanism — Q5 instinct was right but the file-lock-to-next-test chain wasn't fully articulated
