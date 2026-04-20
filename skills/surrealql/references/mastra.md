# Mastra tables — the SCHEMALESS exception

The 6 `mastra_*` tables are the ONLY tables in this project that use SCHEMALESS. This is not a style choice — it's a technical requirement. **Never convert them to SCHEMAFULL.**

## The tables

| Table | Purpose |
|-------|---------|
| `mastra_thread` | Conversation threads (agent ↔ user) |
| `mastra_message` | Individual messages within threads |
| `mastra_observational_memory` | Agent observations and learned facts |
| `mastra_resource` | External resources tracked by agents |
| `mastra_vector_index` | Vector index metadata |
| `mastra_vector_entry` | Vector embeddings for RAG |

## Why SCHEMALESS

The Mastra SDK passes JavaScript `null` for optional fields. SurrealDB v3 SCHEMAFULL rejects `null` (`NULL`) on `option<T>` fields — it only accepts `undefined` (`NONE`).

```
JS null   → SurrealDB NULL → SCHEMAFULL option<T> → ❌ REJECTED (coerce error)
JS null   → SurrealDB NULL → SCHEMALESS            → ✅ Accepted
JS undef  → SurrealDB NONE → SCHEMAFULL option<T> → ✅ Accepted
```

We can't sanitize all values coming from the Mastra SDK (deep nested objects, dynamic schemas). SCHEMALESS is the only safe option.

## Rules

1. **Never convert `mastra_*` to SCHEMAFULL.** The SDK will break with coerce errors on NULL values.
2. **Never create project tables as SCHEMALESS.** Only `mastra_*` gets this exception.
3. **Mastra tables are defined in CORE_SCHEMA** with `mode: "SCHEMALESS"`. The Schema Builder skips field definitions for them — only indexes are emitted.
4. **Indexes on mastra tables work normally.** SCHEMALESS doesn't prevent indexing.
5. **Core migrations must never reference `mastra_*` tables.** The Mastra SDK controls their schema. If you need to add a field or index, do it in the Mastra adapter code, not in `config/schema.ts` MIGRATIONS.

## Schema Builder behavior for SCHEMALESS

```typescript
// In CORE_SCHEMA:
{
  name: "mastra_thread",
  mode: "SCHEMALESS",
  fields: [],     // empty — no field enforcement
  indexes: [
    { name: "idx_mastra_thread_resourceId", fields: "resourceId" },
  ],
}
```

The SQL generator emits:
```surql
DEFINE TABLE OVERWRITE mastra_thread SCHEMALESS;
-- No DEFINE FIELD statements
DEFINE INDEX IF NOT EXISTS idx_mastra_thread_resourceId ON mastra_thread FIELDS resourceId;
```

If the table was previously SCHEMAFULL (from an old migration), the generator also removes leftover field definitions to prevent ghost constraints.

## The NULL vs NONE cheat sheet

When writing queries against **your own SCHEMAFULL tables**:

```typescript
// ✅ Pass undefined for optional fields (becomes NONE)
await db.query("UPDATE user SET avatar = $avatar", { avatar: value || undefined });

// ❌ Never pass null to SCHEMAFULL option<T> fields
await db.query("UPDATE user SET avatar = $avatar", { avatar: null }); // REJECTED
```

When writing queries against **mastra_* tables**: anything goes — `null`, `undefined`, nested objects, arrays. SCHEMALESS accepts everything.

## Querying mastra tables

```typescript
// Reading mastra data is normal
const [threads] = await db.query<[MastraThread[]]>(
  "SELECT * FROM mastra_thread WHERE resourceId = $rid",
  { rid: agentSlug }
);

// But always use jsonify() before sending to client
return <ThreadList data={jsonify(threads)} />;
```

The same `jsonify()` / `extractId()` rules apply — mastra tables return RecordId objects too.
