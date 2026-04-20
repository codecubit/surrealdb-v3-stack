# Row-level permissions

Permissions attach to a `DEFINE TABLE` or `DEFINE FIELD` and are SurrealQL expressions evaluated per row (for tables) or per field (for fields). The special parameter `$auth` is the currently authenticated record when the client signed in via `DEFINE ACCESS RECORD`.

## Table permissions

```surql
DEFINE TABLE post PERMISSIONS
  FOR select WHERE published = true OR author = $auth.id,
  FOR create WHERE $auth.id != NONE,
  FOR update WHERE author = $auth.id,
  FOR delete WHERE author = $auth.id OR $auth.role = "admin";

-- shortcuts
DEFINE TABLE audit_log PERMISSIONS NONE;                   -- blocked entirely
DEFINE TABLE public_stats PERMISSIONS FULL;                -- fully open (bypass)
```

`FOR select` controls reads. `FOR create`/`update`/`delete` control writes. Combine on one table or split:

```surql
DEFINE TABLE user PERMISSIONS
  FOR select WHERE id = $auth.id,           -- see only yourself
  FOR update WHERE id = $auth.id,           -- update only yourself
  FOR create, delete NONE;                  -- no direct create/delete
```

## Field permissions

Field permissions override table permissions for that field.

```surql
DEFINE FIELD password ON user TYPE string
  PERMISSIONS FOR select NONE;              -- never readable via SELECT

DEFINE FIELD internal_notes ON user TYPE string
  PERMISSIONS FOR select WHERE $auth.role == "admin";

DEFINE FIELD email ON user TYPE string
  PERMISSIONS FOR update WHERE id = $auth.id;  -- only owner can change
```

## What `$auth` looks like

- For **record access** users (`DEFINE ACCESS ... TYPE RECORD`), `$auth` is the authenticated record (e.g. `user:01HG...`). `$auth.id` is the record ID, and any field on the record (name, role, tenant) is accessible.
- For **JWT access** (`DEFINE ACCESS ... TYPE JWT`), `$auth` is whatever the `AUTHENTICATE` clause returns (typically a record), or the token's `id` claim resolved to a record.
- For **operator users** (`DEFINE USER ... ON ROOT/NS/DB`), `$auth.id` is `NONE` and permissions are **bypassed entirely** — operators can see and do everything within their scope.

Design permissions assuming `$auth` is a record; operators bypass so you don't have to special-case them.

## Common patterns

**User owns row:**

```surql
DEFINE TABLE post PERMISSIONS
  FOR select, update, delete WHERE author = $auth.id,
  FOR create WHERE author = $auth.id OR $auth.id != NONE;

DEFINE FIELD author ON post TYPE record<user>
  VALUE $before.author OR $auth.id          -- stamp on CREATE, preserve on UPDATE
  READONLY;
```

**Public read, owner write:**

```surql
DEFINE TABLE post PERMISSIONS
  FOR select WHERE published = true OR author = $auth.id,
  FOR create WHERE $auth.id != NONE,
  FOR update, delete WHERE author = $auth.id;
```

**Tenant isolation:**

```surql
DEFINE FIELD tenant ON user TYPE record<tenant>;

DEFINE TABLE post PERMISSIONS
  FOR select, create, update, delete WHERE tenant = $auth.tenant;

DEFINE FIELD tenant ON post TYPE record<tenant>
  VALUE $before.tenant OR $auth.tenant
  READONLY;
```

**Role-based:**

```surql
DEFINE FIELD role ON user TYPE string ASSERT $value IN ["user", "editor", "admin"];

DEFINE TABLE post PERMISSIONS
  FOR select WHERE published = true OR author = $auth.id,
  FOR create WHERE $auth.role IN ["user", "editor", "admin"],
  FOR update WHERE author = $auth.id OR $auth.role IN ["editor", "admin"],
  FOR delete WHERE author = $auth.id OR $auth.role = "admin";
```

**Graph-aware permissions** — "users can read posts by people they follow":

```surql
DEFINE TABLE post PERMISSIONS
  FOR select WHERE
    published = true
    OR author = $auth.id
    OR author IN $auth.->follows->person;
```

## Performance caveats

Permissions run on every row. Expensive expressions (graph traversals, sub-selects against large tables) multiply per-row. Rules of thumb:

- Keep boolean logic flat when possible.
- Prefer indexed fields in the permission predicate (author, tenant, published).
- If a permission requires joining, consider materializing the needed field onto the record (e.g. denormalize `is_public` onto `post`).
- Test with `EXPLAIN FULL` to confirm the query still uses an index once the permission predicate is added.

## Turning off permissions for writes-from-the-backend

Backend code often runs as a root or database user, which bypasses permissions. That's the intended pattern: front-end clients authenticate via record access (permissions enforced), backend services sign in as operators (permissions bypassed). Don't try to disable permissions with `FULL` — sign in as an operator instead.

## Interaction with `DEFINE EVENT` and `DEFINE FIELD VALUE`

Events and `VALUE` expressions on fields run **server-side with elevated privileges** — they see everything, even what the signed-in user can't. That's how triggers work. Don't put sensitive logic in `VALUE` thinking permissions will limit it; they won't.
