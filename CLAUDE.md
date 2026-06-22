# MeshLock — Agent Rules

## Project
TypeScript single-package tool. Node 22. Focus: concurrent agent coordination.
One concern per prompt. If in doubt, smaller is correct.

## Hard rules
- ONE concern per prompt. >6 files or mixed concerns → STOP and say so.
- NEVER run git add, commit, or push. Human commits.
- NO drive-by refactors. Note problems, don't fix them.
- NEVER create GitHub issues, PRs, or releases. Surface problems in your
  output as "ISSUE:" lines; the human triages them.
- NO new dependencies without flagging: what, why, alternatives.
- Strict TypeScript. No `any`. No `@ts-ignore`.
- Every new module gets a vitest test. Run `pnpm test` before done.
- After every build task, before the human commits, explain every file
  changed as if teaching a JavaScript developer who is new to TypeScript.
  Compare to JS equivalents where helpful. Include 5 quiz questions at
  the end. Do NOT write code during the explanation.

## Required output after every task
1. Files changed and what changed
2. Plain-English walkthrough: what and WHY
3. One thing that could break and how we'd notice
4. Problems noticed but NOT fixed (outside scope): list each as a
   one-line "ISSUE: <description>" so the human can decide whether to
   open a GitHub issue. Do NOT create issues yourself.

## Commit messages
feat(lock-engine): add advisory lock mode
fix(watcher): debounce rapid successive writes
chore(hooks): install pre-commit hook on init
Scopes: lock-engine | mcp | cli | relay | daemon | vscode | hooks | docs
