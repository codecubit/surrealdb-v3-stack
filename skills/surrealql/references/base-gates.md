# Base — pre-commit gates

Four gates run automatically on `git commit` (via Husky + lint-staged) and again in Forgejo CI on push to `production`. Each one rejects a specific class of bug that has shipped to production at least once. **Bypassing with `--no-verify` is forbidden.** If a gate fails, the gate is right — fix the cause.

The full incident playbook lives in [`CONTRIBUTING.md`](../../../../CONTRIBUTING.md) ("The 5 hard gates" section). This file is the SurrealQL-relevant subset.

## Gate 1 — `npm run check:catalog`

**Rejects:** a module missing from either `modules/catalog.ts` or `modules/registry.server.ts`.

**Why this exists.** Phase 9 introduced codegen: `scripts/codegen-modules.mjs` regenerates `catalog.ts`, `registry.{server,edge,client}.ts`, `icons.ts`, and the `mod.*` slice of `config/rbac.ts` from `modules/<id>/manifest.ts` on every commit. The gate is a **safety net** in case the codegen hook is bypassed or breaks.

**SurrealQL angle.** None directly — but if you create a new module that owns DB tables, the manifest is the only place you should declare them. Editing `catalog.ts` by hand is a leak.

## Gate 2 — `npm run check:manifests`

**Rejects:** any `modules/<id>/manifest.ts` with a top-level `import` from `@/config/*`, `@/lib/*`, or `@/app/*`.

**Why this exists.** Manifests are evaluated in every runtime (server, worker, edge, client). Importing server-only code from a manifest drags React, CSS, and browser-only libs into the worker bundle and breaks boot.

**SurrealQL angle.** Only at install/migrate time:

```typescript
// ❌ Wrong — top-level import drags @/config/db into worker bundle
import { getDb } from "@/config/db";
export const manifest = {
  async install({ db }) {
    await db.query("...");
  },
};

// ✅ Right — `db` arrives via DI from the install context.
//   If you genuinely need a config helper, lazy-import inside the function.
export const manifest = {
  async install({ db }) {
    const { getPlatformCurrency } = await import("@/config/platform");
    await db.query("...");
  },
};
```

## Gate 3 — `npm run check:schema-backfill`

**The most important gate for SurrealQL authors.** Rejects a migration in `config/schema.ts` that adds a **non-optional** field with a `DEFAULT` but no backfill `UPDATE`.

**Why this exists.** SurrealDB v3 SCHEMAFULL rejects `NONE` on non-optional fields **at read time**, breaking every unrelated query on the row. `DEFAULT` only fires on `CREATE` — it does not populate existing rows.

**Incident precedent:**
- v64/v65 (`user.balance`) → 6-hour production outage. Every `SELECT * FROM user` failed, including auth queries.
- v70/v73 (`user.active`) → caught pre-commit by this gate.

**Pattern when adding a non-optional field.** ALWAYS pair the `DEFINE FIELD` with an idempotent backfill in the same migration:

```sql
DEFINE FIELD IF NOT EXISTS <field> ON <table> TYPE <T> DEFAULT <value>;
UPDATE <table> SET <field> = <value> WHERE <field> IS NONE;
```

**Equivalent forms accepted by the gate:**
- `UPDATE <table> SET <field> = <value> WHERE <field> IS NONE;` (canonical).
- A guarded `LET / IF / FOR` loop performing the same effect (v57-style).
- A later `REMOVE FIELD` retiring the field.
- The table being **created** in the same migration (no legacy rows to backfill).

**Optional fields are exempt.** `option<T>` accepts `NONE` natively, so `DEFAULT` is the only thing needed.

```sql
-- ✅ Optional — no backfill required
DEFINE FIELD avatar ON user TYPE option<string>;
```

**Run locally:** `npm run check:schema-backfill`.

## Gate 4 — `npm run check:schema-module-purity`

**Rejects:** any core migration (`config/schema.ts` → `MIGRATIONS`) that references a `mod_*` table.

**Why this exists.** SurrealDB v3 auto-creates a table as `SCHEMALESS` when a `DEFINE FIELD` runs against a non-existent table, leaving a permanent ghost that blocks the module's later `install()` with `FLEXIBLE can only be used in SCHEMAFULL tables`.

**Incident precedent:**
- v56 (`mod_ai_chat_message.status`) — module install was permanently broken until the ghost table was manually dropped in production.
- v13/v35/v36/v37 (`mod_blog_post`) — same class of bug, repeated four times in early days.

**Rule.** If schema logic touches a module-owned table (`mod_*`), it **must** live in `modules/<id>/manifest.ts` → `install()` / `migrate()`. Never in the core `MIGRATIONS` list.

```typescript
// ❌ Wrong — gate rejects this
// config/schema.ts MIGRATIONS:
{
  version: 56,
  up: `DEFINE FIELD status ON mod_ai_chat_message TYPE string;`,
}

// ✅ Right — module-owned schema in module's install()
// modules/ai-chat/manifest.ts:
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

**SCHEMALESS exception.** Only `mastra_*` tables are allowed to be SCHEMALESS by design (controlled by the Mastra SDK — see `references/mastra.md`). The gate does not apply to them because they are also defined in CORE_SCHEMA, not in MIGRATIONS.

**Run locally:** `npm run check:schema-module-purity`.

## Combined workflow

When adding or evolving a SurrealDB schema in Base, the loop is:

1. Decide where the table lives:
   - Platform-shared, used across modules → `config/schema.ts` CORE_SCHEMA + MIGRATIONS.
   - Module-owned (`mod_*` prefix) → `modules/<id>/manifest.ts` → `install()`.
2. Bump `SCHEMA_VERSION` (core) or the module's own version counter.
3. Add the migration with backfill paired immediately below the `DEFINE FIELD`.
4. Save. Husky runs the four gates on `git commit`.
5. If any gate fails, read the message — it names the file and line. Fix the cause. **Never** `--no-verify`.
6. Forgejo CI re-runs the same four gates on push to `production`. Bypassing locally just delays the rejection.

## Cheat sheet — the five most common rejections

| Symptom | Gate | Fix |
|---|---|---|
| `missing backfill for <field>` | `check:schema-backfill` | Add `UPDATE <table> SET <field> = <value> WHERE <field> IS NONE;` |
| `mod_* table referenced in core MIGRATIONS` | `check:schema-module-purity` | Move the `DEFINE` into `modules/<id>/manifest.ts` → `install()` |
| `module not in catalog.ts` | `check:catalog` | Run `npm run codegen:apply` and commit the regenerated files |
| `manifest imports @/config/db` | `check:manifests` | Switch to a lazy `await import(...)` inside the function body, OR receive the dependency via the DI context |
| `FLEXIBLE only SCHEMAFULL` at runtime | (no pre-commit gate — runtime) | A ghost SCHEMALESS table from a previous v56-style violation is blocking install. Manually `REMOVE TABLE` in the affected env, then re-run module install |

## Why none of this is theoretical

Every gate maps to a real incident with a recorded date and a recorded outage. The incidents stopped after the gates landed. When the gate complains, the cost of the rejection is seconds; the cost of a v64-style production breakage was hours of downtime + manual row repair + customer churn. Trust the gates.
