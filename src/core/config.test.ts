import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";

// Redirect homedir so config.ts writes to a temp dir instead of ~/.meshlock
let tempHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => tempHome,
  };
});

// Import after the mock is in place
const { loadConfig, saveConfig, getConfigPath, getDatabasePath, defaultConfig, ConfigSchema } =
  await import("./config.js");

describe("config", () => {
  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "meshlock-test-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it("returns default config when no file exists", async () => {
    const config = await loadConfig();
    expect(config.mode).toBe("solo");
    expect(config.lock_timeout).toBe(1800);
    expect(config.lock_mode).toBe("exclusive");
    expect(config.granularity).toBe("file");
    expect(config.cross_branch_mode).toBe("warn");
    expect(config.relay_url).toBeNull();
    expect(config.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("loads a valid config from disk", async () => {
    const valid = {
      mode: "team",
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      relay_url: "https://relay.example.com",
      lock_timeout: 3600,
      lock_mode: "advisory",
      granularity: "directory",
      cross_branch_mode: "block",
    };
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(valid), "utf-8");

    const config = await loadConfig();
    expect(config.mode).toBe("team");
    expect(config.relay_url).toBe("https://relay.example.com");
    expect(config.lock_timeout).toBe(3600);
    expect(config.lock_mode).toBe("advisory");
    expect(config.granularity).toBe("directory");
    expect(config.cross_branch_mode).toBe("block");
  });

  it("throws on invalid mode value", async () => {
    const bad = {
      mode: "multi",
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      relay_url: null,
      lock_timeout: 1800,
      lock_mode: "exclusive",
      granularity: "file",
    };
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(bad), "utf-8");

    await expect(loadConfig()).rejects.toThrow("Invalid config");
  });

  it("throws when lock_timeout is below minimum", async () => {
    const bad = {
      mode: "solo",
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      relay_url: null,
      lock_timeout: 30,
      lock_mode: "exclusive",
      granularity: "file",
    };
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(bad), "utf-8");

    await expect(loadConfig()).rejects.toThrow("Invalid config");
  });

  it("throws when lock_timeout exceeds maximum", async () => {
    const bad = {
      mode: "solo",
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      relay_url: null,
      lock_timeout: 9999,
      lock_mode: "exclusive",
      granularity: "file",
    };
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(bad), "utf-8");

    await expect(loadConfig()).rejects.toThrow("Invalid config");
  });

  it("throws on invalid uuid for session_id", async () => {
    const bad = {
      mode: "solo",
      session_id: "not-a-uuid",
      relay_url: null,
      lock_timeout: 1800,
      lock_mode: "exclusive",
      granularity: "file",
    };
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(bad), "utf-8");

    await expect(loadConfig()).rejects.toThrow("Invalid config");
  });

  it("save then load returns identical data", async () => {
    const original = {
      mode: "team" as const,
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      relay_url: "https://relay.example.com",
      lock_timeout: 600,
      lock_mode: "advisory" as const,
      granularity: "directory" as const,
      cross_branch_mode: "ignore" as const,
    };

    await saveConfig(original);
    const loaded = await loadConfig();
    expect(loaded).toEqual(original);
  });

  it("saveConfig creates the directory if it does not exist", async () => {
    const config = defaultConfig();
    await saveConfig(config);
    const loaded = await loadConfig();
    expect(loaded.mode).toBe("solo");
  });

  it("saveConfig throws when given invalid config", async () => {
    const bad = {
      mode: "solo" as const,
      session_id: "bad-uuid",
      relay_url: null,
      lock_timeout: 1800,
      lock_mode: "exclusive" as const,
      granularity: "file" as const,
      cross_branch_mode: "warn" as const,
    };
    await expect(saveConfig(bad)).rejects.toThrow("Cannot save invalid config");
  });

  it("throws on invalid cross_branch_mode value", async () => {
    const bad = {
      mode: "solo",
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      relay_url: null,
      lock_timeout: 1800,
      lock_mode: "exclusive",
      granularity: "file",
      cross_branch_mode: "merge",
    };
    const dir = join(tempHome, ".meshlock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(bad), "utf-8");

    await expect(loadConfig()).rejects.toThrow("Invalid config");
  });

  it("getConfigPath includes .meshlock/config.json", () => {
    const path = getConfigPath();
    expect(path).toContain(".meshlock");
    expect(path).toContain("config.json");
  });

  it("defaultConfig generates a fresh uuid each call", () => {
    const a = defaultConfig();
    const b = defaultConfig();
    expect(a.session_id).not.toBe(b.session_id);
  });

  it("getDatabasePath ends with meshlock.db in the same dir as getConfigPath", () => {
    expect(getDatabasePath()).toMatch(/meshlock\.db$/);
    expect(dirname(getDatabasePath())).toBe(dirname(getConfigPath()));
  });
});
