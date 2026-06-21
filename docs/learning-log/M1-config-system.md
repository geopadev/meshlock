## M1 — project setup and config system (2026-06-21)

**Built:** TypeScript project skeleton (ESM, strict, vitest) and a zod-validated
config system that reads/writes ~/.meshlock/config.json with defaults, validation,
and directory creation.

**Why this design:** config is the first thing every other module imports.
Zod validates at runtime and infers the TS type from the same schema —
one source of truth instead of writing types and validation separately.

**Concepts:** ESM vs CommonJS, TypeScript types vs runtime validation,
zod schema chains, vitest (describe/it/expect)

**Interview Qs:**
Q: What's the difference between TypeScript types and runtime validation?
A: typescript types are erased after compile time so at runtime the program has no idea what an object's type is supposed to be, everything is just plain javascript values. When you read config.json from disc, JSON.parse() gives you any, there is no check that what is in that file actually matches that config interface. Runtime validation zod, is the thing that actually inspects the real data and confirms it matches the shape you expect while the program is running.

Q: What does "type": "module" actually change?
A: it uses modern es6 import/export instead of require

Q: Why zod over manual validation?
A: You define the zod schema once, and typescript's type is inferred from that schema. So there's only one place where the shape of the config is defined -- the schema. If you'd done it manually, you'd have to write the validation logic AND  a separate typescript interface, and keep both in sync by hand every time the shape changes. Zod removes that duplication, not by "auto-udpating" but  by making the schema a single source that the type is generated from.

Q: What does vitest's describe/it/expect pattern actually do?
A: (describe) is just a label that groups related tests together(purely organizational, bo behavior). (it) defines one individual test case with a plain-english name describing what it checks. expect(x).toBe(y) is the actual assertion, it's the line that says "if this isn't true, fail this test and tell me. "None of these are a "contract", they're just functions vitest gives you to structure and run checks.

**Still fuzzy:**

How z.infer<typeof ConfigSchema> connects the zod schema to the TypeScript type (Q3)
What describe/it/expect actually are mechanically, not what they "represent" (Q4)
