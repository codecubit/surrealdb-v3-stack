# `surrealdb` v2 — API reference

Every method on `Surreal`, every exported helper class, and the shapes they take.

## Install

```bash
npm install surrealdb
# pnpm/yarn/bun all work
```

## Imports

```typescript
import {
  Surreal,
  RecordId,
  StringRecordId,
  Table,
  Uuid,
  Duration,
  Decimal,
  ResponseError,
} from "surrealdb";
```

- `Surreal` — client class.
- `RecordId(table, id)` — typed record ID. Prefer over string concatenation.
- `StringRecordId("table:id")` — parse an existing `table:id` string.
- `Table("person")` — typed table reference; accepted wherever a table name is expected.
- `Uuid`, `Duration`, `Decimal` — typed wrappers that round-trip correctly over CBOR.
- `ResponseError` — error class thrown on server errors (see below).

## Construction and connection

```typescript
const db = new Surreal();

// WebSocket — required for live queries
await db.connect("ws://127.0.0.1:8000/rpc");
await db.connect("wss://my.surrealdb.cloud/rpc");

// HTTP — simpler for serverless, no live queries
await db.connect("http://127.0.0.1:8000/rpc");

// Inline NS/DB/auth
await db.connect("wss://...", {
  namespace: "app",
  database: "main",
  auth: { username: "root", password: "root" }, // or a JWT string
});
```

URL path is always `/rpc`. `connect` throws on failure. Wrap in `try`/`finally` with `db.close()` in the finally.

## `use` — select namespace and database

```typescript
await db.use({ namespace: "app", database: "main" });
await db.use({ namespace: "app" });        // switch NS only
await db.use({ database: "staging" });     // switch DB only
```

Queries before `use` (other than root `signin`) error out.

## `signin` — authenticate as operator or record-access user

Operator (root/NS/DB user):

```typescript
await db.signin({ username: "root", password: "root" });            // root

await db.signin({
  username: "alice",
  password: "secret",
  namespace: "app",
});                                                                  // NS user

await db.signin({
  username: "dave",
  password: "secret",
  namespace: "app",
  database: "main",
});                                                                  // DB user
```

Record access (end-user auth against a `DEFINE ACCESS ... TYPE RECORD`):

```typescript
const token = await db.signin({
  namespace: "app",
  database: "main",
  access: "account",                    // the DEFINE ACCESS name
  variables: {                          // values injected into the SIGNIN block
    email: "tobie@example.com",
    password: "hunter2",
  },
});
```

Returns a JWT string (empty string for operator logins).

## `signup` — sign up a record-access user

```typescript
const token = await db.signup({
  namespace: "app",
  database: "main",
  access: "account",
  variables: {
    email: "tobie@example.com",
    password: "hunter2",
    name: "Tobie",
  },
});
```

The `variables` object is passed into the `SIGNUP` block of the access method.

## `authenticate` / `invalidate`

```typescript
await db.authenticate(jwt);             // resume a session using a stored JWT
await db.invalidate();                  // drop the current auth ("sign out")
```

## `let` / `unset` — connection-scoped parameters

```typescript
await db.let("tenant", "acme");
const [rows] = await db.query("SELECT * FROM post WHERE tenant == $tenant");
await db.unset("tenant");
```

Useful for values stable across many queries in a session (tenant, locale). For per-query values, pass them in the bindings arg of `db.query` instead.

## `query` — the escape hatch

```typescript
const [rows] = await db.query<
  [Array<{ id: RecordId; name: string; age: number }>]
>(
  "SELECT id, name, age FROM person WHERE age >= $min ORDER BY age",
  { min: 18 },
);
```

Rules:
- **Always destructure.** Top-level result is an array with one slot per semicolon-separated statement.
- **Always bind.** Second arg is the parameter map; values only. Do not template-interpolate user input.
- **Type the generic.** `db.query<[Row[], Row, number]>` — tuple mirrors statement order.
- Errors from the server throw; the result array contains values only when the whole query succeeded.

Multi-statement example:

```typescript
const [created, total] = await db.query<[
  { id: RecordId; name: string },
  number,
]>(
  `
    CREATE ONLY person CONTENT { name: $name } RETURN AFTER;
    (SELECT count() FROM person GROUP ALL)[0].count;
  `,
  { name: "Tobie" },
);
```

## CRUD helpers

All take a `Table`, a `RecordId`, or a plain table-name string.

```typescript
// SELECT
const all = await db.select<Person>("person");                        // all records
const one = await db.select<Person>(new RecordId("person", "tobie")); // single record (unwrapped)

// CREATE (errors if exists)
const created = await db.create<Person>("person", { name: "Tobie" });
const withId  = await db.create<Person>(new RecordId("person", "tobie"), { name: "Tobie" });

// INSERT (bulk — faster than looping CREATE)
const inserted = await db.insert<Person>("person", [
  { name: "Tobie", age: 30 },
  { name: "Jaime", age: 25 },
]);

// INSERT relation (bulk RELATE)
await db.insertRelation("likes", [
  { in: new RecordId("person", "tobie"), out: new RecordId("post", 1) },
]);

// UPDATE (REPLACES the record)
const updated = await db.update<Person>(new RecordId("person", "tobie"), {
  name: "Tobie",
  age: 31,
});

// UPSERT (create-or-update — still a replace)
const upserted = await db.upsert<Person>(new RecordId("person", "tobie"), {
  name: "Tobie",
});

// MERGE (deep-merge — safe for partial updates)
const merged = await db.merge<Person>(new RecordId("person", "tobie"), {
  settings: { theme: "dark" },
});

// PATCH (RFC 6902 JSON Patch)
const patched = await db.patch<Person>(new RecordId("person", "tobie"), [
  { op: "replace", path: "/name", value: "T" },
  { op: "add",     path: "/tags/-", value: "admin" },
]);

// DELETE
const deleted = await db.delete<Person>(new RecordId("person", "tobie"));
const wipedAll = await db.delete<Person>("person");                   // deletes ALL rows
```

### `update` vs `merge` vs `patch` vs `upsert`

| Method            | Effect                                                                                |
| ----------------- | ------------------------------------------------------------------------------------- |
| `db.update(id,x)` | Replaces the whole record with `x`. Any field not in `x` is removed.                  |
| `db.upsert(id,x)` | Same as `update`, but creates if missing.                                             |
| `db.merge(id,x)`  | Deep-merges `x` into the record. Keeps fields not mentioned.                          |
| `db.patch(id,ops)`| Applies a JSON Patch array: `add`, `remove`, `replace`, `move`, `copy`, `test`.       |

Use `merge` for "change these fields, keep everything else." Stare at this until it sticks.

## `live` / `subscribeLive` / `kill`

```typescript
// Subscribe directly to a table
const liveId = await db.live<Person>(
  "person",
  (action, result) => {
    switch (action) {
      case "CREATE": console.log("new:", result); break;
      case "UPDATE": console.log("changed:", result); break;
      case "DELETE": console.log("gone:", result); break;
      case "CLOSE":  console.log("subscription closed"); break;
    }
  },
);

// Unsubscribe
await db.kill(liveId);
```

Filtered subscription via `LIVE SELECT`:

```typescript
const [liveId] = await db.query<[Uuid]>(
  "LIVE SELECT * FROM post WHERE author = $author",
  { author: new RecordId("user", "tobie") },
);

await db.subscribeLive<Post>(liveId, (action, result) => { /* ... */ });
await db.kill(liveId);
```

Requires WebSocket. Live subscriptions die on reconnect and **the SDK does not auto-restore them** — see `patterns.md` for a reconnect helper.

## `run` — call a defined function or builtin

```typescript
const greeting = await db.run<string>("fn::greet", ["Tobie"]);
const now      = await db.run<Date>("time::now");
```

Equivalent to `RETURN fn::greet("Tobie")` via `db.query`, shorter for one-off calls.

## `version` / `info` / `close`

```typescript
const version = await db.version();     // server version string
const me      = await db.info<Me>();    // $auth — signed-in record (null if none)
await db.close();                       // graceful disconnect
```

`close()` is important in short-lived Node scripts — without it, open WebSockets prevent clean process exit.

## Error classes

| Error class          | Cause                                                              |
| -------------------- | ------------------------------------------------------------------ |
| `ResponseError`      | Server returned an error (bad SurrealQL, permission denied, etc.). |
| `EngineDisconnected` | WebSocket dropped mid-request.                                     |
| `NoActiveSocket`     | Method called before `connect()` or after `close()`.               |
| `UnexpectedResponse` | Server sent something the SDK couldn't decode (version mismatch). |

## Helper classes

### `RecordId<TableName>`

```typescript
const id = new RecordId("person", "tobie");
const composite = new RecordId("log", [2024, 1, 1]);
const computed = new RecordId("point", { x: 1, y: 2 });

// serialize/toString
id.toString();  // "person:tobie"
```

Use `RecordId<"person">` to narrow the table in types.

### `StringRecordId`

```typescript
const id = new StringRecordId("person:tobie");
// Parses into a RecordId at serialization time.
```

Useful when you receive `table:id` strings from elsewhere (JWT claims, URLs).

### `Table`

```typescript
const personTable = new Table("person");
await db.create(personTable, { name: "Tobie" });
```

Interchangeable with a plain string `"person"` in CRUD methods.

### `Uuid`

```typescript
const id = new Uuid("018a...");
```

Used when a field is typed `uuid` and you want CBOR to encode it as UUID, not string.

### `Decimal`

```typescript
import { Decimal } from "surrealdb";
await db.create("order", { amount: new Decimal("19.99") });
```

Use for money and any precise decimal. Plain `19.99` round-trips through JS float64 and can become `19.989999...`.

### `Duration`

```typescript
import { Duration } from "surrealdb";
await db.update(id, { ttl: new Duration("1d") });
```

For fields typed `duration`.
