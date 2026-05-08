# EventBus + SurrealLiveAdapter (post-Phase-8)

The EventBus is **generic platform infrastructure** — not specific to AI agents, not specific to any module. SurrealDB LIVE queries power it. Each domain (platform AND every installed module) registers its own channels in its own file. Mixing domains in the same table is forbidden.

## Architecture

```
SurrealDB ──LIVE SELECT──→ SurrealLiveAdapter ──dispatch──→ EventBus ──handler──→ Worker
                                ↑                                                    │
                                │                                                    │
                  Platform channels (lib/eventbus/channels.ts)                       │
                  + module channels (modules/<id>/channels.ts)                       │
                  registered/unregistered dynamically                                │
                                                                                     ▼
                                                                    services/worker/index.ts
                                                                    (multi-domain consumer)
                                                                    Discovers modules via
                                                                    `app_module` table at boot
                                                                    + LIVE on `app_module`
```

## Key files

| File | Role |
|------|------|
| `lib/eventbus/EventBus.ts` | Generic pub/sub engine. Routes events by channel name. Supports wildcards (`task:*`). |
| `lib/eventbus/SurrealLiveAdapter.ts` | Bridges SurrealDB LIVE queries to EventBus. One LIVE query per unique table. Exposes `addChannels()` / `removeChannels()` for hot registration. |
| `lib/eventbus/channels.ts` | **Platform** channel registry — domains owned by core: AI agents, storage, billing, wallet, media. |
| `modules/<id>/channels.ts` | **Module** channel registry — domains owned by the module. Consumer-owned. Injected into the adapter at module register-time. |
| `modules/<id>/subscribe.ts` | Module's worker hook. Calls `adapter.addChannels(CHANNELS)` in `register()` and `adapter.removeChannels(Object.keys(CHANNELS))` in `stop()`. |
| `services/worker/index.ts` | Multi-domain consumer. **No static module imports** — discovers installed modules at boot from the `app_module` table and `await import("@/modules/<id>/subscribe")` for each. Subscribes LIVE to `app_module` for hot install/uninstall. |

> **Path note.** Pre-Phase-8 docs and older modules referred to `lib/events/`, `scripts/worker.ts`, and a single global `channels.ts`. Those are gone. Always write `lib/eventbus/` and `services/worker/`.

## Domain isolation rules — non-negotiable

1. **Each domain MUST own its own table.** `ai_task_queue` is exclusively the AI agents domain. `media_thumbnail_job` is exclusively media. `mod_blog_publish_job` (hypothetical) is exclusively the blog module. **Never mix.**
2. **Multiple channels can share a table** — differentiated by `where` clause (e.g., `task:pending` vs `task:completed` both use `ai_task_queue`).
3. **The worker is multi-domain** — it hosts handlers for ALL domains in one process. There is no per-domain worker.
4. **Channels of a module live with the module** — never hardcode module channels in `lib/eventbus/channels.ts`. That file is for platform-only domains.

## Platform channels — `lib/eventbus/channels.ts`

```typescript
// lib/eventbus/channels.ts (PLATFORM ONLY)
export const CHANNELS = {
  // ── Domain: AI Agents ──────────────────
  "task:pending": {
    table: "ai_task_queue",
    where: "status = 'pending'",
    actions: ["CREATE", "UPDATE"],
  } satisfies ChannelConfig<AiTask>,

  "task:completed": {
    table: "ai_task_queue",
    where: "status = 'completed'",
    actions: ["UPDATE"],
  } satisfies ChannelConfig<AiTask>,

  // ── Domain: Media ──────────────────────
  "media:thumbnail:pending": {
    table: "media_thumbnail_job",
    where: "status = 'pending'",
    actions: ["CREATE", "UPDATE"],
  } satisfies ChannelConfig,

  // ── Domain: Wallet (platform billing) ──
  "wallet:auto-recharge": {
    table: "wallet_auto_recharge_job",
    where: "status = 'pending'",
    actions: ["CREATE", "UPDATE"],
  } satisfies ChannelConfig<WalletAutoRechargeJob>,
} as const;
```

## Module channels — `modules/<id>/channels.ts`

A module that owns a job table declares its own channels next to its code:

```typescript
// modules/blog/channels.ts
export const CHANNELS = {
  "blog:publish:pending": {
    table: "mod_blog_publish_job",
    where: "status = 'pending'",
    actions: ["CREATE"],
  } satisfies ChannelConfig<BlogPublishJob>,
} as const;
```

The module's `subscribe.ts` injects them into the adapter when the module is installed:

```typescript
// modules/blog/subscribe.ts
import { CHANNELS } from "./channels";
import { handlePublish } from "./handlers/publish";

export async function register({ adapter, bus }) {
  adapter.addChannels(CHANNELS);
  bus.subscribe("blog:publish:pending", handlePublish);
}

export async function stop({ adapter, bus }) {
  adapter.removeChannels(Object.keys(CHANNELS));
  bus.unsubscribePattern("blog:*");
}
```

The worker calls `register()` on boot for every installed module and `stop()` when the module is uninstalled (LIVE-detected via `app_module`). No static imports of module code in `services/worker/index.ts` — everything is dynamic.

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

## Adding a new platform domain

1. **Create the job table** in `config/schema.ts` (SCHEMAFULL, with `status` field, with backfill if non-optional fields). Run `npm run check:schema-backfill`.
2. **Register channel(s)** in `lib/eventbus/channels.ts`.
3. **Add handler** in `services/worker/handlers/<domain>.ts` and import it in `services/worker/index.ts`.
4. **Never** mix with existing domain tables.

## Adding a new domain inside a module

1. **Create the job table** in `modules/<id>/manifest.ts` → `install()`. The table name MUST be `mod_<id>_<purpose>` (e.g. `mod_blog_publish_job`). Run `npm run check:schema-module-purity`.
2. **Declare channels** in `modules/<id>/channels.ts`.
3. **Inject** them in `modules/<id>/subscribe.ts` → `register()` via `adapter.addChannels(...)`.
4. **Subscribe handlers** with `bus.subscribe(...)` in the same `register()`.
5. **Tear down** in `stop()` with `adapter.removeChannels(...)` + `bus.unsubscribe(...)`.

## EventBus FIRST principle

For domain events (balance debits, lead assignments, job processing), **always use EventBus**. Never polling cron as the primary mechanism. Cron is only a safety net (hourly) for edge cases where LIVE queries might miss an event (worker boot before adapter ready, network partition).

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
