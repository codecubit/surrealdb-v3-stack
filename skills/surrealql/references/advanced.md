# Advanced — graph, live, transactions, search, vectors, geo, GraphQL

Distinctive SurrealDB features. Read the section that matches the task.

## Graph queries

Two kinds of links — don't confuse them:

**Record links (`record<t>` fields).** A field pointing at another record. 1:1 or 1:N, belongs naturally to one side. Query with `FETCH`.

**Graph edges (`RELATE a->edge->b`).** A record in an edge table representing the relationship itself. Many-to-many or when the edge has its own attributes. Query with `->`/`<-`.

### Creating edges

```surql
-- single edge
RELATE person:tobie -> wrote -> post:1 CONTENT { at: time::now() };
RELATE person:tobie -> likes -> post:1;

-- many-to-many in one statement
RELATE (SELECT id FROM person WHERE role = "editor")
       -> can_edit
       -> (SELECT id FROM post WHERE draft = true);

-- bulk INSERT RELATION is faster than multiple RELATE
INSERT RELATION INTO likes [
  { in: person:tobie, out: post:1 },
  { in: person:tobie, out: post:2 },
];
```

### Traversing edges

```surql
-- out-edges: follow -> from here to there
SELECT ->likes->post AS liked FROM person:tobie;
SELECT ->likes.at AS when_liked, ->likes->post.title AS title FROM person:tobie;

-- in-edges: follow <- from here back to there
SELECT <-likes<-person AS fans FROM post:1;

-- multi-hop
SELECT ->wrote->post->tagged->tag AS topics FROM person:tobie;

-- predicates at any hop
SELECT ->likes[WHERE at > time::now() - 7d]->post AS recent_likes FROM person:tobie;

-- wildcard edge type
SELECT ->?->post FROM person:tobie;
SELECT <-?<-person FROM post:1;

-- edge attributes vs target attributes
SELECT ->likes.at FROM person:tobie;                -- edge attribute
SELECT ->likes->post.title FROM person:tobie;       -- target attribute

-- traversal from a search
SELECT ->follows->person AS following FROM person WHERE country = "FR";
```

### Counting over a graph

```surql
SELECT
  name,
  count(->likes->post) AS likes_given,
  count(<-likes<-person) AS likes_received
FROM person;
```

### Constrained edge tables

Prefer `DEFINE TABLE likes TYPE RELATION IN person OUT post ENFORCED` over leaving it open. Constraints catch bugs at insert time and make the schema self-documenting. `ENFORCED` additionally validates referenced records exist.

## Live queries

Server pushes changes on matching rows over the WebSocket. Not available over HTTP.

```surql
LIVE SELECT * FROM person;                                 -- all changes on table
LIVE SELECT name, email FROM user WHERE active = true;     -- filtered + projected
LIVE SELECT DIFF FROM post;                                -- diff-only payloads (JSON Patch on UPDATE)
```

Each change is delivered as `(action, result)` with `action` = `"CREATE"|"UPDATE"|"DELETE"|"CLOSE"`. `DIFF` returns a JSON Patch for UPDATEs instead of full records.

### Typical patterns

- **Room-scoped subscriptions.** Scope the `WHERE` so each client receives only what it needs.
- **Optimistic UI + server truth.** Client mutates locally; the server's live update is authoritative; reconcile by `id`.
- **Resource management.** Track every live `UUID` and `KILL` it on unmount. Leaked subscriptions pile up.
- **Reconnect.** Live queries die when the WebSocket drops. Client must re-issue them on reconnect — SurrealDB does not auto-restore.

`KILL $uuid;` unsubscribes (or `db.kill(uuid)` in the SDK).

## Transactions

```surql
BEGIN TRANSACTION;

LET $from := (SELECT * FROM ONLY account:alice);
LET $to   := (SELECT * FROM ONLY account:bob);

IF $from.balance < 100 THEN
  THROW "insufficient funds"
END;

UPDATE account:alice SET balance -= 100;
UPDATE account:bob   SET balance += 100;
CREATE transfer CONTENT { from: $from.id, to: $to.id, amount: 100, at: time::now() };

COMMIT TRANSACTION;
```

`CANCEL TRANSACTION` rolls back. `THROW "message"` aborts with an error. The atomic unit is **a single `db.query` call** containing the whole `BEGIN`/`COMMIT` — don't expect transaction semantics across multiple SDK calls.

## Control flow

```surql
-- if/else
IF $x > 0 THEN "pos" ELSE IF $x < 0 THEN "neg" ELSE "zero" END;

-- for loop
FOR $item IN [1, 2, 3] {
  CREATE thing CONTENT { n: $item };
};

-- throw an error (aborts transaction if inside one)
THROW "nope";

-- return / break / continue work as expected inside blocks
```

## Full-text search

Set up:

```surql
DEFINE ANALYZER en
  TOKENIZERS blank, class
  FILTERS lowercase, ascii, snowball(english);

DEFINE INDEX idx_post_search ON post FIELDS title, body
  SEARCH ANALYZER en BM25 HIGHLIGHTS;
```

Query:

```surql
SELECT
  id,
  title,
  search::score(1) AS score,
  search::highlight("<mark>", "</mark>", 1) AS snippet
FROM post
WHERE title @1@ "surrealdb" OR body @1@ "surrealdb"
ORDER BY score DESC;
```

`@N@` matches against the Nth index component (1-indexed, in the order listed in `DEFINE INDEX`). `search::score(N)` / `search::highlight(..., N)` retrieve per-column BM25 scores and highlights.

## Vector search

For RAG and semantic search. `HNSW` for large corpora (approximate, fast); `MTREE` for small/medium corpora (exact).

```surql
DEFINE INDEX idx_doc_embed ON document FIELDS embedding
  HNSW DIMENSION 1536 DIST COSINE;

CREATE document CONTENT {
  text: "SurrealDB is a multi-model database",
  embedding: [0.01, -0.02, ...],                     -- length must match DIMENSION
};

-- nearest-neighbour: top K closest to $q
SELECT
  id,
  text,
  vector::distance::cosine(embedding, $q) AS dist
FROM document
WHERE embedding <|5|> $q                             -- KNN: top 5
ORDER BY dist;
```

`<|K|>` returns the K nearest neighbours. Combine with `WHERE` predicates for hybrid filter + vector search.

## Time, durations, time-partitioned IDs

```surql
time::now();                                         -- current instant
time::now() - 7d;                                    -- a week ago
time::format(d, "%Y-%m-%d %H:%M:%S");
duration::secs(1h30m);                               -- 5400
<duration>"1w2d3h";                                  -- cast to duration
```

Datetime literals: `d'2024-01-01T00:00:00Z'`. Duration literals: `1w2d3h4m5s` (units: `w`, `d`, `h`, `m`, `s`, `ms`, `us`, `ns`).

Time-partitioned IDs for time-series:

```surql
CREATE event:[time::now(), rand::ulid()] CONTENT {...};
SELECT * FROM event:[d'2024-01-01', d'2024-02-01'];  -- range by composite ID
```

## Geo

```surql
DEFINE FIELD location ON shop TYPE geometry<point>;
CREATE shop:1 SET location = (10.5, 48.3);
CREATE shop:1 SET location = { type: "Point", coordinates: [10.5, 48.3] };

SELECT * FROM shop WHERE geo::distance(location, $center) < 5km;  -- within radius
SELECT * FROM shop WHERE location INSIDE $polygon;                -- inside polygon
```

Geometry types: `point`, `line`, `polygon`, `multipoint`, `multiline`, `multipolygon`, `collection`. Index with `DEFINE INDEX ... MTREE DIMENSION 2 DIST EUCLIDEAN`.

## GraphQL (v3)

Enable once per database:

```surql
DEFINE CONFIG GRAPHQL AUTO;
```

SurrealDB exposes a GraphQL endpoint at `/graphql` reflecting your schema. Same auth/permissions as SurrealQL. Useful if your client already speaks GraphQL; otherwise stick with the native RPC.

## Performance notes

- Index every field you `WHERE` on. `EXPLAIN FULL` shows whether an index was used.
- For hot writes, append `RETURN NONE` to skip serializing the new record.
- `PARALLEL` on a query can help when sub-branches are independent.
- `TIMEOUT 2s` keeps runaway queries from eating the connection.
- For hot reads, use `DEFINE TABLE foo AS SELECT ... GROUP BY ...` materialized views — maintained incrementally.
- Avoid `UPDATE table SET ...` without `WHERE` — full table rewrite.

## Hybrid search (full-text + vector in one query)

Combine BM25 text relevance with vector similarity for best-of-both-worlds retrieval:

```surql
DEFINE ANALYZER es
  TOKENIZERS blank, class
  FILTERS lowercase, ascii, snowball(spanish);

DEFINE INDEX idx_product_text ON product FIELDS name, description
  SEARCH ANALYZER es BM25;

DEFINE INDEX idx_product_embed ON product FIELDS embedding
  HNSW DIMENSION 1536 DIST COSINE;

-- hybrid query: weighted combination of text + vector scores
SELECT *,
  search::score(0) * 3 AS text_score,           -- name match weighted 3x
  search::score(1) * 1 AS desc_score,            -- description match weighted 1x
  vector::similarity::cosine(embedding, $vec) AS vec_score
FROM product
WHERE name @0@ $search
   OR description @1@ $search
   OR embedding <|10, COSINE|> $vec
ORDER BY (text_score * 0.3 + vec_score * 0.7) DESC
LIMIT 10;
```

Text search finds exact keyword matches; vector search finds semantically similar items. Adjust the `0.3 / 0.7` weights to favour precision (text) or recall (vector). Field-level boosts (`* 3`, `* 1`) prioritize where the match occurs (title vs body).

## File storage — `DEFINE BUCKET` (v3)

v3 introduces first-class file storage. Files are managed as database objects with permissions.

```surql
-- filesystem-backed bucket (path must be allowlisted in server config)
DEFINE BUCKET uploads BACKEND "fs:/app/uploads"
  PERMISSIONS
    FOR select WHERE $auth.role IN ["admin", "editor"],
    FOR create WHERE $auth.role == "admin",
    FOR delete WHERE $auth.role == "admin";

-- object-storage-backed bucket (S3-compatible)
DEFINE BUCKET media BACKEND "s3://my-bucket/media"
  PERMISSIONS FULL;

-- global bucket (accessible across namespaces/databases)
DEFINE BUCKET OVERWRITE shared BACKEND "fs:/shared"
  PERMISSIONS FOR select FULL, FOR create, delete NONE;
```

Operations:

```surql
-- upload a file
PUT uploads:/images/logo.png <bytes>;

-- read a file
GET uploads:/images/logo.png;

-- check if exists
HEAD uploads:/images/logo.png;

-- delete
DELETE uploads:/images/logo.png;

-- copy / rename
COPY uploads:/images/logo.png TO uploads:/archive/logo.png;
RENAME uploads:/images/old.png TO uploads:/images/new.png;

-- list files in a path
LIST uploads:/images/;

-- check existence (boolean)
EXISTS uploads:/images/logo.png;
```

Permissions on buckets use `$file` (the file path), `$target` (for copy/rename destination), and `$action` (the operation). Fine-grained control per operation type.

## `DEFINE SEQUENCE` (v3)

Auto-incrementing sequences for cases where you need monotonic counters:

```surql
DEFINE SEQUENCE invoice_num ON DATABASE;

-- use in a query
LET $num = sequence::next(invoice_num);
CREATE invoice CONTENT { number: $num, ... };

-- peek without incrementing
sequence::value(invoice_num);
```

Sequences are database-scoped. Use them for invoice numbers, order numbers, or any business ID that must be sequential. Don't use them as primary keys — SurrealDB's record IDs are better for that.

## Change Data Capture (CDC)

Track every mutation on a table. Useful for audit trails, event sourcing, and replication.

### Enable change tracking

```surql
DEFINE TABLE order CHANGEFEED 7d;  -- retain changes for 7 days
```

### Query changes

```surql
-- all changes since a timestamp
SHOW CHANGES FOR TABLE order SINCE d'2026-04-01T00:00:00Z';

-- returns: [{ changes: [{ define_table: ... }, { update: { id, ...data } }, ...], versionstamp: N }]
```

Each entry includes:
- `versionstamp` — monotonic version number for ordering
- `changes` — array of mutations (`create`, `update`, `delete`, `define_table`)

### Time-travel queries (VERSION)

Query data as it existed at a past point in time:

```surql
-- what did this order look like on March 15th?
SELECT * FROM order:abc VERSION d'2026-03-15T10:00:00Z';

-- compare current vs historical
LET $now = (SELECT * FROM ONLY order:abc);
LET $then = (SELECT * FROM ONLY order:abc VERSION d'2026-03-01T00:00:00Z');
RETURN { current: $now.status, was: $then.status };

-- historical aggregate: what was total revenue last month?
SELECT math::sum(total) AS revenue
FROM order
WHERE status == "completed"
VERSION d'2026-03-31T23:59:59Z';
```

`VERSION` works on any `SELECT` — single record, filtered, aggregated. Requires `CHANGEFEED` to be enabled on the table with sufficient retention.

### Practical patterns

```surql
-- audit: who changed what, when?
SHOW CHANGES FOR TABLE user SINCE time::now() - 24h;

-- sync: feed changes to an external system since last sync
SHOW CHANGES FOR TABLE order SINCE $last_versionstamp;
-- store the latest versionstamp client-side for next sync
```
