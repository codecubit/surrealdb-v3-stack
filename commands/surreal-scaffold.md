---
description: Scaffold a starter SurrealDB v3 schema plus SDK v2 boilerplate for a new project.
---

# /surreal-scaffold

Generate a starter SurrealDB v3 schema and SDK v2 client code for a new project. Output two files the user can drop into their repo.

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
6. **Environment?** Node server, Next.js app, browser SPA, React Native, or script.

If the user said "just give me a starter", pick sensible defaults (`user`, `workspace`, `note`; user-owns-note; record access; TypeScript; Node) and call those out in a header comment.

## Generate `schema.surql`

Structure:

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

## Generate `db.ts` (or `db.js`)

TypeScript version:

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
        auth: process.env.SURREAL_TOKEN ?? {
          username: process.env.SURREAL_USER!,
          password: process.env.SURREAL_PASS!,
        },
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

Rules for the generated client:

- Module-level cached promise (no per-request `new Surreal()`).
- `SURREAL_URL` env var for connection; `ws://` for live queries, `http://` for request/response only.
- Reconnect helper on `EngineDisconnected`.
- Domain types keyed by `RecordId<"table">`.
- If the user chose JWT access, replace the `auth` object with `await db.authenticate(jwt)` after `connect`.
- If React Native / browser, swap `process.env` for `import.meta.env` or similar and point the user at `references/patterns.md`-style patterns.

## Generate a third file if useful

If the user asked for end-user auth, also output:

- `auth.ts` — `signIn(email, password)`, `signUp(email, password, name)`, `signOut()` using `db.signin({ access: "account", variables: { ... } })`. Store token in an env-appropriate place (httpOnly cookie for SSR, `localStorage` for SPA).

Keep it to two files by default; only add the third if the user confirmed end-user auth.

## Deliver

Write the files to the user's working directory (or the outputs folder) and share them. End with a short next-steps block:

```
Next steps:
1. Start SurrealDB locally:
   surreal start --user root --pass root --log info memory

2. Apply the schema:
   surreal import --conn http://127.0.0.1:8000 --user root --pass root --ns app --db main schema.surql

3. Set env vars and run your app:
   SURREAL_URL=ws://127.0.0.1:8000/rpc SURREAL_USER=root SURREAL_PASS=root node .
```

Don't over-explain. The files speak for themselves.
