# EventBus + SurrealLiveAdapter

The EventBus is **generic platform infrastructure** — not specific to AI agents. Each domain (AI, storage, billing, wallet) registers its own channels. SurrealDB LIVE queries power it.

## Architecture

```
SurrealDB ──LIVE SELECT──→ SurrealLiveAdapter ──dispatch──→ EventBus ──handler──→ Worker
                                                              │
                                    One LIVE query per table   │
                                    Routes by channel config   │
                                                              ▼
                                                    scripts/worker.ts
                                                    (multi-domain consumer)
```

## Key components

| File | Role |
|------|------|
| `lib/events/EventBus.ts` | Generic pub/sub engine. Routes events by channel name. Supports wildcards (`task:*`). |
| `lib/events/SurrealLiveAdapter.ts` | Bridges SurrealDB LIVE queries to EventBus. One LIVE query per unique table. |
| `lib/events/channels.ts` | Channel registry. Each domain registers its channels here. |
| `lib/events/types.ts` | TypeScript types for events, handlers, subscriptions. |
| `scripts/worker.ts` | Multi-domain consumer. Hosts handlers for ALL domains. |

## Channel registry

Each channel maps to ONE table and filters by `where` clause and `actions`:

```typescript
// lib/events/channels.ts
export const CHANNELS = {
  // ── Domain: AI Agents ──────────────────
  "task:pending": {
    table: "ai_task_queue",          // exclusive to AI domain
    where: "status = 'pending'",
    actions: ["CREATE", "UPDATE"],
  } satisfies ChannelConfig<AiTask>,

  "task:completed": {
    table: "ai_task_queue",
    where: "status = 'completed'",
    actions: ["UPDATE"],
  } satisfies ChannelConfig<AiTask>,

  // ── Domain: AI Chat ────────────────────
  "chat:generation:pending": {
    table: "mod_ai_chat_generation_job",
    where: "status = 'pending'",
    actions: ["CREATE", "UPDATE"],
  } satisfies ChannelConfig<ChatGenerationJob>,

  // ── Domain: Media ──────────────────────
  "media:thumbnail:pending": {
    table: "media_thumbnail_job",
    where: "status = 'pending'",
    actions: ["CREATE", "UPDATE"],
  } satisfies ChannelConfig,

  // ── Domain: Wallet ─────────────────────
  "wallet:auto-recharge": {
    table: "wallet_auto_recharge_job",
    where: "status = 'pending'",
    actions: ["CREATE", "UPDATE"],
  } satisfies ChannelConfig<WalletAutoRechargeJob>,
} as const;
```

### Domain isolation rules

1. **Each domain MUST own its own table.** `ai_task_queue` is exclusively AI. `media_thumbnail_job` is exclusively media. Never mix.
2. **Multiple channels can share a table** — differentiated by `where` clause (e.g., `task:pending` vs `task:completed` both use `ai_task_queue`).
3. **The worker is multi-domain** — it hosts handlers for ALL domains in one process.

## SurrealLiveAdapter

Creates ONE LIVE query per unique table (not per channel). Routes events to matching channels based on `where` + `actions`.

```typescript
// How it works internally:
const subscription = await db.live(new Table("ai_task_queue"));
subscription.subscribe((message) => {
  // message.action: "CREATE" | "UPDATE" | "DELETE"
  // message.value: the record data
  
  // Routes to matching channels:
  // - If action == "CREATE" && status == "pending" → dispatch to "task:pending"
  // - If action == "UPDATE" && status == "completed" → dispatch to "task:completed"
});
```

### LIVE query behavior

- Uses SDK v2 `db.live()` which returns `ManagedLiveSubscription` (auto-reconnects).
- LIVE queries **die on WebSocket disconnect** — the adapter re-subscribes on reconnect.
- The `where` evaluation is a simple field matcher (not full SurrealQL) — supports `field = 'value'`, `field = true`, `field = 123`.

## EventBus API

```typescript
// Subscribe to exact channel
const subId = bus.subscribe("task:pending", async (event) => {
  // event.channel: "task:pending"
  // event.action: "CREATE" | "UPDATE" | "DELETE"
  // event.data: the record
  // event.timestamp: Date
  await handlePendingTask(event.data);
});

// Subscribe to pattern (wildcard)
bus.subscribePattern("task:*", async (event) => {
  console.log(`Task event: ${event.channel} ${event.action}`);
});

// Unsubscribe
bus.unsubscribe(subId);

// Dispatch (usually done by SurrealLiveAdapter, not manually)
await bus.dispatch({
  channel: "task:pending",
  action: "CREATE",
  data: taskRecord,
  timestamp: new Date(),
});
```

## Adding a new domain

1. **Create the job table** in `config/schema.ts` (SCHEMAFULL, with `status` field).
2. **Register channel(s)** in `lib/events/channels.ts`.
3. **Add handler** in `scripts/worker.ts`.
4. **Never** mix with existing domain tables.

```typescript
// 1. Schema
{ name: "email_send_job", mode: "SCHEMAFULL", fields: [
  { name: "status", type: "string", default: "'pending'" },
  { name: "to", type: "string" },
  { name: "subject", type: "string" },
  { name: "body", type: "string" },
  { name: "createdAt", type: "datetime", default: "time::now()" },
], indexes: [] },

// 2. Channel
"email:send:pending": {
  table: "email_send_job",
  where: "status = 'pending'",
  actions: ["CREATE"],
} satisfies ChannelConfig,

// 3. Worker handler
bus.subscribe("email:send:pending", async (event) => {
  await sendEmail(event.data);
  await db.query("UPDATE type::record('email_send_job', $id) SET status = 'sent'",
    { id: extractId(event.data.id) });
});
```

## EventBus FIRST principle

For domain events (balance debits, lead assignments, job processing), **always use EventBus**. Never polling cron as the primary mechanism. Cron is only a safety net (hourly) for edge cases where LIVE queries might miss an event.

## Performance note: correlated subqueries

When querying job tables, avoid correlated subqueries — they're the #1 performance trap:

```typescript
// ❌ SLOW (2150ms): correlated subquery runs per-row
"SELECT * FROM product WHERE id IN (SELECT VALUE productId FROM variant WHERE active = true)"

// ✅ FAST (56ms): prefetch + parameter
const [ids] = await db.query("SELECT VALUE array::distinct(productId) FROM variant WHERE active = true GROUP ALL");
const [products] = await db.query("SELECT * FROM product WHERE id IN $ids", { ids });
```

38x speedup measured on 1,062 products. This pattern applies everywhere: job tables, product queries, user filters.
