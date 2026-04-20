# Serialization — jsonify, extractId, and the Server→Client boundary

SurrealDB returns rich objects (`RecordId`, `Date`, `Uuid`, `Decimal`) that are not JSON-serializable. This file covers how to handle them in Next.js App Router.

## The problem

```tsx
// Server Component
const [rows] = await db.query<[User[]]>("SELECT * FROM user");
return <ClientComponent data={rows} />;
// ❌ Hydration error: RecordId objects cannot cross the server→client boundary
```

Next.js serializes props with `JSON.stringify` for hydration. SurrealDB's `RecordId`, `Date`, `Uuid`, etc. fail this step.

## extractId — strip table prefix from record IDs

**File**: `lib/surreal.ts`

```tsx
import { extractId } from "@/lib/surreal";

extractId("user:abc123");          // "abc123"
extractId(recordIdObj);            // "abc123"  (RecordId object)
extractId({ id: "user:abc123" });  // "abc123"  (row with id field)
```

Uses `indexOf(":")` — no regex. Handles any table name format including hyphens, numbers, and `mod_` prefixes.

### Rules

- **Always** import `extractId` from `@/lib/surreal`.
- **Never** use inline `.replace(/^table:/, "")` — it breaks on table names with special characters.
- Use for URL params, key props, comparisons — anywhere you need the bare ID without the table prefix.

## jsonify — serialize for client components

**File**: `lib/surreal.ts` (re-exports from `surrealdb` SDK)

```tsx
import { jsonify } from "@/lib/surreal";
import type { Jsonify } from "@/lib/surreal";

// Server Component
const [rows] = await db.query<[User[]]>("SELECT * FROM user");
const data: Jsonify<User>[] = rows.map(r => jsonify(r));
return <ClientComponent data={data} />;
```

`jsonify()` recursively converts:
- `RecordId` → `"table:id"` string
- `Date` → ISO string
- `Uuid` → string
- `Decimal` → number
- `Duration` → string
- `Geometry` → GeoJSON object
- `Map` → plain object
- `Set` → array

### The mandatory rule

**ALL data from `db.query()` that passes from a Server Component to a Client Component MUST be wrapped with `jsonify()`.**

No exceptions. This is enforced project-wide.

### When to use JSON.parse(JSON.stringify()) instead

Only for two cases:
1. **Settings merge patterns** where `Record<string, unknown>` typing is needed.
2. **JOIN results with extra fields** not in the TypeScript type (e.g., `SELECT *, author.name AS authorName`).

In both cases, the data doesn't have a clean `Jsonify<T>` type — the output shape is dynamic.

## Typing in Client Components

```tsx
// types.ts
interface User {
  id: RecordId;         // server-side type
  email: string;
  name: string;
  createdAt: Date;
}

// Client Component receives Jsonify<User>:
// - id becomes string ("user:abc123")
// - createdAt becomes string (ISO format)
// - email and name stay as string

"use client";
import type { Jsonify } from "@/lib/surreal";

interface Props {
  data: Jsonify<User>[];
}

export function UsersTable({ data }: Props) {
  // data[0].id is string, not RecordId
  // data[0].createdAt is string, not Date
  return (...);
}
```

## Common patterns

### Page → Client data flow

```tsx
// app/admin/users/page.tsx (Server Component)
export default async function UsersPage({ searchParams }: Props) {
  const [rows] = await db.query<[User[]]>("SELECT * FROM user LIMIT 20");
  return <UsersTableClient data={jsonify(rows)} />;
}
```

### Extracting ID for navigation

```tsx
import { extractId } from "@/lib/surreal";

// In a table row
<Link href={`/admin/users/${extractId(user.id)}`}>
  {user.name}
</Link>
```

### Record ID in API calls

```tsx
// Client → API → Server: send the bare ID
const response = await fetch(`/api/admin/users/${extractId(user.id)}`, { method: "DELETE" });

// API route: reconstruct with type::record()
await db.query("DELETE FROM type::record('user', $id)", { id: params.id });
```
