import { describe, it, expect } from "vitest";
import { ConfigSchema } from "./schema.js";
import { notDeepStrictEqual } from "assert";

const validConfig = {
  mode: "solo",
  session_id: "81d41428-d8a1-499e-8d13-65805e048772",
  relay_url: null,
  lock_timeout: 1800,
  lock_mode: "exclusive",
  granularity: "file",
};

describe("ConfigSchema", () => {
  it("accepts valid config", () => {
    const result = ConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it("rejects an empty object", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a wrong-typed lock_timeout", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      lock_timeout: "ten",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["lock_timeout"]);
  });

  it("rejects an unknown key", () => {
    const result = ConfigSchema.safeParse({ ...validConfig, colour: "blue" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("colour");
  });

  it("fills in the default timeout", () => {
    const { lock_timeout, ...withoutTimeout } = validConfig;
    const result = ConfigSchema.safeParse(withoutTimeout);
    expect(result.success).toBe(true);
    expect(result.data?.lock_timeout).toBe(1800);
  });

  it("rejects zero timeouts", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      lock_timeout: 0,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["lock_timeout"]);
  });

  it("rejects negative timeouts", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      lock_timeout: -5,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["lock_timeout"]);
  });

  it("rejects a fractional timeout", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      lock_timeout: 2.5,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["lock_timeout"]);
  });

  it("rejects team mode", () => {
    const result = ConfigSchema.safeParse({ ...validConfig, mode: "team" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["mode"]);
  });

  it("rejects advisory lock_mode", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      lock_mode: "advisory",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["lock_mode"]);
  });

  it("rejects directory granularity", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      granularity: "directory",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["granularity"]);
  });

  it("rejects a relay URL for now", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      relay_url: "https://relay.example.com",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["relay_url"]);
  });

  it("rejects a non-UUID session id", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      session_id: "abc",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["session_id"]);
    expect(result.error?.issues[0]?.code).toBe("invalid_format");
  });
});
