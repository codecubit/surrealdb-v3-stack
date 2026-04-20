# Migrations — safe schema evolution in SurrealDB v3

How to evolve a SCHEMAFULL schema in production without breaking reads or losing data.

## The core problem

SurrealDB v3 SCHEMAFULL is strict:
- Adding a non-optional field with `DEFAULT` only applies on `CREATE` — existing rows keep `NONE`.
- Reading a row with `NONE` in a non-optional field throws a coerce error.
- This breaks **every query on the table**, not just the new field.

This has caused more production outages than any other SurrealDB behavior.

## The golden rule

**Every new non-optional field needs a backfill.**

```surql
-- Step 1: define the field
DEFINE FIELD IF NOT EXISTS balance ON user TYPE number DEFAULT 0;

-- Step 2: backfill existing rows (MANDATORY)
UPDATE user SET balance = 0 WHERE balance IS NONE;
```

Never skip step 2. `DEFAULT` alone is not enough.

## Safe patterns for every operation

### Add an optional field (safe, no backfill needed)

```surql
DEFINE FIELD IF NOT EXISTS avatar ON user TYPE option<string>;
-- option<T> accepts NONE — existing rows are fine
```

### Add a non-optional field (requires backfill)

```surql
BEGIN;
DEFINE FIELD IF NOT EXISTS active ON user TYPE bool DEFAULT true;
UPDATE user SET active = true WHERE active IS NONE;
COMMIT;
```

### Rename a field

SurrealDB has no `RENAME FIELD`. Copy + remove:

```surql
BEGIN;
-- 1. Create new field
DEFINE FIELD IF NOT EXISTS display_name ON user TYPE string DEFAULT '';

-- 2. Copy data
UPDATE user SET display_name = name WHERE display_name IS NONE OR display_name = '';

-- 3. Remove old field
REMOVE FIELD IF EXISTS name ON user;
COMMIT;
```

### Change a field's type

```surql
BEGIN;
-- 1. Remove old definition
REMOVE FIELD IF EXISTS status ON order;

-- 2. Define with new type
DEFINE FIELD status ON order TYPE string DEFAULT 'pending'
  ASSERT $value IN ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

-- 3. Backfill: convert old int values to string
UPDATE order SET status = IF status == 0 THEN 'pending'
  ELSE IF status == 1 THEN 'paid'
  ELSE IF status == 2 THEN 'shipped'
  ELSE 'pending' END
WHERE type::is::int(status);
COMMIT;
```

### Remove a field

```surql
-- Safe: just remove the definition
REMOVE FIELD IF EXISTS deprecated_field ON user;

-- Data remains in existing rows but is ignored by SCHEMAFULL.
-- To clean up storage:
UPDATE user UNSET deprecated_field;
```

### Add an index

```surql
-- Safe: non-blocking in v3
DEFINE INDEX IF NOT EXISTS idx_user_email ON user FIELDS email UNIQUE;

-- Rebuild if needed (after data import, analyzer change)
REBUILD INDEX idx_user_email ON user;
```

### Remove an index

```surql
REMOVE INDEX IF EXISTS idx_old ON user;
```

### Add a table

```surql
BEGIN;
DEFINE TABLE IF NOT EXISTS invoice SCHEMAFULL;
DEFINE FIELD number ON invoice TYPE int;
DEFINE FIELD total ON invoice TYPE decimal DEFAULT 0dec;
DEFINE FIELD userId ON invoice TYPE record<user>;
DEFINE FIELD createdAt ON invoice TYPE datetime VALUE time::now() READONLY;
DEFINE INDEX idx_invoice_user ON invoice FIELDS userId;
COMMIT;
```

### Remove a table

```surql
-- This drops all data!
REMOVE TABLE IF EXISTS deprecated_table;
```

## Migration versioning pattern

For production apps, use a version-gated migration system:

```surql
-- Store current version in a singleton record
DEFINE TABLE IF NOT EXISTS app_setting SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS payload ON app_setting TYPE option<object> FLEXIBLE;

-- Check version before applying
LET $current = (SELECT VALUE payload.schema_version FROM ONLY app_setting:schema) ?? 0;

-- Migration v1
IF $current < 1 THEN {
  DEFINE TABLE IF NOT EXISTS user SCHEMAFULL;
  DEFINE FIELD email ON user TYPE string;
  DEFINE FIELD name ON user TYPE string;
  DEFINE INDEX idx_user_email ON user FIELDS email UNIQUE;
  UPDATE app_setting:schema SET payload.schema_version = 1;
};

-- Migration v2
IF $current < 2 THEN {
  DEFINE FIELD IF NOT EXISTS active ON user TYPE bool DEFAULT true;
  UPDATE user SET active = true WHERE active IS NONE;
  UPDATE app_setting:schema SET payload.schema_version = 2;
};
```

### Versioning traps

1. **Never edit an already-applied migration.** If v5 already ran, adding more SQL to v5 won't execute — the version check skips it. Always create v6.

2. **Always use `IF NOT EXISTS` in definitions.** Migrations may re-run on dev restart. Idempotency prevents errors.

3. **Wrap related changes in `BEGIN/COMMIT`.** If a migration fails halfway, you get a half-applied schema.

4. **Test migrations on a copy first.** Export with `surreal export`, apply to a fresh DB, verify.

## The OVERWRITE trap

`DEFINE TABLE OVERWRITE` replaces the table definition but **does NOT remove child definitions** (fields, indexes, events):

```surql
-- Does NOT clean up old fields!
DEFINE TABLE OVERWRITE user SCHEMAFULL;
-- Old DEFINE FIELD entries from the previous definition survive

-- To truly reset a table:
REMOVE TABLE IF EXISTS user;
DEFINE TABLE user SCHEMAFULL;
DEFINE FIELD email ON user TYPE string;
-- ... all fields from scratch
```

## The ghost table trap

`DEFINE FIELD` on a non-existent table silently creates it as SCHEMALESS:

```surql
-- If 'product' doesn't exist yet, this creates it as SCHEMALESS
DEFINE FIELD name ON product TYPE string;

-- Later, this fails:
DEFINE TABLE product SCHEMAFULL;  -- ERROR: conflicts with existing SCHEMALESS

-- Prevention: always define the table first
DEFINE TABLE IF NOT EXISTS product SCHEMAFULL;
DEFINE FIELD name ON product TYPE string;
```

## Pre-flight checklist

Before applying a migration to production:

- [ ] Every new non-optional field has a backfill `UPDATE ... WHERE ... IS NONE`
- [ ] Version number is incremented (not editing an existing migration)
- [ ] All `DEFINE` statements use `IF NOT EXISTS` (idempotent)
- [ ] Related changes are wrapped in `BEGIN/COMMIT`
- [ ] No `DEFINE FIELD` without a prior `DEFINE TABLE` for that table
- [ ] No `OVERWRITE` expecting it to clean up child definitions
- [ ] Tested on a copy of production data (export → fresh DB → apply → verify)
