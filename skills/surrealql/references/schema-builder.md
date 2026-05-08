# Schema Builder — 3-layer pipeline

This project uses a custom Schema Builder in `config/schema.ts`. It is the single source of truth for all SurrealDB schema definitions. **Read this before touching any schema code.**

## Architecture

```
config/schema.ts
  ├── CORE_SCHEMA: TableSchema[]       ← Layer 1: declarative definitions
  ├── generateSchemaSQL()              ← Emits DEFINE TABLE/FIELD/INDEX
  ├── generateSubFieldSQL()            ← Emits array sub-field OVERWRITEs
  ├── MIGRATIONS: MigrationStep[]      ← Layer 2: versioned transforms
  └── SCHEMA_VERSION: number           ← Current version counter

config/db.ts (auto-apply on dev connect)
  1. db.query(generateSchemaSQL())       ← IF NOT EXISTS — additive
  2. db.query(generateSubFieldSQL())     ← OVERWRITE — separate call (CRITICAL)
  3. Apply MIGRATIONS where version > current
  4. Update schema_version:current
```

## Layer 1: CORE_SCHEMA

Declarative table/field/index definitions. Runs on every dev restart with `IF NOT EXISTS` — additive, never destructive.

```typescript
export const CORE_SCHEMA: TableSchema[] = [
  {
    name: "user",
    mode: "SCHEMAFULL",
    fields: [
      { name: "email", type: "string" },
      { name: "name", type: "option<string>" },
      { name: "role", type: "string", default: "'user'" },
      { name: "balance", type: "number", default: "0" },
      { name: "tags", type: "option<array<string>>", default: "[]" },
      { name: "tags[*]", type: "string" },  // ← sub-field, handled separately
    ],
    indexes: [
      { name: "idx_user_email", fields: "email", unique: true },
    ],
  },
];
```

### Types

```typescript
interface TableSchema {
  name: string;
  mode: "SCHEMAFULL" | "SCHEMALESS";
  fields: FieldDef[];
  indexes: IndexDef[];
}

interface FieldDef {
  name: string;    // supports nested: "address.city", "tags[*]", "steps.*"
  type: string;    // SurrealQL type
  default?: string; // SurrealQL expression
}

interface IndexDef {
  name: string;
  fields: string;  // SurrealQL fields clause
  unique?: boolean;
}
```

### SQL generation rules

`generateSchemaSQL()`:
- Emits `DEFINE TABLE OVERWRITE <name> <mode>` for every table.
- Emits `DEFINE FIELD IF NOT EXISTS` for every field — **except** array sub-fields.
- SCHEMALESS tables skip field definitions entirely (only indexes are emitted).
- SCHEMALESS tables additionally remove leftover field defs from previous SCHEMAFULL runs.

`generateSubFieldSQL()`:
- Emits `DEFINE FIELD OVERWRITE` for array sub-fields (`tags[*]`, `steps.*`).
- **MUST run in a separate `db.query()` call** — SurrealDB v3 silently drops sub-field definitions if they run in the same batch as `DEFINE TABLE OVERWRITE`.

## Layer 2: MIGRATIONS

One-shot versioned transforms. Each runs once when `version > current schema_version`.

```typescript
export const SCHEMA_VERSION = 68;

export const MIGRATIONS: MigrationStep[] = [
  {
    version: 1,
    description: "Initial schema",
    up: `
      DEFINE TABLE IF NOT EXISTS user SCHEMAFULL;
      DEFINE FIELD email ON user TYPE string;
    `,
  },
  {
    version: 65,
    description: "Backfill user.balance for legacy rows",
    up: `
      DEFINE FIELD IF NOT EXISTS balance ON user TYPE number DEFAULT 0;
      UPDATE user SET balance = 0 WHERE balance IS NONE;
    `,
  },
];
```

### Migration rules

1. **Never edit an already-applied migration.** Always create version N+1.
2. **Non-optional field added → MUST backfill.** `DEFAULT` only fires on `CREATE`.
3. **Never reference `mod_*` tables in core migrations.** Module schema goes in `modules/<id>/manifest.ts` → `install()` / `migrate()`.
4. **Wrap related changes** in the same migration version.
5. **Run `npm run check:schema-backfill`** after editing. The pre-commit gate rejects missing backfills.
6. **Run `npm run check:schema-module-purity`** after editing. The gate rejects `mod_*` references.

## Incidents this pipeline prevents

Three production breakages drove the current shape of the pipeline. Each one is now caught by a pre-commit gate (see `references/base-gates.md`). Memorize the symptom — when you see it during a review, trace it back here.

### v56 — ghost SCHEMALESS table (`mod_ai_chat_message.status`)

**What happened.** A core migration ran `DEFINE FIELD status ON mod_ai_chat_message TYPE string`. The table did not yet exist. SurrealDB v3 auto-creates the table as `SCHEMALESS` to host the field, leaving a permanent ghost. When the AI Chat module's `install()` later ran `DEFINE TABLE mod_ai_chat_message SCHEMAFULL` + `DEFINE FIELD ... FLEXIBLE`, SurrealDB rejected with `FLEXIBLE can only be used in SCHEMAFULL tables` because the existing SCHEMALESS table blocked the upgrade.

**Root cause.** Core migrations referenced a module-owned table.

**Gate that now blocks it.** `npm run check:schema-module-purity` — rejects any `MIGRATIONS` entry that names a `mod_*` table.

**Correct pattern.** Module schema lives in `modules/<id>/manifest.ts`:

```typescript
// ✅ Right
export const manifest = {
  async install({ db }) {
    await db.query(`
      DEFINE TABLE IF NOT EXISTS mod_ai_chat_message SCHEMAFULL;
      DEFINE FIELD IF NOT EXISTS status ON mod_ai_chat_message TYPE string DEFAULT 'pending';
      UPDATE mod_ai_chat_message SET status = 'pending' WHERE status IS NONE;
    `);
  },
};
```

### v64 / v65 — `user.balance` read-time coerce error

**What happened.** Migration v64 added `DEFINE FIELD balance ON user TYPE number DEFAULT 0` without a backfill `UPDATE`. `DEFAULT` only fires on CREATE — existing user rows kept `balance IS NONE`. Every subsequent `SELECT * FROM user` failed with `Found NONE for field balance, with record user:abc, but expected a number` — even queries that did not touch `balance` blew up because v3 SCHEMAFULL coerces every field on read. Production users couldn't sign in for ~6 hours.

**Root cause.** Non-optional field with `DEFAULT` but no backfill for legacy rows.

**Gate that now blocks it.** `npm run check:schema-backfill` — parses every `DEFINE FIELD ... TYPE <non-optional> DEFAULT <X>` in `MIGRATIONS` and requires a matching `UPDATE <table> SET <field> = <X> WHERE <field> IS NONE` (or equivalent guarded `LET/IF/FOR` loop, or a later `REMOVE FIELD`, or the table being created in the same migration).

**Correct pattern.**

```typescript
{
  version: 65,
  description: "Add user.balance with backfill",
  up: `
    DEFINE FIELD IF NOT EXISTS balance ON user TYPE number DEFAULT 0;
    UPDATE user SET balance = 0 WHERE balance IS NONE;
  `,
}
```

### v70 / v73 — `user.active` (same class as v64)

**What happened.** Same pattern as v64 — non-optional `bool` with `DEFAULT false`, no backfill — surfaced again in a different field. The gate caught it pre-commit before it shipped.

**Lesson.** The gate is not theoretical. It catches real, recurring mistakes. If the gate complains, do **not** silence with `// eslint-disable` (Biome has no such directive anyway) or `--no-verify`. Add the backfill.

## The SCHEMALESS barrier

CORE_SCHEMA tables with `mode: "SCHEMALESS"` are only allowed for `mastra_*` tables. The SQL generator skips field definitions for them — only indexes are emitted. This prevents SurrealDB from enforcing types on fields that the Mastra SDK controls.

## Auto-healing

On every dev restart, `config/db.ts`:
1. Re-applies `generateSchemaSQL()` — `IF NOT EXISTS` means it only adds missing definitions.
2. Re-applies `generateSubFieldSQL()` — `OVERWRITE` ensures sub-fields match the code.
3. Skips already-applied migrations (version check).

This means: if a field definition drifts in the database (manual edit, failed migration), the next dev restart repairs it automatically. The schema code is always authoritative.

## How to add a field to an existing table

```typescript
// 1. Add to CORE_SCHEMA in the table's fields array:
{ name: "active", type: "bool", default: "true" },

// 2. Create a new migration (bump SCHEMA_VERSION):
export const SCHEMA_VERSION = 69; // was 68

// 3. Add the migration with backfill:
{
  version: 69,
  description: "Add user.active with backfill",
  up: `
    DEFINE FIELD IF NOT EXISTS active ON user TYPE bool DEFAULT true;
    UPDATE user SET active = true WHERE active IS NONE;
  `,
},
```

## Key files

| File | Role |
|------|------|
| `config/schema.ts` | CORE_SCHEMA + MIGRATIONS + generators |
| `config/db.ts` | Connection singleton + auto-apply pipeline |
| `config/seed.ts` | Fresh DB setup (`npm run seed`) |
| `lib/surreal.ts` | `extractId()` + `jsonify()` |
| `scripts/check-schema-backfill.mjs` | Pre-commit gate for missing backfills |
| `scripts/check-schema-module-purity.mjs` | Pre-commit gate for mod_* references |
