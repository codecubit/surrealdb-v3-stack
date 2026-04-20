---
name: surrealdb-js-gotchas
description: Common SDK pitfalls and how to avoid them.
---

# SDK gotchas

Real traps that come up when using `surrealdb@^2` from JavaScript/TypeScript. If the code "looks right but doesn't work", check these first.

## 1. Forgetting to destructure `db.query()`

```typescript
// wrong — `rows` is the whole results array, not the first statement's rows
const rows = await db.query<[Person[]]>("SELECT * FROM person");
rows.forEach(...);          // iterating over statement slots, not people

// right
const [rows] = await db.query<[Person[]]>("SELECT * FROM person");
rows.forEach(...);
```

Even a single-statement query returns `[result]`. Always destructure.

## 2. Using `update` when you meant `merge`

```typescript
// Before: { id, name: "Tobie", age: 30, email: "tobie@example.com" }

// Wipes everything except what you pass
await db.update(id, { age: 31 });
// After:  { id, age: 31 }   — name and email GONE

// Partial update
await db.merge(id, { age: 31 });
// After:  { id, name: "Tobie", age: 31, email: "tobie@example.com" }
```

`update` is a replace. `merge` is a deep-merge. Always check which you need.

## 3. Passing `"table:id"` strings where a `RecordId` is expected

```typescript
// Works for SurrealQL inside db.query, not for CRUD helpers
await db.select("person:tobie");            // selects the TABLE "person:tobie"

// Right
await db.select(new RecordId("person", "tobie"));
// or parse an existing string
await db.select(new StringRecordId("person:tobie"));
```

The CRUD helpers treat a plain string as a table name, not a record link.

## 4. Template-interpolating user input into the query string

```typescript
// SurrealQL injection
const name = req.body.name;
await db.query(`SELECT * FROM person WHERE name = "${name}"`);

// Safe
await db.query(
  "SELECT * FROM person WHERE name == $name",
  { name: req.body.name },
);
```

Second argument is a values-only bindings object. Identifiers (table names, field names) cannot be bound — use `type::table($t)` / `type::thing($t,$id)` for those.

## 5. Creating `new Surreal()` per request

```typescript
// wrong — CBOR + WebSocket handshake on every HTTP request
app.get("/users", async (req, res) => {
  const db = new Surreal();
  await db.connect(...);                  // slow
  await db.signin(...);
  const users = await db.select("user");
  res.json(users);
  await db.close();
});

// right — one module-level cached promise (see patterns.md)
const db = await getDb();
app.get("/users", async (req, res) => {
  res.json(await db.select("user"));
});
```

Handshakes add latency and exhaust server limits. See `patterns.md` for the module-level caching pattern.

## 6. Missing `await db.close()` in short-lived scripts

```typescript
const db = new Surreal();
await db.connect(...);
await db.query(...);
// process hangs here — WebSocket keeps event loop alive
```

Always wrap in `try/finally` with `db.close()` when running one-off scripts (migrations, seeders, CLI tools).

## 7. Expecting live queries to survive reconnect

```typescript
const liveId = await db.live("post", handler);
// WebSocket drops, reconnects — live subscription is GONE on the server
await db.kill(liveId);                    // no-op, already dead
```

The SDK does not auto-resubscribe. Re-issue the `LIVE SELECT` after reconnect — see the `LiveManager` helper in `patterns.md`.

## 8. Using float for money

```typescript
// 19.989999...
await db.create("order", { total: 19.99 });

// exact
import { Decimal } from "surrealdb";
await db.create("order", { total: new Decimal("19.99") });
```

CBOR encodes JS `number` as float64. Use `Decimal` for money, invoice amounts, scientific precision. On the server side, the field should be typed `decimal`.

## 9. `Date` round-trips correctly — but `new Date("2025-01-01")` parses UTC

This is a JS footgun, not a SurrealDB one, but it bites users:

```typescript
new Date("2025-01-01");         // 2025-01-01T00:00:00.000Z (UTC)
new Date("2025-01-01T12:00");   // local time — depends on the machine
```

For consistency, send explicit UTC strings or use `time::now()` server-side via SurrealQL.

## 10. Forgetting `db.use(...)` before querying

```typescript
await db.connect("ws://127.0.0.1:8000/rpc");
await db.signin({ username: "root", password: "root" });
await db.query("SELECT * FROM person");    // ResponseError: NS / DB not selected
```

For anything except root-level admin commands, call `db.use({ namespace, database })` first. If you passed `namespace`/`database` in the `connect` options, it's already done.

## 11. Confusing operator signin with record-access signin

```typescript
// Operator (root/NS/DB user) — DEFINE USER
await db.signin({ username: "root", password: "root" });

// Record access (end user) — DEFINE ACCESS ... TYPE RECORD
await db.signin({
  namespace: "app",
  database: "main",
  access: "account",                  // required!
  variables: { email, password },     // NOT `username`
});
```

If you get `user not found` despite having the row, check you're using `access:` + `variables:`, not `username:` + `password:`.

## 12. Assuming `db.insert` returns objects in the same order you sent

Usually it does, but don't rely on it for matching. If you need to correlate inputs and outputs, include a key you control in the payload.

## 13. Mixing SDK v1 (`surrealdb.js`) and v2 (`surrealdb`)

```typescript
import Surreal from "surrealdb.js";      // LEGACY, v1
import { Surreal } from "surrealdb";     // CURRENT, v2
```

v1 is a different package and codebase. Signatures and return shapes differ. If you see `surrealdb.js` imports, upgrade — v1 is not compatible with v3 server features like `DEFINE ACCESS`.

## 14. Expecting `info()` to give server info

```typescript
await db.info();        // returns $auth — the signed-in record, NOT server info
await db.version();     // server version string
```

Misleading name. `info` is the authenticated record.

## 15. Trying to read auth from `db.info()` for operator users

```typescript
// Signed in as root / NS user / DB user
await db.info();        // null / undefined — operators are not records
```

`info` only returns a value after a record-access signin, when `$auth` is a user record.

## 16. `db.query` results order doesn't match result types if you break a statement

If one statement in a multi-statement query fails, the SDK throws a `ResponseError` for the whole batch — you don't get partial results. For "run these independently, report each", issue separate calls or use `BEGIN/COMMIT` with explicit error handling inside.

## 17. Forgetting that HTTP transport can't do live queries

```typescript
await db.connect("http://127.0.0.1:8000/rpc");
await db.live("post", handler);      // throws — live requires WebSocket
```

HTTP is fine for serverless request/response. For live queries, use `ws://` or `wss://`.

## 18. `EngineDisconnected` propagating into user code unexpectedly

Any in-flight query can reject with `EngineDisconnected` if the socket drops. Wrap in a retry layer (see `ReliableDb` in `patterns.md`) or make the calling code tolerant.
