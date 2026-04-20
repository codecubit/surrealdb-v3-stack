# SDK patterns

Common patterns for real apps — connection lifecycle, auth flows, live query reconnect, testing.

## Connection lifecycle — one client per process

Creating a `Surreal` per request adds CBOR + WebSocket handshake latency and can exhaust server connection limits. Cache a module-level promise.

```typescript
// lib/db.ts
import { Surreal } from "surrealdb";

let clientPromise: Promise<Surreal> | null = null;

export function getDb(): Promise<Surreal> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const db = new Surreal();
      await db.connect(process.env.SURREAL_URL!, {
        namespace: process.env.SURREAL_NS!,
        database: process.env.SURREAL_DB!,
        authentication: {                          // NOT auth: — renamed in SDK v2
          username: process.env.SURREAL_USER!,
          password: process.env.SURREAL_PASS!,
        },
      });
      return db;
    })().catch((err) => {
      clientPromise = null;   // allow retry on next call
      throw err;
    });
  }
  return clientPromise;
}
```

## Connection with auto-reconnect

```typescript
// lib/db-with-reconnect.ts
import { Surreal, EngineDisconnected } from "surrealdb";

class ReliableDb {
  private db: Surreal | null = null;
  private connecting: Promise<Surreal> | null = null;

  async get(): Promise<Surreal> {
    if (this.db) return this.db;
    if (this.connecting) return this.connecting;

    this.connecting = this.connect();
    try {
      this.db = await this.connecting;
      return this.db;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<Surreal> {
    const db = new Surreal();
    await db.connect(process.env.SURREAL_URL!);
    await db.use({
      namespace: process.env.SURREAL_NS!,
      database: process.env.SURREAL_DB!,
    });
    await db.signin({
      username: process.env.SURREAL_USER!,
      password: process.env.SURREAL_PASS!,
    });
    return db;
  }

  async query<T>(sql: string, vars?: Record<string, unknown>): Promise<T> {
    try {
      const db = await this.get();
      return (await db.query<[T]>(sql, vars))[0];
    } catch (err) {
      if (err instanceof EngineDisconnected) {
        this.db = null;
        return this.query<T>(sql, vars);   // reconnect + retry once
      }
      throw err;
    }
  }
}

export const reliableDb = new ReliableDb();
```

## End-user auth flow (record access)

Backend uses an operator account to bootstrap and run migrations; the browser / mobile client signs in via record access so row-level permissions apply.

```typescript
// client-side (browser / React Native)
import { Surreal } from "surrealdb";

const db = new Surreal();
await db.connect("wss://my.surrealdb.cloud/rpc");
await db.use({ namespace: "app", database: "main" });

// Try to resume from a stored token; fall back to signin
const stored = localStorage.getItem("surreal.jwt");
if (stored) {
  try {
    await db.authenticate(stored);
  } catch {
    localStorage.removeItem("surreal.jwt");
  }
}

async function signIn(email: string, password: string) {
  const token = await db.signin({
    namespace: "app",
    database: "main",
    access: "account",
    variables: { email, password },
  });
  localStorage.setItem("surreal.jwt", token);
}

async function signUp(email: string, password: string, name: string) {
  const token = await db.signup({
    namespace: "app",
    database: "main",
    access: "account",
    variables: { email, password, name },
  });
  localStorage.setItem("surreal.jwt", token);
}

async function signOut() {
  await db.invalidate();
  localStorage.removeItem("surreal.jwt");
}
```

For SSR / Next.js, put the JWT in an `httpOnly` cookie and attach it server-side with `db.authenticate(cookieJwt)` before running the user's queries.

## Live-query subscription manager

Since live queries die on reconnect, wrap them so they re-subscribe.

```typescript
import { Surreal, Uuid } from "surrealdb";

type Handler<T> = (action: "CREATE" | "UPDATE" | "DELETE" | "CLOSE", result: T) => void;

interface Subscription {
  sql: string;
  vars: Record<string, unknown>;
  handler: Handler<any>;
  currentId: Uuid | null;
}

export class LiveManager {
  private subs: Map<string, Subscription> = new Map();

  constructor(private getDb: () => Promise<Surreal>) {}

  async subscribe<T>(
    key: string,
    sql: string,
    vars: Record<string, unknown>,
    handler: Handler<T>,
  ) {
    const sub: Subscription = { sql, vars, handler, currentId: null };
    this.subs.set(key, sub);
    await this.activate(sub);
  }

  async unsubscribe(key: string) {
    const sub = this.subs.get(key);
    if (!sub) return;
    if (sub.currentId) {
      try {
        const db = await this.getDb();
        await db.kill(sub.currentId);
      } catch {}
    }
    this.subs.delete(key);
  }

  async resubscribeAll() {
    for (const sub of this.subs.values()) await this.activate(sub);
  }

  private async activate(sub: Subscription) {
    const db = await this.getDb();
    const [id] = await db.query<[Uuid]>(sub.sql, sub.vars);
    sub.currentId = id;
    await db.subscribeLive(id, sub.handler);
  }
}
```

Call `liveManager.resubscribeAll()` after a successful reconnect.

## Backend seed / migration script

```typescript
// scripts/migrate.ts
import { Surreal } from "surrealdb";
import { readFile } from "node:fs/promises";

const db = new Surreal();
try {
  await db.connect(process.env.SURREAL_URL!);
  await db.signin({ username: "root", password: process.env.SURREAL_ROOT_PASS! });
  await db.use({ namespace: "app", database: "main" });

  const schema = await readFile("schema.surql", "utf8");
  await db.query(schema);

  console.log("migration applied");
} finally {
  await db.close();
}
```

Your `schema.surql` should wrap all `DEFINE` statements in `BEGIN;/COMMIT;` so the whole migration is atomic.

## Testing

For unit tests that touch the DB, use SurrealDB's in-memory engine:

```typescript
import { Surreal } from "surrealdb";

const db = new Surreal();
await db.connect("mem://");               // in-memory, ephemeral
await db.use({ namespace: "test", database: "test" });
// no signin needed for mem://
```

Each test gets a fresh, empty database. No server process required. Note: `mem://` requires the engine to be bundled — see the SDK docs for the current engine option if running in a browser.

## Binding dynamic identifiers safely

You can bind values but not identifiers (table names, field names). For a dynamic table name, use `type::thing`:

```typescript
const [rows] = await db.query(
  "SELECT * FROM type::table($table) WHERE id > type::thing($table, $after_id)",
  { table: "post", after_id: "01HG..." },
);
```

This keeps the SurrealQL injection-safe while letting the table name vary.

## Parallel writes vs one transaction

Two separate SDK calls are **not** transactional. For atomicity, send a multi-statement query with `BEGIN/COMMIT`:

```typescript
await db.query(
  `
  BEGIN TRANSACTION;
    UPDATE account:alice SET balance -= $amount;
    UPDATE account:bob   SET balance += $amount;
  COMMIT TRANSACTION;
  `,
  { amount: 100 },
);
```

## Browser bundling

The `surrealdb` package is ESM-first and ships conditional exports for Node and browsers. Vite, webpack 5+, esbuild, and Bun all resolve it correctly without config. If your bundler complains, check `type: "module"` in your project's `package.json`.
