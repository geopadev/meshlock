import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ConfigSchema = z.object({
  mode: z.enum(["solo", "team"]),
  session_id: z.string().uuid(),
  relay_url: z.string().url().nullable(),
  lock_timeout: z.number().int().min(60).max(7200),
  lock_mode: z.enum(["exclusive", "advisory"]),
  granularity: z.enum(["file", "directory"]),
  cross_branch_mode: z.enum(["warn", "block", "ignore"]),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The single source of truth for the default cross-branch behaviour. Both the
 * config default below and the lock engine's fallback import this, so the two
 * can never drift apart (they did in M2.5, before this constant existed).
 */
export const DEFAULT_CROSS_BRANCH_MODE = "warn" as const;

export function getConfigPath(): string {
  return join(homedir(), ".meshlock", "config.json");
}

export function getDatabasePath(): string {
  return join(homedir(), ".meshlock", "meshlock.db");
}

export function defaultConfig(): Config {
  return {
    mode: "solo",
    session_id: randomUUID(),
    relay_url: null,
    lock_timeout: 1800,
    lock_mode: "exclusive",
    granularity: "file",
    cross_branch_mode: DEFAULT_CROSS_BRANCH_MODE,
  };
}

export async function loadConfig(): Promise<Config> {
  const path = getConfigPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    const fresh = defaultConfig();
    // ABSENT file = fresh install: persist the default (with its freshly
    // generated session_id) so identity is stable from first contact — a
    // per-run random session_id would make the pre-commit hook see this
    // machine's own MCP-taken locks as foreign and block its commits.
    //
    // CRITICAL: only ENOENT creates. An EXISTING file that merely failed to
    // READ (permissions, I/O) is user data — never write over it (the M3.3b
    // refuse-to-clobber rule; corrupt-but-readable files throw below for the
    // same reason). Non-ENOENT read failures keep the old behaviour: an
    // in-memory default, persisted nowhere.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Best-effort: a failed write (read-only home, quota) must not turn the
      // previously-working absent-file case into a startup crash. Identity is
      // per-run in that pathological case — no worse than pre-M6.2 behaviour.
      try {
        await saveConfig(fresh);
      } catch {
        /* keep the in-memory default */
      }
    }
    return fresh;
  }

  const parsed = ConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `Invalid config at ${path}:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`
    );
  }
  return parsed.data;
}

export async function saveConfig(config: Config): Promise<void> {
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(
      `Cannot save invalid config:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`
    );
  }

  const path = getConfigPath();
  await mkdir(join(homedir(), ".meshlock"), { recursive: true });
  await writeFile(path, JSON.stringify(parsed.data, null, 2), "utf-8");
}
