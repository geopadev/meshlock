# ADR-001: SQLite first, Postgres later

## Decision
Use better-sqlite3 for lock state in solo mode; design the schema so
the same engine swaps to Postgres for team mode.

## Alternatives considered
- Postgres from day one: rejected — requires running a database server
  for solo developers, killing the zero-setup install.
- In-memory Map: rejected — locks vanish on daemon restart, no recovery.

## Why this
SQLite is zero-setup, synchronous (correct for a single-process daemon),
and the schema generalizes to Postgres later. Solo cost is zero; team
path stays open.
