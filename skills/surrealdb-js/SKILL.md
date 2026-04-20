---
name: surrealdb-js
description: Write correct JavaScript and TypeScript against the SurrealDB SDK v2 (`surrealdb` npm package). Use this skill whenever the user imports from `"surrealdb"`, calls `new Surreal()`, `db.connect`, `db.use`, `db.signin`, `db.signup`, `db.authenticate`, `db.query`, `db.select`, `db.create`, `db.update`, `db.merge`, `db.patch`, `db.delete`, `db.live`, `db.kill`, `db.close`, constructs a `RecordId`/`Table`/`Uuid`, sets up a SurrealDB connection in a Node or browser app, debugs SDK errors like `ResponseError` or `EngineDisconnected`, or migrates from the legacy `surrealdb.js` v1 package. Pair with the `surrealql` skill whenever the user writes the query string. Trigger even when the user does not explicitly name the skill.
---

# SurrealDB JavaScript SDK v2

This skill is the client library only; for the SurrealQL query language use the `surrealql` skill. The two work together — one writes the query string, the other writes the surrounding code that sends it.

Target: **`surrealdb@^2`** (the npm package `surrealdb`, stable v2.x). The legacy v1 package is called `surrealdb.js` and is a different codebase — if you see that import, flag it and recommend upgrading.

## Five rules you will break if you skip them

1. **`db.query()` always returns an array of statement results.** Even a one-statement call returns `[result]`. Destructure every time: `const [rows] = await db.query<[Row[]]>("SELECT * FROM t");`

2. **`update` replaces; `merge` merges; `patch` is surgical.** `db.update(id, {age:31})` wipes every field not in `{age:31}`. For partial updates use `db.merge`. This is the single most common SDK bug.

3. **Record IDs are not strings.** Build them with `new RecordId("person","tobie")`, not `"person:tobie"`. Parse existing `"table:id"` strings with `new StringRecordId(...)`.

4. **Always bind, never interpolate.** `db.query(sql, bindings)` — second arg is the parameter map, referenced as `$foo` in the SQL. Bindings are values, not SurrealQL fragments; for dynamic table names use `type::thing($table, $id)` inside the SurrealQL.

5. **One long-lived client per process.** `new Surreal()` + `connect()` sets up a CBOR+WebSocket session. Don't do it per HTTP request. Cache a module-level promise.

## Canonical minimal example

Paste-adapt this when the user asks for a working starting point:

```typescript
import { Surreal, RecordId } from "surrealdb";

const db = new Surreal();

try {
  await db.connect("ws://127.0.0.1:8000/rpc");
  await db.signin({ username: "root", password: "root" });
  await db.use({ namespace: "app", database: "main" });

  const person = await db.create<{ id: RecordId; name: string }>(
    new RecordId("person", "tobie"),
    { name: "Tobie" },
  );

  const [adults] = await db.query<[Array<{ id: RecordId; name: string }>]>(
    "SELECT id, name FROM person WHERE age >= $min ORDER BY name",
    { min: 18 },
  );

  console.log(person, adults);
} finally {
  await db.close();
}
```

Notes that matter: path is `/rpc`; WebSocket (`ws://`/`wss://`) for anything needing live queries; HTTP (`http://`/`https://`) for request/response-only (serverless). Root signin is for dev and migrations — for end-user auth use record access (see `references/patterns.md` and the `surrealql` skill's `auth.md`).

## When to use a dedicated SDK method vs `db.query`

| Task                                               | Prefer                              |
| -------------------------------------------------- | ----------------------------------- |
| Fetch one or all records of a table                | `db.select(thing)`                  |
| Create one or bulk records                         | `db.create` / `db.insert`           |
| Replace one record fully                           | `db.update(id, full)`               |
| Partial update                                     | `db.merge(id, patch)`               |
| RFC 6902 surgical edit                             | `db.patch(id, ops)`                 |
| Create-or-update                                   | `db.upsert`                         |
| Anything with `WHERE`, `FETCH`, `GROUP BY`, multi-statement, `RELATE`, `LIVE SELECT` | `db.query` |

The dedicated methods are type-safe and shorter. Drop to `db.query` only when the SurrealQL is doing something the dedicated methods can't express.

## Reference files

| Task                                                                 | Read this                         |
| -------------------------------------------------------------------- | --------------------------------- |
| Full API surface (every method, every helper class, types)           | `references/api.md`               |
| Auth flows, connection lifecycle, live query reconnect, testing      | `references/patterns.md`          |
| Common mistakes (update-vs-merge, RecordId vs string, query shape)   | `references/gotchas.md`           |

Read them before writing non-trivial code. The method names look familiar, but small details (what `update` replaces, when to destructure, how CBOR treats decimals) matter.

## Types and correctness

TypeScript is strongly recommended even for small scripts. The SDK ships its own `.d.ts`; you don't need `@types/surrealdb`. Typical pattern:

```typescript
type Person = {
  id: RecordId<"person">;
  name: string;
  age: number;
  created_at: Date;
};

// Generics on every call — the tuple shape for db.query mirrors your statements.
const [adults] = await db.query<[Person[]]>(
  "SELECT * FROM person WHERE age >= $min",
  { min: 18 },
);
```

When the SDK generic is missing, returns degrade to `unknown` — painful but honest. Fill them in.

## Error handling

Structured errors are thrown, not returned. Catch them explicitly:

```typescript
import { Surreal, ResponseError } from "surrealdb";
try {
  await db.query("SELECT * FROM nonexistent;");
} catch (err) {
  if (err instanceof ResponseError) {
    console.error("SurrealDB rejected the query:", err.message);
  } else {
    throw err;
  }
}
```

For production: wrap the client in a small layer that reconnects on `EngineDisconnected` and re-authenticates. Details in `references/patterns.md`.

## Version drift

- **SDK v1 (`surrealdb.js`)** — different package, different import, different signatures. Tell the user to upgrade; if they can't, point out that what you're writing is v2 syntax and needs adaptation.
- **Server v1/v2** — SDK v2 mostly works against v2 servers but some features (like `DEFINE ACCESS`-backed signup/signin) differ. Check the `surrealql` skill's `auth.md` for v2 vs v3 mapping.

If the version is unclear from imports and config, ask before assuming.
