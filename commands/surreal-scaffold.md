---
description: Scaffold a starter SurrealDB v3 schema plus SDK v2 boilerplate. Two profiles - generic and base.
---

# /surreal-scaffold

Generate a starter SurrealDB v3 schema and SDK v2 client code for a new project. Output two files the user can drop into their repo.

## Profile selection (FIRST step)

The first user argument selects the profile:

- `/surreal-scaffold` (no arg) or `/surreal-scaffold generic` → **generic profile** (any SurrealDB v3 project).
- `/surreal-scaffold base` → **Base profile** (the Base platform repo at `~/Dev/base/web/`).

Profiles only differ in the generated `db.ts` (env var names, imports of `jsonify`/`extractId`, optional Schema Builder stub). The `schema.surql` is identical.

## Gather requirements first

Ask the user (one short question each, or collapse if they already said):

1. **What does the app do?** (e.g. "SaaS with users, workspaces, notes")
2. **Which entities matter?** Give them as `Entity(field1, field2, ...)`, so we can turn them into tables.
3. **Relationships?** Owner-of, member-of, belongs-to, etc.
4. **Auth model?**
   - *record-access* (your app has its own users/passwords) → generates `DEFINE ACCESS ... TYPE RECORD`
   - *JWT* (IdP like Clerk/Auth0) → generates `DEFINE ACCESS ... TYPE JWT`
   - *none* (scripts/internal tool) → skip the auth block
5. **JS or TS?** Default to TS.
6. **Environment?** Node server, Next.js app, browser SPA, React Native, or script. (Skip this question for `base` profile — it is always Next.js + Node.)

If the user said "just give me a starter", pick sensible defaults (`user`, `workspace`, `note`; user-owns-note; record access; TypeScript; Node) and call those out in a header comment.

## Generate `schema.surql`

Structure (identical for both profiles):

```surql
-- schema.surql — SurrealDB v3
-- Apply with:  surreal import --conn http://127.0.0.1:8000 --user root --pass root --ns app --db main schema.surql

BEGIN TRANSACTION;

-- ============================================================
-- Access: record-based end-user auth
-- ============================================================
DEFINE ACCESS account ON DATABASE TYPE RECORD
  SIGNUP (
    CREATE user SET
      email    = $email,
      password = $password,
      name     = $name
  )
  SIGNIN (
    SELECT * FROM user
    WHERE email = $email
      AND crypto::argon2::compare(password, $password)
  )
  DURATION
    FOR TOKEN 15m,
    FOR SESSION 7d;

-- ============================================================
-- Tables
-- ============================================================
DEFINE TABLE user SCHEMAFULL PERMISSIONS
  FOR select, update WHERE id = $auth.id,
  FOR create, delete NONE;

DEFINE FIELD email    ON user TYPE string
  ASSERT string::is::email($value);
DEFINE FIELD name     ON user TYPE string;
DEFINE FIELD password ON user TYPE string
  VALUE IF $value != $before.password
    THEN crypto::argon2::generate($value)
    ELSE $before.password
  END
  PERMISSIONS FOR select NONE;
DEFINE FIELD created_at ON user TYPE datetime VALUE time::now() READONLY;

DEFINE INDEX idx_user_email ON user FIELDS email UNIQUE;

-- [additional tables for the user's entities, each with:]
-- - SCHEMAFULL
-- - PERMISSIONS tied to $auth
-- - fields with TYPE + ASSERT where meaningful
-- - indexes on lookup fields

COMMIT TRANSACTION;
```

Rules for the generated schema:

- Always wrap in `BEGIN TRANSACTION; ... COMMIT TRANSACTION;`.
- Every table `SCHEMAFULL` unless user said otherwise.
- Every user-owned table includes `PERMISSIONS FOR ... WHERE <owner> = $auth.id`.
- `created_at` / `updated_at` use `time::now()` + `READONLY` / `VALUE time::now()`.
- Lookup fields (`email`, `slug`, `handle`) get `DEFINE INDEX ... UNIQUE`.
- Money fields are `decimal`, not `float`.
- For relationships, emit either:
  - `record<target>` fields for one-way references (simple case), or
  - `DEFINE TABLE edge TYPE RELATION IN source OUT target` for graph edges (many-to-many, attributed relationships).
- **Non-optional fields with `DEFAULT`**: always emit a backfill `UPDATE` next to the field (see `references/migrations.md` and `references/base-gates.md`):
  ```surql
  DEFINE FIELD IF NOT EXISTS active ON user TYPE bool DEFAULT false;
  UPDATE user SET active = false WHERE active IS NONE;
  ```

## Generate `db.ts` — generic profile (default)

```typescript
// db.ts — SurrealDB SDK v2 client
import { Surreal, RecordId, EngineDisconnected } from "surrealdb";

let clientPromise: Promise<Surreal> | null = null;

export function getDb(): Promise<Surreal> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const db = new Surreal();
      await db.connect(process.env.SURREAL_URL!, {
        namespace: process.env.SURREAL_NS ?? "app",
        database:  process.env.SURREAL_DB ?? "main",
        authentication: {
          username: process.env.SURREAL_USER!,
          password: process.env.SURREAL_PASS!,
        },
        versionCheck: false,
      });
      return db;
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

// Convenience: run a query, destructure the first result, retry once on disconnect.
export async function q<T>(sql: string, vars?: Record<string, unknown>): Promise<T> {
  try {
    const db = await getDb();
    const [result] = await db.query<[T]>(sql, vars);
    return result;
  } catch (err) {
    if (err instanceof EngineDisconnected) {
      clientPromise = null;
      return q<T>(sql, vars);
    }
    throw err;
  }
}

// Example domain types — replace with your own
export type User = {
  id: RecordId<"user">;
  email: string;
  name: string;
  created_at: Date;
};
```

Rules:

- Module-level cached promise (no per-request `new Surreal()`).
- `SURREAL_URL` env var for connection; `ws://` for live queries, `http://` for request/response only.
- **`authentication:`**, NOT `auth:` — SDK v2 renamed this option. `auth:` silently drops the credentials.
- Reconnect helper on `EngineDisconnected`.
- Domain types keyed by `RecordId<"table">`.
- If JWT access, drop the `authentication` block and call `await db.authenticate(jwt)` AFTER `connect` (see `references/auth.md`).
- Browser / React Native: swap `process.env` for `import.meta.env`.

## Generate `db.ts` — base profile

For `/surreal-scaffold base`, generate `config/db.ts` instead, matching the Base codebase conventions:

```typescript
// config/db.ts — SurrealDB SDK v2 client (Base profile)
import { Surreal } from "surrealdb";
import { jsonify, extractId } from "@/lib/surreal";
import type { Jsonify } from "@/lib/surreal";

let db: Surreal | null = null;
let lastSuccessAt = 0;
const PING_INTERVAL_MS = 30_000;

async function connect(): Promise<Surreal> {
  const instance = new Surreal();
  await instance.connect(process.env.SURREALDB_URL!, {
    namespace: process.env.SURREALDB_NAMESPACE!,
    database:  process.env.SURREALDB_DATABASE!,
    authentication: {
      username: process.env.SURREALDB_USER!,
      password: process.env.SURREALDB_PASS!,
    },
    versionCheck: false,
  });
  lastSuccessAt = Date.now();
  return instance;
}

export async function resetDb(): Promise<void> {
  if (db) {
    try { await db.close(); } catch { /* ignore */ }
  }
  db = null;
}

export async function getDb(): Promise<Surreal> {
  if (db) {
    if (Date.now() - lastSuccessAt < PING_INTERVAL_MS) return db;
    try {
      await db.query("RETURN true");
      lastSuccessAt = Date.now();
      return db;
    } catch {
      try { await db.close(); } catch { /* ignore */ }
      db = null;
    }
  }
  db = await connect();
  return db;
}

// Re-export jsonify/extractId so consumers import them from one place.
export { jsonify, extractId };
export type { Jsonify };
```

Rules for the Base profile:

- **Env vars are `SURREALDB_*`** (NS, DB, URL, USER, PASS) — NOT `SURREAL_*`. The Base repo uses this naming everywhere; using the wrong prefix yields silent connection failures.
- `jsonify` / `extractId` / `Jsonify<T>` are re-exported from `@/lib/surreal`, the project's tipped wrapper around the upstream `surrealdb` package. Never import them directly from `surrealdb`.
- 30-second ping interval matches the live codebase pattern.
- `resetDb()` is needed after destructive ops (DB restore, snapshot apply).

If the user already has a `config/db.ts`, do **not** overwrite it — diff against theirs and propose minimal changes only.

## Optional: scaffold a `config/schema.ts` stub (base profile only)

If the user is starting a new module, also offer to generate a Schema Builder stub:

```typescript
// config/schema.ts (or modules/<id>/schema.ts) — Base Schema Builder stub
export const SCHEMA_VERSION = 1;

export const CORE_SCHEMA = [
  // Add SCHEMAFULL tables here. mod_* tables go in modules/<id>/manifest.ts → install().
];

export const MIGRATIONS = [
  // {
  //   version: 1,
  //   description: "Initial schema",
  //   up: `DEFINE TABLE example SCHEMAFULL; DEFINE FIELD name ON example TYPE string;`,
  // },
];
```

Direct the user to `references/schema-builder.md` and `references/base-gates.md` for the full pipeline rules.

## Generate a third file if useful

If the user asked for end-user auth, also output:

- `auth.ts` — `signIn(email, password)`, `signUp(email, password, name)`, `signOut()` using `db.signin({ access: "account", variables: { ... } })`. Store token in an env-appropriate place (httpOnly cookie for SSR, `localStorage` for SPA).

Keep it to two files by default; only add the third if the user confirmed end-user auth.

## Deliver

Write the files to the user's working directory (or the outputs folder) and share them. End with a short next-steps block tailored to the profile.

**Generic profile next steps:**

```
1. Start SurrealDB locally:
   surreal start --user root --pass root --log info memory

2. Apply the schema:
   surreal import --conn http://127.0.0.1:8000 --user root --pass root --ns app --db main schema.surql

3. Set env vars and run your app:
   SURREAL_URL=ws://127.0.0.1:8000/rpc SURREAL_USER=root SURREAL_PASS=root node .
```

**Base profile next steps:**

```
1. Make sure the SurrealDB CT is reachable (10.10.10.10 or local docker).
2. Add the env vars to .env.local:
   SURREALDB_URL=http://127.0.0.1:8000
   SURREALDB_NAMESPACE=base
   SURREALDB_DATABASE=base
   SURREALDB_USER=root
   SURREALDB_PASS=root
3. Apply the schema via the Schema Builder (auto-applies on first dev request).
4. Run `npm run check:schema-backfill` and `check:schema-module-purity` before committing.
```

Don't over-explain. The files speak for themselves.
