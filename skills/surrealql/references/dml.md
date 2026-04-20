# SurrealQL — data manipulation reference

CREATE, SELECT, UPDATE, UPSERT, DELETE, INSERT, RELATE. Also record IDs, operators, built-in functions.

## Record IDs — the building block

A record ID has two parts separated by `:` — the table name and the identifier.

```surql
person:tobie                          -- bare word (alphanumeric + _)
temperature:1                         -- integer
temperature:⟨1.5⟩                     -- float/decimal (must be escaped)
u:u'01936f5e-...'                     -- UUIDv7 via u'...' literal
log:[2024, 1, 1]                      -- array (useful for time-partitioned IDs)
point:{x: 1, y: 2}                    -- object
person:⟨user@example.com⟩             -- any string, wrapped in angle brackets
person:`user@example.com`             -- alternative escaping with backticks
person:rand()                         -- random ULID at CREATE time
person:ulid()                         -- explicit ULID
person:uuid()                         -- explicit UUID
```

Parenthesized ID parts are expressions evaluated server-side: `person:{"email": $email}` is a computed object ID. Allowed without escaping: alphanumeric + `_` + integer. Everything else (dots, hyphens, slashes, `@`, spaces) needs angle brackets or backticks.

## CREATE — insert new records

```surql
CREATE person SET name = "Tobie", age = 30;
CREATE person CONTENT { name: "Tobie", age: 30 };
CREATE person:tobie CONTENT { name: "Tobie" };              -- explicit ID
CREATE ONLY person:tobie CONTENT { name: "Tobie" };         -- returns object, not [object]
CREATE person CONTENT {...} RETURN id;                      -- return just id
CREATE person CONTENT {...} RETURN NONE;                    -- return nothing (faster)
CREATE person CONTENT {...} RETURN AFTER;                   -- default — full record after
CREATE person CONTENT {...} RETURN DIFF;                    -- JSON Patch diff
CREATE person CONTENT {...} RETURN VALUE name;              -- just the name value, unwrapped
CREATE |person:10| CONTENT { name: "x" };                   -- bulk: 10 records with same content
CREATE |person:1..10| CONTENT {...};                        -- bulk: IDs 1..10
```

`CREATE` fails if the record already exists. Use `UPSERT` for create-or-update.

## SELECT — read

```surql
SELECT * FROM person;                                       -- all records
SELECT * FROM person:tobie;                                 -- one record, wrapped in array
SELECT * FROM ONLY person:tobie;                            -- one record, unwrapped
SELECT name, age FROM person WHERE age >= 18;
SELECT name, age AS years FROM person;                      -- aliases
SELECT VALUE name FROM person;                              -- returns ["Tobie", ...]
SELECT * FROM person ORDER BY created_at DESC LIMIT 10 START 20;
SELECT * FROM person WITH NOINDEX;                          -- force table scan (debugging)
SELECT * FROM person WITH INDEX idx_email;                  -- force a specific index

-- FETCH follows record<t> links and hydrates them in place
SELECT *, author.* FROM post FETCH author;
SELECT * FROM post FETCH author, comments.*.author;         -- nested paths

-- grouping and aggregation
SELECT count() FROM person GROUP ALL;                       -- single-row total
SELECT country, count() AS n FROM person GROUP BY country;
SELECT math::mean(age) AS mean_age FROM person GROUP ALL;

-- SPLIT: turn array field into multiple rows
SELECT * FROM person SPLIT tags;

-- PARALLEL: server parallelizes sub-queries within the statement
SELECT * FROM person WHERE address.city IN ["Paris","Lyon"] PARALLEL;

-- TIMEOUT: abort if slower than threshold
SELECT * FROM person WHERE ... TIMEOUT 2s;

-- EXPLAIN: show the query plan instead of results
SELECT * FROM person WHERE email = $e EXPLAIN;
SELECT * FROM person WHERE email = $e EXPLAIN FULL;
```

**VALUE:** `SELECT VALUE name FROM person` unwraps a single field. Without `VALUE`, you get `[{name: "..."}]`; with it, `["...", ...]`.

## UPDATE — modify existing records

```surql
UPDATE person:tobie SET age = 31, updated_at = time::now();
UPDATE person:tobie MERGE { settings: { theme: "dark" } };  -- deep-merge
UPDATE person:tobie CONTENT { name: "Tobie", age: 31 };     -- REPLACE entire record
UPDATE person:tobie PATCH [
  { op: "replace", path: "/name", value: "T" },
  { op: "add",     path: "/tags/-", value: "admin" }
];                                                          -- JSON Patch (RFC 6902)
UPDATE person SET age += 1 WHERE age < 18;                  -- compound assignment
UPDATE person SET tags += "admin";                          -- array append
UPDATE person SET tags -= "guest";                          -- array remove
UPDATE person UNSET deprecated_field;                       -- remove a field
UPDATE person:tobie SET x=1 RETURN DIFF;                    -- JSON Patch showing change
UPDATE person:tobie SET x=1 RETURN BEFORE;                  -- record before update
```

**MERGE vs CONTENT vs PATCH vs SET** — most-missed distinction:
- `SET a=1, b=2` — update specific fields, others untouched.
- `MERGE { a: 1 }` — deep-merge; nested objects are merged recursively, other fields kept.
- `CONTENT {...}` — full replace; any field not in the object is removed.
- `PATCH [...]` — JSON Patch operations (`add`, `remove`, `replace`, `move`, `copy`, `test`).

`UPDATE` silently returns empty if nothing matched. For create-or-update use `UPSERT`.

## UPSERT — create or update

```surql
UPSERT person:tobie SET name = "Tobie", age = 30;
UPSERT person:tobie MERGE { tags: ["admin"] };
```

If `person:tobie` exists it's updated (same semantics as `UPDATE`); otherwise it's created.

## DELETE — remove

```surql
DELETE person:tobie;
DELETE person WHERE banned == true;
DELETE person WHERE banned == true RETURN BEFORE;           -- return what was deleted
DELETE person RETURN NONE;                                  -- faster, no result shipping
```

Deleting a record also deletes edges pointing to/from it (cascades across `->edge->` and `<-edge<-`).

## INSERT — bulk insert, SQL-compatible shape

```surql
INSERT INTO person (name, age) VALUES ("Tobie", 30), ("Jaime", 25);
INSERT INTO person { name: "Tobie", age: 30 };              -- single object
INSERT INTO person [{...}, {...}];                          -- array of objects
INSERT INTO person (name, age) VALUES ("Tobie", 30) ON DUPLICATE KEY UPDATE age = 31;
INSERT IGNORE INTO person {...};                            -- skip on duplicate id
INSERT RELATION INTO likes { in: person:tobie, out: post:1, at: time::now() };
```

`INSERT` is the bulk-friendly option; it takes the bulk insertion path and supports `ON DUPLICATE KEY UPDATE`. `INSERT RELATION` bulk-creates edge records.

## RELATE — create a graph edge

```surql
RELATE person:tobie->likes->post:1 SET at = time::now();
RELATE person:tobie->wrote->post:1 CONTENT { at: time::now(), device: "mobile" };
RELATE ONLY person:tobie->follows->person:jaime;

-- cartesian: create multiple edges in one statement
RELATE (SELECT id FROM person)->viewed->post:1;
```

`RELATE` creates a record in the edge table (e.g., `likes`) with three reserved fields:
- `id` — the edge's own record ID
- `in` — the source (`person:tobie`)
- `out` — the target (`post:1`)

Traverse with `->` and `<-`:

```surql
SELECT ->likes->post AS liked FROM person:tobie;            -- posts this person likes
SELECT <-likes<-person AS likers FROM post:1;               -- people who like this post
SELECT ->wrote->post->tagged->tag AS tags FROM person:tobie;-- 3-hop traversal
SELECT ->?->post FROM person:tobie;                         -- ? = any edge type
```

## FETCH — follow record links

`FETCH` hydrates fields that store record IDs into the full record:

```surql
DEFINE FIELD author ON post TYPE record<user>;
SELECT * FROM post;                       -- author is "user:tobie" (the ID)
SELECT * FROM post FETCH author;          -- author is the full user record
SELECT * FROM post FETCH author, comments.*.author;
```

Works only on fields typed `record<t>`. For edges (`->likes->post`) you don't need `FETCH`; edge traversal returns the linked records inline.

## Parameters and variables

```surql
LET $min := 18;
LET $adults := SELECT * FROM person WHERE age >= $min;
RETURN $adults;
```

Built-in params:
- `$this` — current record inside a sub-expression, DEFINE FIELD VALUE, EVENT.
- `$value` — new value in `DEFINE FIELD VALUE`/`ASSERT` and in `UPDATE ... SET`.
- `$before` / `$after` — record state before/after change in `DEFINE EVENT` and triggers.
- `$parent` — outer record when inside a sub-select.
- `$auth` — currently signed-in record (record access).
- `$session` — info about the current session (id, ns, db, ac).
- `$token` — JWT claims of the current token.

## Data types and literals

```
string              "hello" 'hello'
bool                true  false
int / float         42  3.14
decimal             3.14dec
number              automatic int/float/decimal
datetime            d'2024-01-01T00:00:00Z'   time::now()
duration            1w2d3h4m5s
uuid                u'018a...'   rand::uuid()
record              person:tobie
array               [1, 2, 3]
object              { a: 1, b: 2 }
set                 <set>[1, 2, 3]        (deduplicated)
option<T>           NONE or T
bytes               b'0x...'
geometry            GeoJSON types (point, line, polygon, etc.)
future              <future> { <expr evaluated on read> }
```

`NONE` means "explicitly unset" (field is typically removed); `NULL` means "explicitly null" (retained as explicit null).

## Operators

| Category    | Operators                                                                      |
| ----------- | ------------------------------------------------------------------------------ |
| Equality    | `==`, `!=`, `?=` (any member equals), `*=` (all members equal)                 |
| Assignment  | `=` (in `WHERE` this is assignment — use `==` for comparison)                  |
| Identity    | `IS`, `IS NOT`                                                                 |
| Numeric     | `+ - * / %`, `**` (power)                                                      |
| String      | `~` (contains, case-insensitive), `!~`, `?~`, `*~`                             |
| Array/set   | `CONTAINS`, `CONTAINSNOT`, `CONTAINSALL`, `CONTAINSANY`, `CONTAINSNONE`,       |
|             | `INSIDE`, `NOTINSIDE`, `OUTSIDE`, `INTERSECTS`                                 |
| Logical     | `AND`, `OR`, `NOT`, `&&`, `\|\|`                                               |
| Null-safe   | `??` (coalesce), `?:`                                                          |
| Range       | `..` (exclusive end), `..=` (inclusive end)                                    |

## Function namespaces

Call with `ns::fn(args)`. Remember the namespaces; look up the exact function.

| Namespace      | Purpose                                                    | Examples                                       |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| `time::`       | Timestamps, durations, formatting                          | `time::now()`, `time::format(d, "%Y")`         |
| `string::`     | String manipulation                                        | `string::lowercase(s)`, `string::slug(s)`      |
| `math::`       | Arithmetic, statistics                                     | `math::mean([1,2,3])`, `math::sqrt(9)`         |
| `array::`      | Array operations                                           | `array::flatten(a)`, `array::distinct(a)`      |
| `object::`     | Object inspection/manipulation                             | `object::keys(o)`, `object::entries(o)`        |
| `crypto::`     | Hashing, HMAC, argon2/bcrypt/pbkdf2/scrypt                 | `crypto::argon2::generate($pw)`                |
| `rand::`       | Random values, ULIDs, UUIDs                                | `rand::ulid()`, `rand::uuid::v7()`             |
| `type::`       | Casting / inspection / dynamic record IDs                  | `type::thing("person", $id)`                   |
| `vector::`     | Vector math for embeddings                                 | `vector::similarity::cosine(a, b)`             |
| `search::`     | Full-text search scoring and highlighting                  | `search::score(1)`                             |
| `session::`    | Session info                                               | `session::id()`, `session::ns()`               |
| `geo::`        | Geospatial ops                                             | `geo::distance(p1, p2)`                        |
| `duration::`   | Duration parsing/arithmetic                                | `duration::secs(d)`                            |
| `encoding::`   | Base64, hex                                                | `encoding::base64::encode(b)`                  |
| `http::`       | HTTP client (disabled by default in prod)                  | `http::get($url)`                              |

Use `type::thing($table, $id)` to build a record ID dynamically from a table name + identifier — canonical injection-safe path.

## Multi-statement queries

Separate with `;`. Each statement gets its own result slot, in order.

```surql
CREATE person:tobie CONTENT { name: "Tobie" };
CREATE person:jaime CONTENT { name: "Jaime" };
SELECT * FROM person;
```

The SDK's `db.query()` returns a 3-element array for the above: two creates and the select.

## RETURN clauses

Every `CREATE`/`UPDATE`/`UPSERT`/`DELETE`/`INSERT`/`RELATE` supports:

- `RETURN NONE` — no result (fastest).
- `RETURN BEFORE` — state before the change.
- `RETURN AFTER` — state after (default).
- `RETURN DIFF` — a JSON Patch describing the change.
- `RETURN VALUE <expr>` — a specific expression, unwrapped.
- `RETURN <expr1>, <expr2>, ...` — specific fields.

For high-throughput writes, `RETURN NONE` is meaningfully faster — it skips serialization of returned records.
