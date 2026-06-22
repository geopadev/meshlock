# ADR-002: WAL journal mode

**Status:** accepted
**Date:** M2.1

## Decision

The SQLite database opens in WAL (write-ahead logging) journal mode, set via
`PRAGMA journal_mode = WAL` immediately after every `openDatabase` call.

## Alternatives considered

- Default rollback-journal mode: SQLite's out-of-the-box setting. Simpler, no
  extra files, but serialises readers and writers — a reader blocks the writer
  and vice versa.

## Why this choice

MeshLock's access pattern is many concurrent lock-checks (reads) while occasional
lock-acquires (writes) land. WAL lets readers proceed without blocking the writer
and vice versa; rollback-journal serialises them. The WAL trade-offs (extra -wal
and -shm files, no networked-filesystem support) don't apply to a local
solo/small-team path where the DB lives on a local disk.
