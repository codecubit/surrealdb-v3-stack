# surrealdb-v3-stack

**Private** — extends the [public plugin](https://github.com/codecubit/surrealdb-claude-plugin) with Base platform-specific patterns: Schema Builder, jsonify/extractId, Mastra SCHEMALESS, EventBus/SurrealLiveAdapter, and correlated subquery optimization.

## Why this plugin

SurrealDB has two sides most users touch:

1. **SurrealQL** — the query language, schema, permissions, access, live queries.
2. **SDK v2** — the `surrealdb` npm package used from Node, browsers, React Native.

These are different concerns. This plugin ships a skill for each, plus two slash commands and an MCP server wrapping the `surreal` CLI.

> **Versions.** This plugin targets **SurrealDB server v3** and **JavaScript SDK v2**. If you're on server v1/v2 or the legacy `surrealdb.js` package, some recipes here won't apply — check the version note in each skill.

## What's inside

| Component | Name | When it triggers |
| --- | --- | --- |
| Skill | `surrealql` | Writing/reviewing `.surql`, schema, `DEFINE ...`, permissions, live queries, graph edges |
| Skill | `surrealdb-js` | Code using the `surrealdb` package — `new Surreal()`, `db.query`, `RecordId`, auth flows |
| Command | `/surrealql-review` | Review a SurrealQL file or snippet for v3 compatibility and common gotchas |
| Command | `/surreal-scaffold` | Generate a starter `schema.surql` + SDK client for a new project |
| MCP | `surreal-cli` | Exposes `surreal_version`, `surreal_is_ready`, `surreal_sql`, `surreal_import`, `surreal_export` |

## Installation

### From marketplace (recommended)

```bash
claude plugin marketplace add codecubit/surrealdb-claude-plugin
claude plugin install surrealdb-v3@surrealdb-claude-plugin
```

### From source

1. Clone the repo and install the plugin directory.
2. For the MCP server, install dependencies once:

   ```bash
   cd mcp-server && npm install
   ```

3. Make sure the `surreal` CLI is on your `PATH`:

   ```bash
   curl -sSf https://install.surrealdb.com | sh
   surreal --version
   ```

## MCP configuration

The MCP server reads connection details from env vars. Set them in your shell or Claude Code config:

| Var | Purpose | Default |
| --- | --- | --- |
| `SURREAL_BIN` | Path/name of the `surreal` binary | `surreal` |
| `SURREAL_URL` | Server URL (e.g. `http://127.0.0.1:8000`) | _(required)_ |
| `SURREAL_NS` | Default namespace | _(empty)_ |
| `SURREAL_DB` | Default database | _(empty)_ |
| `SURREAL_USER` | Operator username | _(empty)_ |
| `SURREAL_PASS` | Operator password | _(empty)_ |

You can still override any of these per tool call — tool arguments take precedence over env.

### MCP tools

- **`surreal_version`** — print the CLI version (and server version if `url` is set).
- **`surreal_is_ready`** — `GET /health` probe.
- **`surreal_sql`** — run ad-hoc SurrealQL via `surreal sql`. Supports multi-statement input.
- **`surreal_import`** — apply a `.surql` file (or inline `content`) via `surreal import`.
- **`surreal_export`** — dump a namespace/database to a `.surql` file (returned inline if no `path`).
- **`surreal_info`** — run `INFO FOR DB`, `INFO FOR TABLE <name>`, or `INFO FOR NS` to inspect schema.

## Quick start

```bash
# 1. Start a local SurrealDB server
surreal start --user root --pass root --log info memory

# 2. Export env vars
export SURREAL_URL=http://127.0.0.1:8000
export SURREAL_USER=root
export SURREAL_PASS=root
export SURREAL_NS=app
export SURREAL_DB=main

# 3. In Claude Code, ask for a starter:
#    /surreal-scaffold
```

Then apply the generated schema with the `surreal_import` MCP tool, or directly:

```bash
surreal import --conn $SURREAL_URL --user $SURREAL_USER --pass $SURREAL_PASS --ns app --db main schema.surql
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
  - `references/schema-builder.md` — **[Stack]** 3-layer pipeline (CORE_SCHEMA / sub-fields / MIGRATIONS), auto-healing, gates.
  - `references/serialization.md` — **[Stack]** jsonify() / extractId() / Jsonify<T>, Server→Client data flow.
  - `references/mastra.md` — **[Stack]** SCHEMALESS exception for mastra_* tables, NULL vs NONE.
  - `references/eventbus.md` — **[Stack]** EventBus + SurrealLiveAdapter, channels, worker, correlated subquery optimization.
- `skills/surrealdb-js/`
  - `references/api.md` — every method on `Surreal`, every helper class.
  - `references/patterns.md` — connection lifecycle, auth flows, live-query reconnect, testing.
  - `references/gotchas.md` — SDK-specific traps.

## License

UNLICENSED — private, not for distribution.
