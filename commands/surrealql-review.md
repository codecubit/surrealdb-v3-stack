---
description: Review a SurrealQL file or snippet for correctness, v3 compatibility, and common gotchas.
---

# /surrealql-review

Review SurrealQL code (a `.surql` file, a schema migration, a query inside a JS string) for problems before it ships. Target: **SurrealDB v3 server**.

## Input

- A path to a `.surql` file, or
- A pasted SurrealQL snippet, or
- A JS/TS file that contains a `db.query(...)` call — pull the query string out and review it.

If the user gave no input, ask once: "Paste the SurrealQL or give me the file path."

## What to check

Walk the code and flag each issue with a severity and a fix. Use the checklist below. Don't invent problems — only flag what's actually wrong.

### v3 compatibility

- **`DEFINE SCOPE`** — v1 syntax. Rewrite as `DEFINE ACCESS ... ON DATABASE TYPE RECORD ... DURATION FOR SESSION ...`.
- **`SIGNIN`/`SIGNUP` blocks with v1 semantics** — confirm they sit inside a `DEFINE ACCESS` (not a `DEFINE SCOPE`).
- **Missing `DURATION` on `DEFINE ACCESS`** — defaults exist, but explicit short `FOR TOKEN` (15m) is safer for record access.
- **`DEFINE LOGIN` / `DEFINE TOKEN`** — removed. Map to `DEFINE USER` / `DEFINE ACCESS TYPE JWT`.

### Correctness traps

- **`=` in `WHERE`** — flag; recommend `==`. `SET x = y` is fine.
- **`CREATE` on a likely-existing record** — suggest `UPSERT` or `INSERT IGNORE`.
- **`SELECT FROM record:id` without `ONLY`** — flag if the user expects a single object, not `[obj]`.
- **Record ID with special chars unquoted** — recommend `⟨...⟩` or `` `...` ``.
- **`FETCH` on an edge name** — won't work; recommend `->edge<-target` traversal.
- **`password` field with `VALUE crypto::argon2::generate($value)` and no guard** — re-hashes on every update. Suggest the `IF $value != $before.password THEN ... ELSE $before.password END` guard.
- **`SCHEMAFULL` tables with untyped nested objects** — flag missing nested field definitions.
- **`GROUP BY` missing when aggregating per row** — e.g. `SELECT count() FROM t` returns one row per record, not a total. Suggest `GROUP ALL`.
- **`BEGIN/COMMIT` split across multiple SDK calls** — only atomic within one call.
- **`DEFINE TABLE ... AS SELECT`** — remind that it's a materialized view, not writable.

### Production-incident traps

- **`$token` as query parameter** — reserved variable in v3. Flag and recommend `$tkn` or any other name.
- **Bare string on `record<table>` field** — e.g. `WHERE userId = "user:abc"`. Flag; must use `type::record('user', $id)`.
- **`DEFINE FIELD ... TYPE <non-optional> DEFAULT <X>` without backfill** — DEFAULT only runs on CREATE, not existing rows. SCHEMAFULL rejects NONE at READ time. Flag and require `UPDATE table SET field = X WHERE field IS NONE`.
- **`DEFINE FIELD` without prior `DEFINE TABLE`** — auto-creates table as SCHEMALESS (ghost table). Flag; always define the table first.
- **`INSIDE` with record-typed fields** — `WHERE field INSIDE ["table:id"]` silently returns 0 rows. Flag; use `type::record()` comparisons.
- **`OVERWRITE` assuming it removes child definitions** — it doesn't remove DEFINE FIELD/INDEX/EVENT. Flag if user relies on OVERWRITE to clean slate.
- **`SELECT ... ORDER BY field` where field is not in projections** — may fail or produce unexpected results. Flag.
- **Passing JS `null` to `option<T>` field in SCHEMAFULL** — NULL is rejected, NONE (undefined) is accepted. Flag if visible in SDK context.

### Permissions

- Any `DEFINE TABLE` **without `PERMISSIONS`** clause when record access is in use → flag as "permissions default to `NONE` for select/update/delete unless you're an operator. Add explicit `PERMISSIONS FOR ... WHERE ...`."
- Permissions referencing `$auth` on tables also readable by operator users → note that operators bypass permissions (intentional but worth calling out).

### Type safety

- `float` fields holding money → recommend `decimal`.
- `string` fields holding UUIDs → consider `uuid`.
- `datetime` comparisons with client-supplied timestamps → prefer `time::now()` server-side.

### Performance

- Unbounded `SELECT` on a large table with `FETCH` chains → recommend `LIMIT` + indexing.
- Missing `DEFINE INDEX` on fields used in `WHERE` equality filters.
- Full-text search (`@@`) without `DEFINE ANALYZER` + `DEFINE INDEX ... SEARCH ANALYZER`.

## Output format

Present findings as a markdown table, grouped by severity (blocker → warning → nit):

| Severity | Line(s) | Issue | Fix |
| --- | --- | --- | --- |
| blocker | 12 | `DEFINE SCOPE` is v1 syntax, not supported by v3 | Rewrite as `DEFINE ACCESS account ON DATABASE TYPE RECORD ... DURATION FOR SESSION 24h` |
| warning | 37 | Unbounded `SELECT ... FETCH author, comments.author` could explode on large data | Add `LIMIT 100` or paginate with `START AT` |
| nit | 48 | `WHERE name = "Tobie"` uses assignment syntax | Prefer `==` for clarity |

After the table, show corrected excerpts for each blocker using fenced ```surql blocks. Keep the excerpts minimal — don't rewrite the whole file unless asked.

## What not to do

- Don't rewrite style preferences the user didn't ask about.
- Don't suggest removing permissions to "make it work" — surface the missing permission and stop.
- Don't flag anything you can't explain.

If the code looks fine, say so explicitly and move on. A short "no issues found, v3-compatible" is a valid response.
