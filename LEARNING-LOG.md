# Learning log

One row per step, written after committing.
| Step | Date | What I learned | What confused me |
|---|---|---|---|
| 0.1 | 2026-09-29 | Why config files and the lockfile must be committed: `engines` in package.json blocks the wrong Node version, and pnpm-lock.yaml pins the exact package versions. Without them, someone else can end up with different versions and functions that don't exist. | How the syntax of each file should look; the old `engineStrict` field versus how pnpm handles it now; what `module` and `moduleResolution` actually do. |

| 0.2 | 2026-10-01 | I learnt how to write test files with describe it and expect. vitest only checks behaiviour and never checks types, so `tsc` does that via `pnpm typecheck`.  config: tsconfig.json type-checks everything including tests, and tsconfig.build.json (used by `pnpm build`) excludes tests so they don't end up in dist. | nothing confused me too much |

| 1.1 | 2026-10-07 | 
- TypeScript checks at compile time; zod validates data at run time, which matters because users edit the config by hand (taem is rejected immediately)
- z.infer gives one source of truth, so a hand-written interface can't drift from the schema
- zod strips unknown keys by default, so a typo like lock_timout silently falls back to 1800; strictObject rejects it instead | 
- finding values inside the result object (data vs error, issues[0], path, code)
- path holds the field name, not the value
- picking the matcher (toBe / toEqual / toContain)
- first-time zod syntax
- how zod differs from module / moduleResolution: imports finding files vs data being checked |


