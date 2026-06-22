# M3 — MCP server

## M3.1 — MCP server skeleton and check_lock (2026-06-21)

**Built:** An MCP server (@modelcontextprotocol/sdk) assembled from primitives:
McpServer + StdioServerTransport, registering one tool, check_lock. The tool lives
in tools/check-lock.ts as a Zod input schema, a config object, and a handler factory
makeCheckLockHandler(db) that closes over an injected MeshLockDatabase and calls
checkLock from the engine, returning a text CallToolResult (free vs held-by-session).
server.ts opens the DB once at ~/.meshlock/meshlock.db, registers the tool, and
connects stdio; all diagnostics go to stderr so stdout stays clean for the protocol.
2 handler-level tests (free path, held path).

**Why this design:** The handler is a factory closing over db, not a module-level
singleton and not opening the DB per call — one connection for the server's life, and
trivially testable with a temp DB. stdout is the MCP wire channel under stdio transport,
so any non-protocol bytes there corrupt the stream; every diagnostic uses console.error.
A boot probe caught that openDatabase doesn't create ~/.meshlock — fixed in server.ts
with mkdirSync (db.ts was out of scope).

**Concepts:** MCP stdio transport, stdout-as-protocol-channel, handler factory /
dependency injection, Zod raw shape as tool input schema, SDK-generated JSON schema,
import.meta.url === argv[1] entry guard, mkdirSync recursive

**Interview Qs:**
Q: makeCheckLockHandler(db) is a factory that returns the handler, capturing db in a closure. How does this satisfy both "don't open the DB inside the handler" and "don't use a module-level singleton", and why does it make the handler easy to test?
A: It satisfies it because creating a database each time we call the tool is not adequate and it makes it easy to test because it reuses the existing database. (Correct on both halves — per-call open is wasteful, and the injected db is reused so tests pass a temp DB. Did not explicitly name the third leg: no module-level singleton because db is handed in, so importing the module runs nothing on its own.)

Q: Every diagnostic uses console.error, never console.log. What would break with console.log, and why did no unit test catch this?
A: it would corrupt the files since we don't want the human readable version but the one that can be matched with the regex. (Right that it corrupts something, but the mechanism was wrong — it's not about regex. stdout is the protocol channel; console.log puts human text on stdout interleaved with JSON-RPC, which the agent fails to parse. console.error goes to stderr, a separate stream. No unit test caught it because the tests call the handler directly and never start the stdio transport.)

Q: The bottom guards main() with import.meta.url === file://${process.argv[1]}. What does it accomplish, and what would go wrong in the test file without it?
A: it only executes when a main exists, if it runs as a program. (Right intuition — runs only when executed directly — but imprecise: main always exists as a function; the guard checks whether THIS file is the script node launched. Without it, importing server.js in the test would fire main(), opening the real DB and grabbing stdio at import time.)

Q: checkLockInputSchema is a Zod raw shape, but we never call .parse() in the handler. Who runs the validation, and what else does the SDK do with that schema?
A: I don't remember exactly. (The SDK validates incoming arguments against the schema before the handler runs, so path is a guaranteed string. It also converts the Zod shape to JSON Schema and publishes it in tools/list so the agent knows the tool's contract.)

Q: openDatabase crashes when ~/.meshlock doesn't exist. Why fix it in server.ts not db.ts, and what does { recursive: true } guarantee on every boot?
A: I don't know. (db.ts was a must-not-change file, so the fix belongs in the in-scope boot path. { recursive: true } creates missing parents AND doesn't throw if the dir already exists, so calling mkdirSync every boot is safe — first boot creates it, later boots are no-ops.)

**Still fuzzy:**

The third leg of the factory argument — no module-level singleton, so importing the module opens nothing (Q1, partial)
stdout vs stderr as two separate streams, and why stdout is reserved for the MCP protocol under stdio transport (Q2)
What import.meta.url === argv[1] actually compares — module URL vs the launched script path (Q3)
Who validates tool input (the SDK, before the handler) and that the same Zod schema becomes the advertised JSON Schema in tools/list (Q4)
Why the fix went in server.ts not db.ts (scope), and what { recursive: true } guarantees about repeated calls (Q5)

---

## M3.1b — centralize DB path + dir creation (2026-06-21)

**Built:** Moved the DB file path out of server.ts and into config.ts as getDatabasePath(),
making config.ts the single source of truth for all MeshLock file locations. Moved the
mkdirSync directory-creation guarantee into openDatabase itself, so any caller gets the
directory for free instead of having to call mkdirSync first. server.ts boot path shrinks
to two lines: get path, open DB.

**Why this design:** Two problems existed — the DB path was duplicated across config.ts
and a local helper in server.ts, and the responsibility for creating ~/.meshlock was in
the wrong layer (the server, not the DB opener). Pushing mkdirSync into openDatabase
means future callers can't forget to create the directory. getDatabasePath() in config.ts
means the .meshlock folder name is defined in exactly one place.

**Concepts:** Single source of truth, pushing responsibility to the right layer,
{ recursive: true } as an idempotent mkdir, unused imports as a compile error in strict
TypeScript, dirname() to get a file's parent directory.

**Interview Qs:**
Q: If you inlined join(homedir(), ".meshlock", "meshlock.db") directly in server.ts instead of creating getDatabasePath(), what problem would that create?
A: I don't know. (Two places would know the folder name ".meshlock" — config.ts and server.ts. If you renamed the folder, you'd have to update both and could miss one. getDatabasePath() means the folder name lives in one place only.)

Q: mkdirSync(dirname(path), { recursive: true }) now runs inside every openDatabase call, including every test's beforeEach. Why is this safe, and what would happen without { recursive: true } on the second call?
A: it is safe because it creates the database where it needs to be created and if already created it doesn't throw an error. without recursive true it would throw an error. (Correct — { recursive: true } makes mkdirSync idempotent: first call creates the dir, every subsequent call is a no-op. Without it, the second call would throw EEXIST.)

Q: Before this change, server.ts imported mkdirSync from node:fs and dirname from node:path. Both are now gone. What TypeScript rule means leaving an unused import is actually a problem, not just untidiness?
A: it reads the files as modules? (Not quite — TypeScript's strict mode includes noUnusedLocals, which treats an unused import as a compile error. The import isn't causing a runtime problem; the compiler rejects it at build time so dead code can't accumulate silently.)

Q: The test asserts dirname(getDatabasePath()) === dirname(getConfigPath()). What does this test actually prove, and why is that the right thing to check rather than the full path string?
A: it checks that the types of the database are inferred from the config? (Not quite — it checks that the DB file and the config file sit in the same directory (.meshlock). Checking the full path would over-constrain the test to one specific machine's home dir. Checking just the parent dir proves the two paths share the same folder without hardcoding what that folder is.)

Q: openDatabase is a low-level infrastructure function. We gave it a side effect: it now creates a directory. Name one scenario where adding a side effect to a low-level function could cause a problem.
A: I don't know. (One example: if you call openDatabase in a read-only context — like a tool that only inspects an existing DB — it would silently create ~/.meshlock on a machine where you never intended to write anything. Side effects in low-level functions are invisible to callers who don't read the implementation.)

**Still fuzzy:**

Why getDatabasePath() matters — the "single source of truth" argument for avoiding duplication (Q1)
What noUnusedLocals does and why TypeScript treats unused imports as errors in strict mode (Q3)
What dirname(getDatabasePath()) === dirname(getConfigPath()) is actually asserting — same parent folder, not same full path (Q4)
Why side effects in low-level functions are risky — invisible to callers, can fire in unexpected contexts (Q5)

---

## M3.2 — acquire_lock tool (+ simple-git, + shared cross-branch default) (2026-06-22)

**Built:** The first mutating MCP tool, acquire_lock. It takes only a path; the tool
resolves the current git branch itself with simple-git (new dependency), falling back to
null when there is no repo / detached HEAD / any git error — so git is never a hard
requirement. The handler factory makeAcquireLockHandler(db, config) closes over the DB and
the loaded config, reads session_id / lock_mode / lock_timeout / cross_branch_mode from
config, and calls the synchronous acquireLock engine. server.ts now loads config once and
registers acquire_lock alongside check_lock. The M2.5 double-default bug is fixed: a single
exported DEFAULT_CROSS_BRANCH_MODE constant in config.ts is used both by defaultConfig() and
by the engine's fallback, so they can't diverge. 5 handler tests.

**Why this design:** Branch resolution is async git I/O; it happens in the handler BEFORE
the engine call, so nothing async ever enters the BEGIN IMMEDIATE transaction (the engine
stays synchronous and pure). The tool catches every git failure and treats it as a null
branch rather than surfacing an error — MeshLock works outside git. Config is injected into
the factory (same DI discipline as the DB handle) so the handler never re-reads config per
call. The shared default constant removes the two-copies-of-one-fact bug from M2.5.

**Concepts:** async tool handlers (Promise<CallToolResult>), simple-git revparse, try/catch
fallback to a sentinel (null) instead of throwing, dependency injection of config, shared
constant as single source of truth, value-vs-type imports (import { x, type Y }), dependency
direction (mcp may import core; core must never import mcp).

**Interview Qs:**
Q: Why does branch resolution happen in the handler (async) and not inside acquireLock? What rule about the BEGIN IMMEDIATE transaction would be broken otherwise?
A: so the whole process remains synchronized instead of turning everything async and creating other issues. (Right instinct — keep the engine synchronous. The specific cost: an await inside BEGIN IMMEDIATE would hold the RESERVED write lock on the SQLite file for the whole unpredictable duration of the git subprocess, blocking every other connection. better-sqlite3 is synchronous by design, so you resolve the branch first, then make the sync engine call.)

Q: resolveBranch wraps simple-git in try/catch and returns null on any failure. Why is "no git" treated as a branchless lock rather than an error the tool reports? What did M2.5 decide about null branches?
A: It stays like that so the user can still use the tool without having git or being in a repo. (Correct. Git is not a hard requirement; M2.5 decided null means "no branch / not a git repo" and the engine treats all nulls as one shared logical branch, so a null branch flows through normally instead of erroring.)

Q: M2.5 left config defaulting cross_branch_mode to "warn" but the engine defaulting to "block". How does a single exported DEFAULT_CROSS_BRANCH_MODE constant make it impossible for the two to disagree?
A: because the source of truth they have is the same coming from the config, when that source of truth changes back to block, both use block. (Correct. One exported constant, imported by both defaultConfig() and the engine fallback. Change it once and both change together — there is no second copy to forget.)

Q: makeAcquireLockHandler takes (db, config). Why pass config into the factory instead of calling loadConfig() inside the handler on each call?
A: I am not sure. (loadConfig() is async and reads + parses the file from disk; doing it per call would add a disk read on every acquire and force the handler to be async just for that. Injecting it once at boot captures a single consistent snapshot, keeps git the handler's only async dependency, and — same as the DB handle — lets tests pass a fake config without writing a file.)

Q: The config-wiring test seeds a "main" lock by another session, then calls the tool (which resolves branch=null). Explain how that one setup produces a CROSS-branch conflict, and why it proves the config value actually reaches the engine.
A: since the wiring seeds a main and the branch resolve to null there is a mismatch resulting in a conflict, we know it reaches it because of the error? (Mostly right on the mismatch: null vs "main" is a different branch held by another session = cross-branch. But whether that becomes a block or a warning is decided by config.cross_branch_mode. The proof isn't "an error" — it's that the OUTCOME tracks the config: same setup, config "block" → conflict text, config "warn" → acquired + warning. The outcome changing with the config value is what proves the value reached the engine.)

**Still fuzzy:**

What an await inside BEGIN IMMEDIATE actually costs — the held write lock blocking other connections for the git subprocess's duration (Q1, partial)
Why config is injected once rather than loaded per call — async disk read, consistent snapshot, testability (Q4)
What proves the config value reached the engine — the outcome tracking the config (block vs warn), not the presence of an error (Q5, partial)

---

## M3.2b — release_lock tool (2026-06-22)

**Built:** The counterpart to acquire_lock: release_lock lets a session give back a lock it
holds. Deliberately the simple tool — no git, no simple-git, no async branch resolution. The
handler factory makeReleaseLockHandler(db, config) closes over the DB and config, reads
config.session_id (release is ownership-scoped), and calls the engine's releaseLock. The
engine deletes WHERE path = ? AND session_id = ? — no branch filter — so one release drops
all of the session's locks on that path across every branch. The engine returns a boolean:
true → "Released", false → "Nothing to release" (a harmless no-op, not an error). server.ts
registers release_lock alongside check_lock and acquire_lock. 4 handler tests.

**Why this design:** Release is intentionally branch-agnostic — the existing engine
releaseLock already ignores branch, and "release everything I hold on this path" is the
sensible default; selective per-branch release is a future backlog item, not this milestone.
Releasing a lock you don't own returns false rather than throwing, so the tool reports it
plainly instead of erroring — same no-op philosophy as the engine. The handler is synchronous
(no git to await), the simplest tool in the set.

**Concepts:** ownership-scoped delete (path + session_id), boolean result → two text outcomes,
no-op vs error semantics, branch-agnostic delete, synchronous handler (contrast with
acquire_lock's async), reusing an engine function unchanged through a thin adapter.

**Interview Qs:**
Q: release_lock is synchronous while acquire_lock is async. What is the single reason for that difference?
A: because acquire lock has to wait for simple-git to run where release doesn't need the branch name so doesn't need to wait for anything. (Correct. acquire_lock awaits the git subprocess to resolve the branch; release has nothing to await, so it stays synchronous. Async is only for code that actually waits on something.)

Q: The engine's releaseLock deletes WHERE path = ? AND session_id = ? with no branch clause. What is the user-visible consequence when a session holds the same path on two branches and calls release_lock once?
A: it releases the lock of the path meaning it releases throughout all the branches, it becomes free for someone else to acquire throughout any branch. (Correct. No branch filter means every row for that (path, session) is deleted in one call — both branch locks go, and the path is free on every branch.)

Q: Releasing a lock you don't own returns false and the tool says "Nothing to release" rather than throwing an error. Why is that the right behaviour, not a missed error case?
A: because it is not an error it is an expected behaviour so we let it go through. (Correct. Releasing something you don't hold is an ordinary, expected event — returned as data (false), not an exception. Exceptions are reserved for things that shouldn't happen, like DB faults.)

Q: The handler passes config.session_id into releaseLock. Why does release need the session id at all — what would go wrong if it deleted by path alone?
A: because the session id tells us which row to delete to release the lock. (On the right track, but the key point is ownership: without session_id in the WHERE clause, a release by path alone would delete ANY session's lock on that path — one agent could free another agent's lock. The session_id scopes the delete so you can only release your own.)

Q: release_lock reuses the engine's releaseLock unchanged — the tool is a thin adapter. What belongs in the tool layer versus the engine layer, and why keep lock logic out of the tool?
A: in the tool layer we keep what the agent sees to search and call the tool, and the logic resides in the engine layer. (Correct. The tool owns the agent-facing surface — input schema, description, the wording of the reply. The engine owns how locks work — the SQL and the ownership rule. Keeping logic in the engine means it's tested once and every tool just adapts it; and the dependency only points mcp → core, never back.)

**Still fuzzy:**

Why deleting by path alone is unsafe — without session_id any agent could release any agent's lock; session_id scopes the delete to your own (Q4, partial)

---

## M3.2c — shared cached branch resolver (core/git.ts) (2026-06-23)

**Built:** A focused refactor. Branch resolution moved out of acquire-lock.ts into a new pure
utility, core/git.ts, exporting getCurrentBranch(cwd?) — resolves the repo's branch via
simple-git, maps detached/empty/error to null, and caches the result per cwd for a short TTL
(BRANCH_CACHE_TTL_MS = 5000) so repeated tool calls spawn at most one git subprocess per
window. Also exports clearBranchCache() for tests. acquire-lock.ts now calls getCurrentBranch()
with no argument (defaulting to process.cwd() — the daemon's repo) instead of resolving from
dirname(path). This fixes two M3.2 issues: wrong resolution base (#1) and a subprocess per call
(#2). git.test.ts uses real temp git repos (init + commit + checkout) so the named-branch path
is genuinely exercised, closing the M3.2 coverage gap; it also tests the cache hit and the
re-resolve after clearBranchCache. No engine, config, or schema changes.

**Why this design:** A git branch is a property of the whole repository (one HEAD), not of a
file's directory — so resolving from process.cwd() (the repo root the daemon runs in) is
correct, where dirname(path) was not. The short-TTL cache bounds both cost (one git call per
window) and staleness (a checkout is picked up within the TTL) — a deliberate tradeoff. core/git.ts
is a pure utility: it imports neither config, the DB, nor anything from mcp/, so the dependency
direction stays inward.

**What changed in the acquire test (cwd note):** acquire_lock now resolves from process.cwd(),
and vitest runs inside the meshlock git repo — so without intervention the branchless tests
would resolve meshlock's real branch instead of null. Rather than rewrite assertions, the test
chdir()s into the non-git temp dir in beforeEach (restoring cwd in afterEach), so resolution
falls back to null exactly as before. Every existing assertion is unchanged; only setup/teardown
and two comments were touched.

**Concepts:** module-level cache with TTL (cost vs staleness tradeoff), cache keyed by input
(cwd), moving a utility into core/ for reuse + dependency direction, process.cwd() vs a file's
dirname as the resolution base, process.chdir in tests (works under vitest's forks pool),
clearing module-level state between tests.

**Interview Qs:**
Q: Why resolve the branch from process.cwd() (the repo) instead of dirname(path) (the locked file's directory)? What was actually wrong with the old base?
A: because the root is supposed to be from the daemons current directory, not the path of each file independently. (Correct. A branch is a property of the whole repository — one HEAD — not of any individual file's directory, so the repo root (the daemon's cwd) is the right base. dirname(path) could also point somewhere that resolves the wrong repo or null.)

Q: The cache has a 5-second TTL. Describe the two things that TTL is balancing — what gets worse if it were 0ms, and what gets worse if it were 1 hour?
A: it balances staleness and slowness at 0 ms slowness and at 1 hour staleness. (Correct. 0ms → a git subprocess on every call (slow); 1 hour → a branch switch wouldn't be noticed for an hour (stale). 5s is the middle ground.)

Q: The cache is a Map keyed by cwd, not a single variable. Why key by cwd at all — when would a single shared cached value give a wrong answer?
A: because when two different repos exist if it was just one variable one of the callers working on the repo that is not cached in the single variable will get the wrong reply. (Correct. With a single variable the second repo would receive the first repo's cached branch. Keying by cwd gives each repository its own entry — like memoizing by argument.)

Q: core/git.ts is allowed to be imported by acquire-lock.ts (mcp), but core/git.ts must not import anything from mcp/. What is that rule called and why does it matter for a utility like this?
A: because the mcp has to be the caller not the other way around. keeps the core a pure reusable foundation that the mcp depends on. (Right idea. The rule's name is dependency direction — dependencies point inward, toward core. It matters because it prevents import cycles and keeps core testable and reusable in isolation: M3.5 and M5 can reuse getCurrentBranch without pulling in the MCP server.)

Q: The acquire test chdir()s into a non-git temp dir instead of changing the assertions. What would have made the tests non-deterministic if we had instead asserted against the branch process.cwd() resolves to?
A: I don't know. (Asserting against the resolved branch would tie the test to whatever branch the meshlock repo happens to be on when the suite runs — "main" on your machine, a feature branch or detached HEAD in CI. That value changes by environment, so the test would pass in one place and fail in another. chdir into a known non-git dir makes the result always null regardless of where the suite runs — a hermetic test.)

**Still fuzzy:**

The name of the layering rule — "dependency direction" / dependencies point inward toward core (Q4, partial)
Why asserting on the real resolved branch is non-deterministic — the value depends on the environment's current branch, so the test stops being hermetic (Q5)