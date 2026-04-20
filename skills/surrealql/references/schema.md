# Schema — DEFINE and REMOVE

Every schema-defining statement. Permissions live in `permissions.md`; auth-related `DEFINE ACCESS` lives in `auth.md`.

## Hierarchy and `USE`

```
Root
└── Namespace (NS)
    └── Database (DB)
        └── Tables / Records / Functions / Access methods / etc.
```

`USE NS app; USE DB main;` (or `USE NS app DB main;`) changes the current context. NS-level users see all DBs; DB-level users see only their DB.

## DEFINE TABLE

```surql
DEFINE TABLE person SCHEMALESS;                        -- default: any fields allowed
DEFINE TABLE person SCHEMAFULL;                        -- only defined fields allowed
DEFINE TABLE person TYPE NORMAL;                       -- default
DEFINE TABLE likes TYPE RELATION;                      -- edge table (requires in/out)
DEFINE TABLE likes TYPE RELATION IN person OUT post;   -- constrained edge
DEFINE TABLE likes TYPE RELATION IN person|org OUT post;
DEFINE TABLE likes TYPE RELATION ENFORCED;             -- server validates in/out exist

-- views: materialized SELECT
DEFINE TABLE post_stats AS
  SELECT count() AS posts, author FROM post GROUP BY author;

-- idempotent variants
DEFINE TABLE IF NOT EXISTS person SCHEMALESS;
DEFINE TABLE OVERWRITE person SCHEMAFULL;              -- atomic drop+recreate
```

`SCHEMAFULL` (recommended for production) rejects writes to undefined fields. `DEFINE TABLE foo AS SELECT ...` is a materialized view — it auto-maintains on writes to underlying tables and you can't `CREATE` into it directly.

## DEFINE FIELD

```surql
DEFINE FIELD name ON person TYPE string;
DEFINE FIELD email ON person TYPE string ASSERT string::is::email($value);
DEFINE FIELD age ON person TYPE int ASSERT $value >= 0 AND $value <= 130;
DEFINE FIELD tags ON person TYPE array<string>;
DEFINE FIELD tags.* ON person TYPE string;             -- element-level typing
DEFINE FIELD address ON person TYPE object;
DEFINE FIELD address.city ON person TYPE string;       -- typed nested field
DEFINE FIELD created_at ON person TYPE datetime
  VALUE $before.created_at OR time::now()              -- set on CREATE, preserve on UPDATE
  READONLY;                                            -- no client writes
DEFINE FIELD updated_at ON person TYPE datetime
  VALUE time::now();                                   -- overwritten every write
DEFINE FIELD full_name ON person
  VALUE string::concat(first_name, " ", last_name);    -- computed
DEFINE FIELD optional_field ON person TYPE option<string> DEFAULT NONE;
DEFINE FIELD author ON post TYPE record<user>;         -- link to another table
DEFINE FIELD author ON post TYPE record<user|bot>;     -- union of allowed tables
```

Field clauses:
- `TYPE <t>` — required type (use `option<T>` for nullable fields).
- `DEFAULT <expr>` — default on CREATE.
- `VALUE <expr>` — computed/overriding value; runs on every write. Combine with `READONLY` to prevent client writes.
- `ASSERT <expr>` — validation; write fails if false. `$value` = new value, `$this` = parent record.
- `READONLY` — no client writes allowed.
- `PERMISSIONS FOR select/create/update ...` — field-level row permissions (see `permissions.md`).

### Array element types

`DEFINE FIELD tags ON person TYPE array<string>` types the whole array. Use `DEFINE FIELD tags.* ON person TYPE string` for elements. For arrays of objects: `DEFINE FIELD items ON cart TYPE array` then `DEFINE FIELD items.*.price ON cart TYPE decimal`.

## DEFINE INDEX

```surql
DEFINE INDEX idx_email ON user FIELDS email UNIQUE;
DEFINE INDEX idx_name ON person COLUMNS name;          -- FIELDS and COLUMNS are aliases
DEFINE INDEX idx_tag ON post FIELDS tags;              -- works on array fields (one entry per value)
DEFINE INDEX idx_composite ON person FIELDS country, age;
DEFINE INDEX idx_loc ON shop FIELDS location MTREE DIMENSION 2 DIST EUCLIDEAN;
DEFINE INDEX idx_emb ON doc FIELDS embedding HNSW DIMENSION 384 DIST COSINE;
DEFINE INDEX idx_search ON post FIELDS body
  SEARCH ANALYZER en_lowercase BM25 HIGHLIGHTS;
```

Index kinds:
- Regular: B-tree, equality + range.
- `UNIQUE`: enforces uniqueness; duplicate writes error.
- `SEARCH ANALYZER ... BM25`: full-text. Pair with `DEFINE ANALYZER`, use `@@` / `search::` in queries.
- `MTREE DIMENSION n DIST ...`: exact vector search (small/medium corpora).
- `HNSW DIMENSION n DIST ...`: approximate vector search (large corpora, faster).

`REBUILD INDEX idx ON tbl` forces a rebuild (after analyzer changes, seed data, etc.).

## DEFINE ANALYZER

Only needed for full-text search.

```surql
DEFINE ANALYZER en_lowercase
  TOKENIZERS blank, class
  FILTERS lowercase, ascii, snowball(english);
```

Tokenizers split text; filters transform tokens. `snowball(en)` enables stemming.

## DEFINE EVENT (triggers)

Run a statement after a write event.

```surql
DEFINE EVENT user_created ON user WHEN $event == "CREATE" THEN (
  CREATE audit_log CONTENT {
    action: "user_created",
    user: $after.id,
    at: time::now(),
  }
);

DEFINE EVENT price_change ON product
  WHEN $event == "UPDATE" AND $before.price != $after.price
THEN (
  CREATE price_history CONTENT {
    product: $after.id,
    from: $before.price,
    to: $after.price,
    at: time::now(),
  }
);
```

Event context: `$event` (`"CREATE"`|`"UPDATE"`|`"DELETE"`), `$before`, `$after`, `$this`, `$value`.

## DEFINE FUNCTION

Reusable server-side functions, invoked as `fn::name(args)`.

```surql
DEFINE FUNCTION fn::greet($name: string) -> string {
  RETURN "Hello, " + $name;
};

DEFINE FUNCTION fn::is_adult($p: record<person>) -> bool {
  RETURN $p.age >= 18;
};

-- call it
SELECT fn::greet(name) FROM person:tobie;
```

Functions can call other `fn::` functions, read from the DB, and have their own `PERMISSIONS`.

## DEFINE PARAM

Database-level constants available in every query as `$NAME`.

```surql
DEFINE PARAM $APP_VERSION VALUE "3.2.1";
DEFINE PARAM $CFG VALUE { feature_x: true, max_items: 100 };
RETURN $APP_VERSION;
```

## DEFINE USER — operators

Creates a user at root, namespace, or database level. For app end-users, use `DEFINE ACCESS` (see `auth.md`); `DEFINE USER` is for you and your teammates.

```surql
DEFINE USER alice ON ROOT      PASSWORD "secret" ROLES OWNER;
DEFINE USER carol ON NAMESPACE PASSWORD "secret" ROLES EDITOR;
DEFINE USER dave  ON DATABASE  PASSWORD "secret" ROLES VIEWER;
DEFINE USER erin  ON DATABASE  PASSHASH "$argon2id$..." ROLES VIEWER;
```

Built-in roles: `OWNER` (full), `EDITOR` (CRUD, no schema), `VIEWER` (read-only). `PASSHASH` accepts a pre-hashed argon2/bcrypt/pbkdf2 password.

## DEFINE SEQUENCE (v3)

Server-side monotonically increasing counters.

```surql
DEFINE SEQUENCE order_no START 1000 BATCH 10;
LET $n := sequence::next("order_no");
CREATE order CONTENT { number: $n, total: 100 };
```

## DEFINE CONFIG (v3)

Database-level configuration.

```surql
DEFINE CONFIG GRAPHQL AUTO;                            -- enable GraphQL at /graphql
DEFINE CONFIG API DEFAULTS;
```

## DEFINE NAMESPACE / DATABASE

```surql
DEFINE NAMESPACE app;
DEFINE DATABASE main;
DEFINE DATABASE IF NOT EXISTS main;
DEFINE DATABASE OVERWRITE main;
```

## REMOVE

Every `DEFINE X` has a matching `REMOVE X`.

```surql
REMOVE TABLE person;
REMOVE FIELD email ON user;
REMOVE INDEX idx_email ON user;
REMOVE USER alice ON ROOT;
REMOVE ACCESS api ON DATABASE;
REMOVE TABLE IF EXISTS person;
```

## Transactions in DDL

Wrap schema migrations in `BEGIN; ... COMMIT;` so they apply atomically:

```surql
BEGIN;
DEFINE TABLE IF NOT EXISTS user SCHEMAFULL;
DEFINE FIELD email ON user TYPE string ASSERT string::is::email($value);
DEFINE INDEX idx_user_email ON user FIELDS email UNIQUE;
COMMIT;
```

If any statement fails, the whole block rolls back.
