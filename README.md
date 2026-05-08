# surrealdb-v3-stack

**Private** — Base-platform-specific SurrealDB v3 patterns: Schema Builder, pre-commit gates, jsonify/extractId, Mastra SCHEMALESS, EventBus + SurrealLiveAdapter, and production-incident playbook.

## Why this plugin

SurrealDB has two sides most users touch:

1. **SurrealQL** — the query language, schema, permissions, access, live queries.
2. **SDK v2** — the `surrealdb` npm package used from Node, browsers, React Native.

These are different concerns. This plugin ships a skill for each, plus two slash commands tuned to the Base codebase.

> **Versions.** This plugin targets **SurrealDB server v3** and **JavaScript SDK v2**. If you're on server v1/v2 or the legacy `surrealdb.js` package, some recipes here won't apply — check the version note in each skill.

> **No MCP.** Earlier versions shipped a `surreal-cli` MCP server. It was dropped in `v0.3.0` because the maintainer's workflow uses `surreal sql` directly via terminal. Skills + commands are the only surface now.

## What's inside

| Component | Name | When it triggers |
| --- | --- | --- |
| Skill | `surrealql` | Writing/reviewing `.surql`, schema, `DEFINE ...`, permissions, live queries, graph edges |
| Skill | `surrealdb-js` | Code using the `surrealdb` package — `new Surreal()`, `db.query`, `RecordId`, auth flows |
| Command | `/surrealql-review` | Review a SurrealQL file or snippet for v3 compatibility, common gotchas, and Base-specific gate violations |
| Command | `/surreal-scaffold` | Generate a starter `schema.surql` + SDK client. Two profiles: `generic` and `base` |

## Installation

### From marketplace (recommended)

```bash
claude plugin marketplace add codecubit/surrealdb-v3-stack
claude plugin install surrealdb-v3-stack@surrealdb-v3-stack
```

### From source

Clone the repo and install the plugin directory. Make sure the `surreal` CLI is on your `PATH`:

```bash
curl -sSf https://install.surrealdb.com | sh
surreal --version
```

## Quick start

```bash
# 1. Start a local SurrealDB server (or point at the Base CT)
surreal start --user root --pass root --log info memory

# 2. Export env vars (Base style)
export SURREALDB_URL=http://127.0.0.1:8000
export SURREALDB_USER=root
export SURREALDB_PASS=root
export SURREALDB_NAMESPACE=base
export SURREALDB_DATABASE=base

# 3. In Claude Code, ask for a starter:
#    /surreal-scaffold base
```

## Skill reference map

Both skills use progressive disclosure. The `SKILL.md` is short; dense material sits in `references/`.

- `skills/surrealql/`
  - `references/dml.md` — CREATE/SELECT/UPDATE/UPSERT/DELETE/INSERT/RELATE, graph traversal, types, operators.
  - `references/schema.md` — DEFINE TABLE/FIELD/INDEX/EVENT/FUNCTION/PARAM/SEQUENCE/CONFIG/USER/ANALYZER.
  - `references/permissions.md` — `$auth`-based row-level permissions, patterns, caveats.
  - `references/advanced.md` — live queries, transactions, full-text/vector search, GraphQL.
  - `references/auth.md` — `DEFINE ACCESS` types (RECORD / JWT / BEARER), v1→v3 migration.
  - `references/modeling.md` — decision tree: record links vs graph edges vs embedding, anti-patterns, denormalization.
  - `references/migrations.md` — safe schema evolution: add/remove/rename fields, backfill pattern, versioning traps.
  - `references/cookbook.md` — 10 real-world recipes: pagination, full-text search, graph recommendations, transactions, soft delete.
  - `references/gotchas.md` — 28 gotchas (18 common + 10 from production incidents).
  - `references/schema-builder.md` — **[Base]** 3-layer pipeline (CORE_SCHEMA / sub-fields / MIGRATIONS), auto-healing, gates, **incidents this pipeline prevents**.
  - `references/serialization.md` — **[Base]** `jsonify` / `extractId` / `Jsonify<T>` from `@/lib/surreal`, Server→Client data flow.
  - `references/mastra.md` — **[Base]** the 6 SCHEMALESS Mastra tables, NULL vs NONE.
  - `references/eventbus.md` — **[Base]** EventBus + SurrealLiveAdapter, platform vs module channels (post-Phase-8), worker dynamic discovery.
  - `references/base-gates.md` — **[Base]** the 4 pre-commit gates (`check:catalog`, `check:manifests`, `check:schema-backfill`, `check:schema-module-purity`).
- `skills/surrealdb-js/`
  - `references/api.md` — every method on `Surreal`, every helper class.
  - `references/patterns.md` — connection lifecycle, auth flows, live-query reconnect, testing, **Base's cached-singleton pattern**.
  - `references/gotchas.md` — SDK-specific traps, including SDK v1→v2 silent breakages.

## License

UNLICENSED — private, not for distribution.
