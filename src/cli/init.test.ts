import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMeshlock, type StdioServerEntry } from "./init.js";

let tempDir: string;
let configPath: string;

const ENTRY: StdioServerEntry = {
  type: "stdio",
  command: "/usr/bin/node",
  args: ["/abs/dist/cli/index.js", "serve"],
  env: {},
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "meshlock-init-test-"));
  configPath = join(tempDir, "claude.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function readConfig(path = configPath): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
}

describe("registerMeshlock", () => {
  it("creates a fresh config with the meshlock entry, making parent dirs", async () => {
    const nested = join(tempDir, "a", "b", "claude.json");
    const result = await registerMeshlock(nested, ENTRY);

    expect(result.created).toBe(true);
    expect(result.replaced).toBe(false);
    const cfg = await readConfig(nested);
    expect((cfg.mcpServers as Record<string, unknown>).meshlock).toEqual(ENTRY);
  });

  it("merges without disturbing other servers or top-level keys", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        someTopKey: 42,
        mcpServers: {
          other: { type: "stdio", command: "other", args: [], env: {} },
        },
      }),
      "utf-8"
    );

    const result = await registerMeshlock(configPath, ENTRY);

    expect(result.created).toBe(false);
    expect(result.replaced).toBe(false);
    const cfg = await readConfig();
    const servers = cfg.mcpServers as Record<string, unknown>;
    // Both the pre-existing server and meshlock are present.
    expect(Object.keys(servers).sort()).toEqual(["meshlock", "other"]);
    expect(servers.meshlock).toEqual(ENTRY);
    // Unrelated top-level content is preserved.
    expect(cfg.someTopKey).toBe(42);
  });

  it("is idempotent: a second run replaces, never duplicates", async () => {
    await registerMeshlock(configPath, ENTRY);
    const second = await registerMeshlock(configPath, ENTRY);

    expect(second.replaced).toBe(true);
    const cfg = await readConfig();
    const servers = cfg.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["meshlock"]);
    expect(servers.meshlock).toEqual(ENTRY);
  });

  it("refuses to overwrite an unparseable existing config", async () => {
    const garbage = "{ this is not valid json ";
    await writeFile(configPath, garbage, "utf-8");

    await expect(registerMeshlock(configPath, ENTRY)).rejects.toThrow(
      "not valid JSON"
    );
    // The file is left exactly as it was — we never clobber what we can't parse.
    expect(await readFile(configPath, "utf-8")).toBe(garbage);
  });
});
