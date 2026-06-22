# MeshLock

Coordinate AI coding agents across a team so they don't overwrite each
other's work. A lock prevents two agents editing the same file at once;
a change briefing tells the next agent what the last one changed, so
semantic conflicts never get created.

**Status:** in active development. Not yet ready for use.

## The problem

AI coding agents running on the same codebase have no awareness of each
other. Two agents editing the same file produce conflicts; worse, one
agent can rename a symbol, release its work, and a second agent then
writes code against the old name — a semantic conflict that git merges
cleanly at the text level but that breaks the application at runtime.
Git detects textual conflicts at merge time; MeshLock prevents semantic
conflicts at edit time.

## License

MIT for the client; AGPL-3.0 for the self-hostable relay. See LICENSE for details.
