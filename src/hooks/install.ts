import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The ownership marker. Its presence in an existing pre-commit hook is the ONLY
 * thing that authorizes overwriting it (idempotent upgrade); its absence means
 * the hook is someone else's enforcement and we refuse to clobber it — the same
 * refuse-to-clobber discipline as M3.3b's unparseable-config rule. Versioned so
 * a future incompatible shim can detect and migrate old installs.
 */
export const HOOK_MARKER = "# meshlock-hook v1";

/**
 * The shim itself. `meshlock` is PATH-relative, NOT an absolute node/dist path —
 * the M3.3b lesson: a pinned path like ~/.nvm/versions/v22.x/... dies on the
 * next nvm upgrade and silently UN-ENFORCES every commit. PATH survives
 * upgrades, and its failure mode (meshlock not on PATH) is rare and loud:
 * git prints "meshlock: command not found" on every commit until fixed.
 */
const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER} — managed by meshlock; reinstall with \`meshlock install-hook\`.
exec meshlock hook pre-commit "$@"
`;

/** Discriminated on `installed`, like the engine's result unions. */
export type InstallHookResult =
  | { installed: true; hookPath: string; replaced: boolean }
  | { installed: false; hookPath: string | null; reason: string };

/**
 * `target` may be a repo ROOT (containing `.git/`) or a git dir itself
 * (`…/.git`, or a bare repo — anything holding HEAD). Returns null when it is
 * neither. A `.git` FILE (worktree/submodule pointer) is not followed in v1.
 */
function resolveGitDir(target: string): string | null {
  const dotGit = join(target, ".git");
  if (existsSync(dotGit) && statSync(dotGit).isDirectory()) {
    return dotGit;
  }
  if (existsSync(join(target, "HEAD"))) {
    return target;
  }
  return null;
}

/**
 * Install (or idempotently upgrade) the meshlock pre-commit shim into the
 * repo's `.git/hooks/pre-commit`, mode 0755.
 *
 * Never throws for the expected refusals (not a repo, foreign hook) — those
 * come back as `{ installed: false, reason }` for the CLI to print. chmod runs
 * unconditionally after the write because writeFileSync's `mode` only applies
 * when CREATING a file; an upgrade overwrite would otherwise keep whatever
 * mode the old file had.
 */
export function installHook(target: string): InstallHookResult {
  const gitDir = resolveGitDir(target);
  if (gitDir === null) {
    return {
      installed: false,
      hookPath: null,
      reason: `${target} is not a git repository (no .git directory found)`,
    };
  }

  const hooksDir = join(gitDir, "hooks");
  const hookPath = join(hooksDir, "pre-commit");

  let existing: string | null = null;
  try {
    existing = readFileSync(hookPath, "utf-8");
  } catch {
    // No existing hook — the clean-install path.
  }

  if (existing !== null && !existing.includes(HOOK_MARKER)) {
    return {
      installed: false,
      hookPath,
      reason:
        `refusing to overwrite the existing pre-commit hook at ${hookPath}: ` +
        `it has no "${HOOK_MARKER}" marker, so it is someone else's enforcement. ` +
        "Move or chain it manually, then re-run `meshlock install-hook`.",
    };
  }

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, HOOK_SCRIPT);
  chmodSync(hookPath, 0o755);
  return { installed: true, hookPath, replaced: existing !== null };
}
