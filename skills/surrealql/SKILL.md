---
name: surrealql
description: Write correct SurrealQL for SurrealDB v3 — queries, schema design, graph edges, permissions, live queries, transactions, full-text and vector search. Use this skill whenever the user is working in a `.surql` file, asks for any SurrealQL statement (SELECT, CREATE, UPDATE, UPSERT, DELETE, INSERT, RELATE, LIVE SELECT, DEFINE, REMOVE, REBUILD, BEGIN/COMMIT), designs a database schema with DEFINE TABLE/FIELD/INDEX/EVENT/FUNCTION/ACCESS/ANALYZER/SEQUENCE, writes row-level permissions using `$auth`, traverses graph relationships with arrow syntax, or debugs query errors. Trigger even when the user does not explicitly name the skill.
---

# SurrealQL for SurrealDB v3

SurrealQL is SurrealDB's query language — SQL-flavored but not SQL. This skill is the server-side language only; for the JavaScript client use the `surrealdb-js` skill.

Target: **SurrealDB server v3.x**. Do not silently assume v1/v2 syntax. If the user's environment is v2 or earlier, flag it before writing (notably: v2 uses `DEFINE SCOPE`, v3 uses `DEFINE ACCESS`).

## Core mental model — six things that are not like SQL

Internalize these before writing anything.

1. **Every record has a strongly-typed ID.** Format: `table:identifier`. The identifier can be a bare word (`person:tobie`), a number (`log:1`), a UUID (`u:u'018a...'`), an array (`log:[2024,1,1]`), an object (`p:{x:1,y:2}`), or an arbitrary string (`u:⟨user@x.com⟩`). IDs are first-class values of type `record`, not strings with a colon.

2. **`=` is assignment; `==` is value equality.** `WHERE name = "x"` works in many contexts but is an *assignment expression that evaluates truthy when the assignment holds*. Default to `==` in `WHERE` to be unambiguous. In `SET name = "x"` (UPDATE), `=` is correct — that's assignment.

3. **Relationships are edges, not joins.** Use `RELATE from -> edge -> to` to create a directed edge record, then traverse with `->edge->target`. JOINs (via `FETCH`) are only for *record links* (fields typed `record<t>`), not edges.

4. **`ONLY` unwraps arrays.** `SELECT * FROM person:tobie` returns a one-element array `[{...}]`. `SELECT * FROM ONLY person:tobie` returns the object `{...}`. Same for `CREATE/UPDATE/UPSERT/DELETE/RELATE`.

5. **Strong typing is opt-in.** Tables default to `SCHEMALESS`. Use `SCHEMAFULL` + `DEFINE FIELD ... TYPE ...` for real type checking. Permissions attach to tables and fields and are enforced per row in the query engine.

6. **Access control is first-class.** v3's `DEFINE ACCESS` replaces v1's `DEFINE SCOPE`. It handles record-based signup/signin, external JWT verification, and bearer tokens, all issuing server-signed JWTs. Don't roll your own auth on top.

## When in doubt, read the right reference

Do not answer from memory for any substantive task. Read the matching file:

| User's task                                                           | Read this                          |
| --------------------------------------------------------------------- | ---------------------------------- |
| SELECT/CREATE/UPDATE/UPSERT/DELETE/INSERT/RELATE queries              | `references/dml.md`                |
| DEFINE TABLE/FIELD/INDEX/EVENT/FUNCTION/ANALYZER/SEQUENCE, REMOVE     | `references/schema.md`             |
| Row-level PERMISSIONS, `$auth`, `$session`, role checks               | `references/permissions.md`        |
| Graph traversal, LIVE SELECT, transactions, full-text, vector, geo   | `references/advanced.md`           |
| DEFINE ACCESS RECORD/JWT/BEARER, signup/signin, JWT verification     | `references/auth.md`               |
| Record links vs graph edges vs embedding, when to denormalize         | `references/modeling.md`           |
| Adding/removing/renaming fields safely, migration versioning          | `references/migrations.md`         |
| Common real-world queries (pagination, search, upsert, graphs)        | `references/cookbook.md`            |
| Anything weird, failing, or version-sensitive                         | `references/gotchas.md`            |
| **Schema Builder** (3-layer pipeline, CORE_SCHEMA, migrations, gates) | `references/schema-builder.md`     |
| **jsonify / extractId** (Server→Client serialization, RecordId)       | `references/serialization.md`      |
| **Mastra tables** (SCHEMALESS exception, NULL vs NONE)                | `references/mastra.md`             |
| **EventBus / SurrealLiveAdapter** (LIVE queries, channels, worker)    | `references/eventbus.md`           |

## Minimum-ceremony defaults

When writing SurrealQL:

- Prefer `==` over `=` in `WHERE` clauses.
- Add `ONLY` when the user expects a single record, not an array.
- Default to `SCHEMAFULL` for production tables, with `DEFINE FIELD ... TYPE ...` on every field.
- Wrap multi-statement schema migrations in `BEGIN; ... COMMIT;` so they apply atomically.
- For dynamic table names in generated queries, use `type::thing($table, $id)` rather than string concatenation — that's the canonical injection-safe path.
- Comment non-obvious lines (`RETURN NONE` for perf, `FETCH` paths, `WITH INDEX` hints, permission expressions).

## Tiny working scaffold

Copy this when the user asks for "a starting schema" and adapt:

```surql
BEGIN;

DEFINE TABLE user SCHEMAFULL PERMISSIONS
  FOR select, update WHERE id = $auth.id,
  FOR create, delete NONE;
DEFINE FIELD email ON user TYPE string ASSERT string::is::email($value);
DEFINE FIELD password ON user TYPE string
  VALUE crypto::argon2::generate($value)
  PERMISSIONS FOR select NONE;
DEFINE FIELD created_at ON user TYPE datetime
  VALUE $before.created_at OR time::now()
  READONLY;
DEFINE INDEX idx_user_email ON user FIELDS email UNIQUE;

DEFINE ACCESS account ON DATABASE TYPE RECORD
  SIGNUP ( CREATE user SET email = $email, password = $password )
  SIGNIN (
    SELECT * FROM user
    WHERE email = $email
      AND crypto::argon2::compare(password, $password)
  )
  DURATION FOR TOKEN 15m, FOR SESSION 7d;

COMMIT;
```

## Code fences

Use `surql` for SurrealQL blocks. If the tooling doesn't recognize it, fall back to `sql`. Include `-- comments` on lines that do something the user might not expect.

## When to defer to the SDK skill

If the user is writing JavaScript/TypeScript that calls `db.query(...)`, most of their work is still SurrealQL (the query string) but some parts belong in the client code (parameter binding, result destructuring, RecordId construction). Write the SurrealQL here; let the SDK skill handle the surrounding client code. The two skills are designed to work in combination.
