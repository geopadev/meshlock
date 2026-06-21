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
});

export type Config = z.infer<typeof ConfigSchema>;

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
  };
}

export async function loadConfig(): Promise<Config> {
  const path = getConfigPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return defaultConfig();
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
