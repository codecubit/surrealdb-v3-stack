# SurrealQL gotchas

Real traps that come up over and over when writing SurrealQL.

## 1. `SELECT FROM record:id` returns a one-element array

```surql
SELECT * FROM person:tobie;          -- returns [{...}]
SELECT * FROM ONLY person:tobie;     -- returns {...}
```

Same for `CREATE/UPDATE/UPSERT/DELETE/RELATE` when you want the unwrapped object.

## 2. `=` in `WHERE` is assignment, not comparison

```surql
SELECT * FROM person WHERE name = "Tobie";   -- works but legally ambiguous
SELECT * FROM person WHERE name == "Tobie";  -- unambiguous, prefer this
```

Inside `SET name = "Tobie"` on UPDATE, `=` is correct — that's assignment. Inside `WHERE`, always use `==`.

## 3. `CREATE` fails if the record exists

```surql
CREATE person:tobie CONTENT { name: "Tobie" };   -- fine first time
CREATE person:tobie CONTENT { name: "Tobie" };   -- error: already exists
```

Use `UPSERT` for create-or-update. Use `INSERT IGNORE INTO person ...` to skip duplicates silently.

## 4. Record IDs with special characters must be escaped

```surql
CREATE person:john.doe;              -- ERROR: `.` is not allowed
CREATE person:⟨john.doe⟩;            -- OK (angle brackets)
CREATE person:`john.doe`;            -- OK (backticks)
CREATE person:⟨user@example.com⟩;    -- emails, UUIDs, anything
```

Allowed without escaping: alphanumeric + underscore + integer.

## 5. `FETCH` only works on `record<t>` fields, not edges

```surql
-- works: author is a record<user> field
SELECT * FROM post FETCH author;

-- does NOT work: likes is an edge, not a record<t> link
SELECT * FROM post FETCH likes;

-- instead, traverse:
SELECT ->likes<-person AS likers FROM post:1;
```

## 6. `SCHEMAFULL` + untyped nested fields = silent issues

With `SCHEMAFULL`, writes to undefined top-level fields error (good). But typing only the parent object leaves nested writes unchecked:

```surql
-- not enough
DEFINE FIELD address ON user TYPE object;

-- explicit nested typing
DEFINE FIELD address.street ON user TYPE string;
DEFINE FIELD address.city   ON user TYPE string;
DEFINE FIELD address.zip    ON user TYPE string;
```

## 7. Field `VALUE` runs on every write — mind the password hashing

`DEFINE FIELD password ON user TYPE string VALUE crypto::argon2::generate($value)` will re-hash the already-hashed password on every update that doesn't touch it. Guard:

```surql
DEFINE FIELD password ON user TYPE string
  VALUE IF $value != $before.password
    THEN crypto::argon2::generate($value)
    ELSE $before.password
  END;
```

Or keep credentials on a separate table.

## 8. `$auth` is empty for operator users

Operator users (from `DEFINE USER ... ON ROOT/NS/DB`) are not records. `$auth.id` is `NONE` for them, and permissions are **bypassed** entirely. That's usually what you want — write permissions against the shape that applies to record-access users and let operators skip them.

## 9. `DEFINE TABLE ... AS SELECT` is a materialized view

```surql
DEFINE TABLE post_count AS SELECT count() FROM post GROUP ALL;
```

This is a **view**, not a normal table. Maintained automatically on writes to the underlying table; you cannot `CREATE` rows into it.

## 10. Transactions are per-query, not per-connection

SurrealDB transactions live inside a `BEGIN; ... COMMIT;` block **within a single query call**. Multiple separate SDK calls are not transactional. For atomicity, put everything in one `BEGIN/COMMIT` block.

## 11. `GROUP ALL` vs `GROUP BY` vs no grouping

- No grouping: one row per input row.
- `GROUP BY field`: one row per distinct `field` value with per-group aggregates.
- `GROUP ALL`: one row total with aggregates across everything.

`SELECT count() FROM person` (no grouping) gives **one `count()` per person**, not a total. Use `GROUP ALL` for a single total.

## 12. `time::now()` is server-side; `d'...'` literals are parsed server-side

Prefer `time::now()` over client-supplied timestamps for event time — avoids clock skew.

## 13. Error messages identify the failing statement by index

Multi-statement `query()` errors say `at statement N` but not the line inside that statement. For long scripts, run them one-at-a-time while iterating.

## 14. Live queries die on reconnect

The server drops subscriptions when the WebSocket disconnects. Re-issue them on reconnect — SurrealDB does not auto-restore.

## 15. `DEFINE EVENT` bodies run with elevated privileges

Events see everything, regardless of the permissions of the user that triggered them. Don't rely on permissions to constrain what an event can do.

## 16. Version drift: v1 `DEFINE SCOPE` vs v3 `DEFINE ACCESS`

If you see `DEFINE SCOPE` in a v3 database, it's a migration artifact — rewrite as `DEFINE ACCESS ... TYPE RECORD`. See `auth.md`.

## 17. `EXPLAIN` shows the query plan

When something is slow or seems not to use an index, add `EXPLAIN FULL` to the statement and read the plan. Faster than guessing.

## 18. Floats vs decimals

Money, invoice amounts, scientific data — use `decimal` (suffix `dec` or cast). Plain numbers are inferred as int/float, and float64 will produce `19.989999...` for amounts the user typed as `19.99`.

---

## Production-learned gotchas

The following were discovered through real production incidents, not documentation.

## 19. `$token` is a reserved variable in v3

```surql
-- ❌ Silently fails or collides with internal token handling
UPDATE user SET token = $token;

-- ✅ Use any other name
UPDATE user SET token = $tkn;
```

The *field name* `token` is safe as an identifier in `SET`. Only the *parameter variable* `$token` is reserved. This applies to any query parameter binding — never name a parameter `$token`.

## 20. NULL vs NONE in SCHEMAFULL — the JS `null` trap

SurrealDB v3 SCHEMAFULL rejects `NULL` (JavaScript `null`) on `option<T>` fields. It expects `NONE` (JavaScript `undefined`).

```typescript
// ❌ JS null becomes SurrealDB NULL → rejected by SCHEMAFULL option<T>
await db.query("UPDATE user SET avatar = $avatar", { avatar: null });

// ✅ JS undefined becomes SurrealDB NONE → accepted
await db.query("UPDATE user SET avatar = $avatar", { avatar: undefined });
```

SCHEMALESS tables accept both NULL and NONE. This is why some tables (like agent memory stores) must stay SCHEMALESS — external SDKs pass `null` that cannot be sanitized.

## 21. `type::record()` is mandatory for record-typed fields

When a schema field is `TYPE record<table>`, bare string IDs are rejected at query time:

```surql
-- ❌ Bare string — fails silently or returns 0 rows
SELECT * FROM notification WHERE userId = "user:abc123";

-- ✅ Wrapped — correct
SELECT * FROM notification WHERE userId = type::record('user', $userId);

-- ✅ Primary key lookup
SELECT * FROM type::record('user', $id);

-- ✅ Optional record field (can be NONE)
UPDATE offer SET category = IF $cat != NONE
  THEN type::record('offer_category', $cat)
  ELSE NONE END;
```

This applies to `SELECT WHERE`, `CREATE SET`, `UPDATE SET`, and `RELATE` — anywhere a record-typed field is referenced.

## 22. `DEFAULT` does NOT backfill existing rows

`DEFAULT` only fires on `CREATE`. Adding a non-optional field with `DEFAULT` to a table that already has rows leaves those rows with `NONE` — and SCHEMAFULL v3 rejects `NONE` on non-optional fields at **READ** time, breaking every query on the table.

```surql
-- ❌ Existing rows will have NONE → coerce error on SELECT
DEFINE FIELD IF NOT EXISTS balance ON user TYPE number DEFAULT 0;

-- ✅ Always pair with an idempotent backfill
DEFINE FIELD IF NOT EXISTS balance ON user TYPE number DEFAULT 0;
UPDATE user SET balance = 0 WHERE balance IS NONE;
```

This caused production breakages on fields `user.balance` (v64/v65) and `user.active` (v70/v73). The backfill `UPDATE` is not optional — it's mandatory for any non-optional field added to an existing table.

## 23. Ghost table auto-creation trap

`DEFINE FIELD` against a non-existent table silently auto-creates it as SCHEMALESS. This leaves a permanent ghost that blocks later `DEFINE TABLE ... SCHEMAFULL` with `FLEXIBLE can only be used in SCHEMAFULL tables`.

```surql
-- ❌ If mod_blog_post doesn't exist yet, this creates it as SCHEMALESS
DEFINE FIELD status ON mod_blog_post TYPE string;

-- Later, the module's install() tries:
DEFINE TABLE mod_blog_post SCHEMAFULL;  -- ERROR: FLEXIBLE conflict

-- ✅ Always DEFINE TABLE first, then fields
DEFINE TABLE IF NOT EXISTS mod_blog_post SCHEMAFULL;
DEFINE FIELD status ON mod_blog_post TYPE string;
```

Rule: never `DEFINE FIELD` on a table that hasn't been explicitly `DEFINE TABLE`'d in the same transaction or a prior one.

## 24. `SELECT VALUE` vs `SELECT` — scalar unwrapping

```surql
SELECT name FROM person:tobie;         -- returns [{name: "Tobie"}]
SELECT VALUE name FROM person:tobie;   -- returns ["Tobie"]
```

`SELECT VALUE` returns the raw value(s) without wrapping in an object. Essential for subquery comparisons:

```surql
-- ❌ Returns [{id: ...}] — can't use in WHERE ... IN
SELECT id FROM person WHERE age > 30;

-- ✅ Returns ["person:abc", ...] — usable in WHERE ... IN
SELECT VALUE id FROM person WHERE age > 30;
```

## 25. ORDER BY fields must appear in SELECT projections

```surql
-- ❌ May fail or produce unexpected results
SELECT name FROM person ORDER BY age DESC;

-- ✅ Include the ORDER BY field in projections
SELECT name, age FROM person ORDER BY age DESC;
```

If you need to sort by a field but don't want it in the output, select it and strip it client-side.

## 26. `OVERWRITE` does NOT remove existing field definitions

```surql
-- ❌ Assumes OVERWRITE wipes everything — it doesn't remove field defs
DEFINE TABLE OVERWRITE my_table SCHEMALESS;
-- Old DEFINE FIELD entries from the previous SCHEMAFULL definition survive!

-- ✅ Explicitly remove fields first
REMOVE FIELD IF EXISTS old_field ON my_table;
DEFINE TABLE OVERWRITE my_table SCHEMALESS;
```

`OVERWRITE` replaces the table definition itself (mode, permissions) but does NOT cascade to child definitions (`DEFINE FIELD`, `DEFINE INDEX`, `DEFINE EVENT`). Those must be removed explicitly.

## 27. Migration versioning trap

In custom schema builders with version-gated migrations, adding SQL to an already-applied migration version will never run:

```
// ❌ Version 5 already ran → new lines in v5 are skipped
SCHEMA_VERSION = 5;
MIGRATIONS[5] = "original SQL; new SQL added later";

// ✅ Always create the next version
SCHEMA_VERSION = 6;
MIGRATIONS[6] = "the new SQL";
```

Never edit a migration that's already been applied. Always increment the version number.

## 28. `INSIDE` operator fails with record-typed fields

```surql
-- ❌ Returns 0 rows — productId is TYPE record<product>, not a string
SELECT * FROM order_item
WHERE productId INSIDE ["product:abc", "product:def"];

-- ✅ Use individual type::record() comparisons
SELECT * FROM order_item
WHERE productId = type::record('product', $id1)
   OR productId = type::record('product', $id2);

-- ✅ Or use a subquery
SELECT * FROM order_item
WHERE productId INSIDE (SELECT VALUE id FROM product WHERE category = "electronics");
```

`INSIDE` does string comparison internally. Record-typed fields are `record` values, not strings — the comparison silently returns no matches.
