# Learning log

One row per step, written after committing.
| Step | Date | What I learned | What confused me |
|---|---|---|---|
| 0.1 | 2026-09-29 | Why config files and the lockfile must be committed: `engines` in package.json blocks the wrong Node version, and pnpm-lock.yaml pins the exact package versions. Without them, someone else can end up with different versions and functions that don't exist. | How the syntax of each file should look; the old `engineStrict` field versus how pnpm handles it now; what `module` and `moduleResolution` actually do. |

