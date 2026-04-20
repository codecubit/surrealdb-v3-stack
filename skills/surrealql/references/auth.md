# Authentication — `DEFINE ACCESS`

v3 uses `DEFINE ACCESS` as the single primitive for all authentication configurations. v1's `DEFINE SCOPE` is gone; v2's `DEFINE ACCESS TYPE RECORD` is the migration target.

## The three access types

| Type     | Purpose                                                                  |
| -------- | ------------------------------------------------------------------------ |
| `JWT`    | Verify tokens from an external IdP (Auth0, Clerk, your own).             |
| `RECORD` | Your app's end users. Signup/signin run against a records table.         |
| `BEARER` | Long-lived API tokens ("keys") for machine-to-machine access.            |

Independent; you can define multiple on the same database.

## Record access — end-user auth

```surql
DEFINE ACCESS account ON DATABASE TYPE RECORD
  SIGNUP (
    CREATE user SET
      email = $email,
      password = $password,                  -- hashed via DEFINE FIELD VALUE
      name = $name
  )
  SIGNIN (
    SELECT * FROM user
    WHERE email = $email
      AND crypto::argon2::compare(password, $password)
  )
  DURATION
    FOR TOKEN 15m,                           -- JWT lifetime (keep short)
    FOR SESSION 7d;                          -- refresh session lifetime
```

Companion table with hashed passwords so plaintext never lands in storage:

```surql
DEFINE TABLE user SCHEMAFULL PERMISSIONS
  FOR select, update WHERE id = $auth.id,
  FOR create, delete NONE;

DEFINE FIELD email ON user TYPE string
  ASSERT string::is::email($value);

DEFINE FIELD password ON user TYPE string
  VALUE crypto::argon2::generate($value)     -- hash on write
  PERMISSIONS FOR select NONE;               -- never readable

DEFINE FIELD name ON user TYPE string;

DEFINE INDEX idx_user_email ON user FIELDS email UNIQUE;
```

The JWT issued on signin/signup has its `id` claim set to the record ID of the authenticated record (e.g. `user:01HG...`). In subsequent queries, `$auth` resolves to that record.

### Password re-hashing trap

The `VALUE crypto::argon2::generate($value)` clause runs on **every write**, including updates that don't touch `password`. That re-hashes the (already-hashed) password, invalidating signin. Guard against it:

```surql
DEFINE FIELD password ON user TYPE string
  VALUE IF $value != $before.password
    THEN crypto::argon2::generate($value)
    ELSE $before.password
  END;
```

Or keep credentials on a separate `auth_credential` table and update only on password change.

## JWT access — verify external tokens

```surql
-- symmetric (HMAC)
DEFINE ACCESS api ON DATABASE TYPE JWT
  ALGORITHM HS512 KEY "your-shared-secret"
  DURATION FOR SESSION 1d;

-- asymmetric (RSA/ECDSA)
DEFINE ACCESS api ON DATABASE TYPE JWT
  ALGORITHM RS256
  KEY "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
  DURATION FOR SESSION 1d;

-- JWKS endpoint (recommended for production with a hosted IdP)
DEFINE ACCESS api ON DATABASE TYPE JWT
  URL "https://example.auth0.com/.well-known/jwks.json"
  DURATION FOR SESSION 1d;
```

Supported algorithms: `HS256/384/512`, `RS256/384/512`, `ES256/384/512`, `PS256/384/512`, `EdDSA`.

### Mapping external tokens to your users

Use `AUTHENTICATE` to map incoming token claims to records in your DB:

```surql
DEFINE ACCESS api ON DATABASE TYPE JWT
  URL "https://example.auth0.com/.well-known/jwks.json"
  AUTHENTICATE (
    UPSERT user:[$token.sub] SET
      email = $token.email,
      name = $token.name
    RETURN AFTER
  )
  DURATION FOR SESSION 1d;
```

`$token` holds the verified JWT claims. The value returned by `AUTHENTICATE` becomes `$auth` for the session.

## Bearer access — API keys

For machine-to-machine or personal access tokens. Each grant is tied to a user or a record.

```surql
-- DB users mint bearer tokens
DEFINE ACCESS api_keys ON DATABASE TYPE BEARER FOR USER
  DURATION FOR GRANT 90d;

-- Or tied to record-access users
DEFINE ACCESS api_keys ON DATABASE TYPE BEARER FOR RECORD
  DURATION FOR GRANT 90d;
```

Create a grant:

```surql
ACCESS api_keys GRANT FOR USER alice;
-- response includes { key: "sst-…", id: ..., expiry: ... }
```

Revoke:

```surql
ACCESS api_keys REVOKE GRANT <id>;
```

Client uses `key` as a bearer token (in the SDK: `await db.authenticate("sst-...")`).

## `$auth`, `$session`, `$token`

- `$auth` — the authenticated record (record access) or `AUTHENTICATE`-returned value (JWT access). Use this in permissions (`WHERE author = $auth.id`).
- `$session` — `{ id, ns, db, ac, rd, ... }` describing the current session.
- `$token` — the raw claims of the current JWT (for `AUTHENTICATE` expressions and for inspection).

## Session vs token duration

- `FOR TOKEN` — JWT validity. Keep short (15m–1h) for record access so leaked tokens expire fast.
- `FOR SESSION` — how long the SDK can refresh without re-signin. The UX "stay logged in" duration.
- `FOR GRANT` — how long a bearer grant lives.

## Migrating from v1 `DEFINE SCOPE`

Before (v1):

```surql
DEFINE SCOPE account SESSION 24h
  SIGNUP ( CREATE user SET ... )
  SIGNIN ( SELECT * FROM user WHERE ... );
```

After (v3):

```surql
DEFINE ACCESS account ON DATABASE TYPE RECORD
  SIGNUP ( CREATE user SET ... )
  SIGNIN ( SELECT * FROM user WHERE ... )
  DURATION FOR SESSION 24h;
```

SDK side (covered in the `surrealdb-js` skill): `scope: "account"` → `access: "account"`.
