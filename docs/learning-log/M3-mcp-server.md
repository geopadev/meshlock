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
> SUPERSEDED in S1c (see M3.3b "Note — reconciling with M3.2c"): this answer held while the
> daemon ran per-repo (cwd == the file's repo). Once `meshlock init` made the daemon
> user-global (one server, many repos), cwd became the DAEMON's repo, not the file's — so the
> correct base flipped back to dirname(path), which resolves the FILE's repo's branch.

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

---

## M3.3a — team_status tool (2026-06-23)

**Built:** The fourth and final tool of the M3 set, and the second read-only one. team_status
takes no input and surveys every active lock: it reads listLocks(db) (all non-expired rows,
ordered by path, branch included) and resolves the agent's own branch via getCurrentBranch(),
then formats a compact text block — a header count plus one line per lock (path, branch or "no
branch", holder, expiry). Locks whose branch matches the agent's current branch are marked
" ← your branch", with null == null so a branchless agent matches branchless locks. The empty
case returns "No active locks." The handler mutates nothing. server.ts registers it alongside
the other three. 4 handler tests (empty, multi-lock listing, own-branch marking incl. null,
expired excluded).

**Why this design:** team_status is the survey counterpart to check_lock's point query: one
asks "is THIS path locked?", the other asks "what is locked everywhere?". Being read-only it is
the safest tool — it can never corrupt state, only report it. The own-branch marker is what
makes a flat list actionable: it separates locks that directly contend with the agent's work
(same branch) from those that merely coexist on other branches. It becomes team-wide for free:
in team mode the relay writes the same locks table, so the same survey reflects the whole team
without the tool changing at all. config is taken for signature consistency but unused today
(marked with `void config`).

**Concepts:** point query vs full survey, read-only as the safest operation, no-argument tool
(empty Zod input shape), null == null branch comparison reused for own-branch marking, reusing
two existing core functions (listLocks + getCurrentBranch) through a thin adapter, the same
table powering solo and team mode, an intentionally-unused parameter (void config).

**Interview Qs:**
Q: check_lock and team_status are both read-only. What is the essential difference between what each answers, and why does team_status need no input while check_lock needs a path?
A: because check_lock needs to check a specific lock not all of them so we need to specify which one aka. the path. (Correct. check_lock is a point query — it needs the path to look up one lock; team_status is a full survey, so there is nothing to specify.)

Q: team_status is the safest of the four tools to expose. Why does "read-only" make it safe in a way acquire_lock and release_lock are not?
A: because for team status it is only a select query, the only thing that it can get wrong is current branch name because of the ttl time, if the other two bug out they can delete the wrong rows and broadcast the wrong paths as not locked or locked. (Correct and precise. A SELECT can only mislabel what it displays — at worst the cached branch is stale. The mutating tools write/delete rows, so a bug there can corrupt who-holds-what, not merely misdisplay it.)

Q: The own-branch marker uses lock.branch === currentBranch. Why does plain === give the correct answer for two branchless (null) locks, and how does that line up with the engine's branch rule?
A: because in typescript if you strictly check null === null it outputs true, just like we use IS for sql NULL = NULL for it to return true instead of unknown. (Correct. JS/TS null === null is true, so two branchless values match — the same "two nulls are the same branch" rule the engine enforces in SQL with IS, just given for free by the language here.)

Q: The plan says team_status "becomes team-wide without changing." What about the architecture makes that true — what does the relay do in team mode that the tool never has to know about?
A: because the things it calls live higher in the engine, they already exist it just needs to call them. (On the right track about reuse, but the team-wide point is about the data: team_status reads the locks table. In team mode the relay writes other sessions' locks into that same table, so the survey reflects the whole team without the tool changing — it never knows where the rows came from. Note: the engine/core is the LOWER layer the tool calls down into, not "higher".)

Q: The handler takes config but never reads it (we wrote `void config`). Why keep a parameter you don't use, and what does `void config` communicate to a future reader?
A: It tells the compiler that we meant to leave it empty so it doesn't throw any error or crash. (Right on intent. We keep the parameter for signature consistency with the other tool factories and likely team-mode use; void config marks it as deliberately unused so neither the linter nor a future reader mistakes it for a forgotten wire-up.)

**Still fuzzy:**

Layer direction — core/the engine is the LOWER/inner layer the tool calls down into, not "higher" (Q4)
Why team_status is team-wide for free — the relay writes other sessions' rows into the same locks table the tool already reads (Q4)

---

## M3.3b — meshlock init: CLI + user-global registration (+ S1c fix) (2026-06-25)

**Built:** Made `meshlock` a runnable command. A small CLI dispatcher (src/cli/index.ts, the
package's `bin` target with a `#!/usr/bin/env node` shebang) reads process.argv: `init` registers
the MCP server in Claude Code's user config; `serve` (and bare `meshlock`) boots the server via a
newly-exported `startServer()` reused from src/mcp/server.ts; an unknown command prints usage to
stderr and exits non-zero. The registration logic (src/cli/init.ts, `registerMeshlock(configPath,
entry)`) is READ-MERGE-WRITE: it preserves all existing config, adds/replaces only the `meshlock`
entry (idempotent), creates the file/parent dirs if missing, and REFUSES to overwrite a config it
can't parse. The S1c coherence fix landed too: acquire_lock now resolves branch from
getCurrentBranch(dirname(path)) — same base as repo_root — so a lock is coherent even for a file
outside the daemon's cwd. 4 init tests (fresh, merge, idempotent, unparseable). 61 tests green.

**Verified config format (not assumed):** Claude Code v2.1.185 stores stdio MCP servers as
`{ "type": "stdio", "command": "node", "args": [...], "env": {} }` keyed by name under `mcpServers`.
For USER scope that's the TOP-LEVEL mcpServers of ~/.claude.json (local scope nests under
projects[cwd]; project scope uses .mcp.json). Confirmed by a reversible `claude mcp add`/read/remove
probe. Launch command chosen: process.execPath (exact node) + absolute path to the built CLI entry,
so registration doesn't depend on PATH or on `meshlock` being globally linked.

**Why this design:** READ-MERGE-WRITE (not overwrite) because the config is shared — clobbering it
would delete the user's other MCP servers and unrelated settings. Refusing to write over an
unparseable file follows the same fail-loud-on-identity principle as S1b: better to stop than to
destroy a file we don't understand. Exporting startServer() (rather than duplicating the boot in the
CLI) keeps one boot path, so `serve` and direct execution can't drift. The bin field + shebang are
what turn a .js file into an invokable command.

**Concepts:** a CLI bin entry + shebang (how a script becomes a command), process.argv dispatch
without a framework, read-merge-write vs overwrite (preserving shared config), idempotency (replace,
don't duplicate), fail-loud on unparseable input, dependency-injected config path for tests,
reusing one exported boot function, stdout discipline (serve owns it, init may use it).

**Interview Qs:**
Q: `init` does read-merge-write instead of just writing the meshlock entry. What would break if it simply wrote `{ mcpServers: { meshlock: ... } }` to the file?
A: it would erase all current mcp servers and just write meshlock over them. (Correct. ~/.claude.json is shared — it holds the user's other MCP servers AND dozens of unrelated settings. Overwriting it would delete all of that; read-merge-write touches only the meshlock key.)

Q: What does the `bin` field in package.json do, and why does the CLI file need the `#!/usr/bin/env node` shebang as its first line?
A: it tells the os to run this files with node, without the shebang the os wouldn't know it is a node script. (Right on the shebang. The other half: the `bin` field maps the command name `meshlock` to the file (./dist/cli/index.js), so on install npm/pnpm creates a `meshlock` launcher on PATH that points at it. bin = "make this file the `meshlock` command"; shebang = "run that file with node".)

Q: Running `meshlock init` twice must not create two meshlock entries. What property is that called, and what in the code guarantees it?
A: it is going to be idempotent and the = entry guarantees it, it will tell us if it replaced or wrote. (Correct. The property is idempotency. Assigning to an object KEY (servers["meshlock"] = entry) replaces in place — it can't duplicate, unlike pushing to an array. The created/replaced flags just report which happened.)

Q: If the existing config file contains invalid JSON, init throws and does NOT write. Why is refusing better than starting fresh and overwriting it?
A: because it would destroy a file the user cares about. (Correct. The file may be valid and our parser hit an edge case, or the user is mid-edit — either way, silently overwriting destroys data we didn't understand. Fail loud, same principle as S1b dropping the DB default.)

Q: The S1c fix changed acquire_lock to resolve branch from getCurrentBranch(dirname(path)) instead of cwd. What concrete bug does resolving both repo_root and branch from the file's directory prevent?
A: switching repos but staying on the previous repos branch or vice versa because previously they didn't get the path from the same source of truth. (Correct. With repo_root from the file's dir but branch from cwd, a file outside the daemon's repo would be tagged with repo B's root and repo A's branch — an incoherent lock. Resolving both from dirname(path) means one git starting directory → one repo → coherent.)

**Note — reconciling with M3.2c (why branch went back to dirname(path)):**
M3.2c moved branch resolution from dirname(path) to cwd, and its log called dirname(path) "wrong".
S1c moves it back. This is NOT a flip-flop — the premise changed underneath it:
- getCurrentBranch(dirname(path)) still resolves a WHOLE-repo branch: git walks up from that
  directory to the nearest .git and reports that repo's single HEAD. It never treated branch as a
  per-file property — so M3.2c's actual concern is still honored. The only question was ever
  WHICH repo's branch.
- M3.2c chose cwd under an unstated assumption: the daemon ran per-repo, so cwd == the file's repo
  and the two bases were equivalent. M3.3b's `meshlock init` registers the server USER-GLOBALLY —
  one daemon, many repos — so cwd (the daemon's repo) and dirname(path) (the file's repo) can now
  DIFFER. cwd became the wrong base; dirname(path) is the file's own repo, which is what a lock
  about that file should record.
- Resolving repo_root AND branch from the same dirname(path) guarantees they describe the same
  repo (coherent by construction). That is the S1c-issue-#1 fix.
So: M3.2c was correct for a per-repo daemon; S1 made the daemon global, flipping the correct base
back to the file's directory. Same line of code, opposite justification.

**Still fuzzy:**

The bin field's role (maps the command name to the file) vs the shebang's role (run that file with node) — two separate mechanisms (Q2)
Why branch resolution flipped cwd → dirname(path) between M3.2c and S1c — the daemon going user-global changed which repo cwd points at (reconciliation note)

---

## M3.3c (automated half) — command:"node" + synthetic registration test (2026-06-25)

**Built:** Two small things closing M3.3b loose ends. (1) The registration entry's `command` changed
from process.execPath (the exact, version-pinned node binary) to the PATH-relative "node", so a Node
upgrade doesn't silently un-register meshlock. (2) A synthetic registration test in server.test.ts
that proves createServer registers ALL FOUR tools and they're discoverable — closing the gap, carried
since M3.2, where nothing tested createServer's registerTool wiring. The live exercise (real Claude
Code + agent + JSON-RPC) is the user's manual step. 62 tests green.

**SDK mechanism used:** InMemoryTransport.createLinkedPair() (from @modelcontextprotocol/sdk/inMemory.js)
plus a Client (from .../client/index.js). The pair links a client transport and a server transport
in memory; the McpServer connects to one end, the Client to the other, and client.listTools() issues a
REAL tools/list request over that in-memory channel. So the test exercises the actual protocol path —
registration → tools/list — with no child process and no stdio. I verified the API by inspecting the
installed SDK and smoke-testing the round-trip before writing the test. (No fallback/introspection
hack was needed.)

**Why this design:** "node" trades a silent failure (pinned path vanishes on upgrade → tools quietly
disappear) for a rare LOUD one (wrong node first on PATH → serve visibly fails) — loud-and-rare beats
silent. The synthetic test catches a class of bug no handler test can: a tool that exists and works in
isolation but was never wired into server.ts via registerTool (or was registered under the wrong name).
Handler tests call the handler factory directly, bypassing the server entirely, so they'd stay green
while the tool is invisible to agents. A child-process stdio server was avoided because it's slow,
flaky, and platform-dependent; the in-memory linked pair gives the same protocol round-trip in-process.

**Concepts:** PATH-relative vs pinned-binary command (silent vs loud failure modes), an in-memory
linked transport as a real-protocol test without a subprocess, what registration tests catch that
handler tests can't (the wiring, not the logic), set equality for order-independent assertions,
verifying a library's API by inspection + smoke test before depending on it.

**Interview Qs:**
Q: The registration command changed from process.execPath to "node". What failure mode does each have, and why is "node" the better default?
A: if the user changes node versions the mcp would get removed silently, with command node it gets the nodes path and if it is wrong it fails loudly. (Correct. process.execPath pins an exact (e.g. nvm) binary that vanishes on a Node upgrade → meshlock silently un-registers. "node" resolves via PATH and survives upgrades; if the wrong node is first on PATH it fails loudly — a rare, visible failure beats a silent one.)

Q: The new test connects a Client to the server over an in-memory linked transport and calls listTools(). What bug does this catch that the handler-level tests (which call the handler factory directly) cannot?
A: you get the genuine handshake without spawning anything. (That describes the transport, not the bug. The bug it catches: a tool that is implemented and works in isolation but was never wired into server.ts via registerTool — or was registered under the wrong name. Handler tests call the factory directly, bypassing the server, so the tool could be invisible to agents and they'd still pass. This test goes THROUGH createServer, so it's the only one that sees the registration wiring.)

Q: Why use an in-memory linked transport instead of spawning a real `meshlock serve` child process and talking to it over stdio?
A: because it is more real than calling internals directly, far cheaper and more reliable than a child process. (Correct. The linked pair gives the same protocol round-trip (initialize → tools/list) without process startup, stdio piping, platform quirks, or cleanup flakiness — fast and deterministic, while still exercising the real protocol path.)

Q: The assertion sorts the tool names and compares to a 4-element array. Why sort / compare the whole set instead of just asserting each expected name is present?
A: because a user can pass in a non existing tool and it would pass without error, whereas when we use toequal it is more strict. (Right direction. Full-set equality pins the EXACT surface: it catches both a missing tool AND an unexpected/duplicate/extra one. "Contains each of the four" would still pass if a broken fifth tool were also registered. Sorting just makes it order-independent.)

Q: Before writing the test, the SDK's API was checked by inspecting node_modules and running a smoke test. Why verify a dependency's API that way rather than assuming the method names?
A: because dependancies drift with version changes. (Correct. Library APIs change across versions, and a wrong guess fails as a confusing error rather than a clear "no such method". Confirming against the actually-installed version turns assumptions into facts — same reason M3.3b verified Claude Code's real config schema.)

**Still fuzzy:**

What the registration test actually catches — a tool implemented but never wired into server.ts via registerTool (or mis-named); handler tests bypass the server so they can't see it (Q2)