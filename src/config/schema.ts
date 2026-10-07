import { z } from "zod";

export const ConfigSchema = z.strictObject({
  mode: z.enum(["solo"]).default("solo"), // "team" added later on D.3
  session_id: z.uuid(),
  relay_url: z.null().default(null), // a relay URL: see guide D.3
  lock_timeout: z.number().int().positive().default(1800),
  lock_mode: z.enum(["exclusive"]).default("exclusive"), // advisory added later on D.1
  granularity: z.enum(["file"]).default("file"), // directory added later on D.2
});

export type Config = z.infer<typeof ConfigSchema>;
