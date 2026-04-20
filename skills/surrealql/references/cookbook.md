# Cookbook — real-world SurrealQL recipes

Copy-paste queries for common production scenarios. All tested against SurrealDB v3.

## 1. Paginated listing with total count

Two parallel queries — one for the page, one for the total:

```surql
-- page of results
SELECT * FROM product
WHERE status == 'active'
ORDER BY createdAt DESC
LIMIT $limit START $start;

-- total count (for pagination UI)
SELECT count() AS total FROM product
WHERE status == 'active'
GROUP ALL;
```

SDK usage:

```typescript
const page = 1, perPage = 20;
const [rows, countResult] = await db.query<[Product[], [{ total: number }]]>(
  `SELECT * FROM product WHERE status == 'active' ORDER BY createdAt DESC LIMIT $limit START $start;
   SELECT count() AS total FROM product WHERE status == 'active' GROUP ALL;`,
  { limit: perPage, start: (page - 1) * perPage }
);
const items = rows;
const total = countResult?.[0]?.total ?? 0;
```

## 2. Full-text search with field boosting

Boost name matches over description matches:

```surql
DEFINE ANALYZER search_analyzer TOKENIZERS blank, class FILTERS lowercase, ascii, snowball(english);
DEFINE INDEX idx_product_search ON product FIELDS name, description
  SEARCH ANALYZER search_analyzer BM25;

-- search query with weighted scoring
SELECT *,
  search::score(0) * 3 AS name_score,
  search::score(1) * 1 AS desc_score
FROM product
WHERE name @0@ $query OR description @1@ $query
ORDER BY (name_score + desc_score) DESC
LIMIT 20;
```

`@N@` references the Nth field in the index definition (0-indexed). Field 0 = name, field 1 = description.

## 3. Upsert with conditional update

Create if missing, update only changed fields if exists:

```surql
UPSERT setting:site MERGE {
  name: $name,
  logo: $logo,
  updatedAt: time::now()
};
```

For records that should only update specific fields when they change:

```surql
UPSERT user:alice SET
  email = $email,
  name = IF $name != NONE THEN $name ELSE name END,
  updatedAt = time::now();
```

## 4. Bulk insert with deduplication

```surql
-- INSERT silently skips duplicates with ON DUPLICATE KEY UPDATE
INSERT INTO product [
  { id: product:sku001, name: "Widget", price: 9.99dec },
  { id: product:sku002, name: "Gadget", price: 19.99dec },
  { id: product:sku001, name: "Widget v2", price: 10.99dec }
]
ON DUPLICATE KEY UPDATE
  name = $input.name,
  price = $input.price;
```

`$input` refers to the incoming row. Only the duplicate `product:sku001` gets updated.

## 5. Graph: "users who bought X also bought Y"

```surql
-- products bought by people who also bought product:widget
SELECT VALUE ->purchased->product
FROM (
  SELECT VALUE <-purchased<-user FROM product:widget
)
WHERE id != product:widget
GROUP ALL;

-- with frequency ranking
SELECT out AS product, count() AS co_purchases
FROM purchased
WHERE in IN (SELECT VALUE in FROM purchased WHERE out == product:widget)
  AND out != product:widget
GROUP BY out
ORDER BY co_purchases DESC
LIMIT 10;
```

## 6. Atomic transfer between two records

```surql
BEGIN TRANSACTION;

LET $from = (SELECT * FROM ONLY account:alice);
IF $from.balance < $amount THEN
  THROW "insufficient funds"
END;

UPDATE account:alice SET balance -= $amount;
UPDATE account:bob   SET balance += $amount;
CREATE transfer CONTENT {
  from: account:alice,
  to: account:bob,
  amount: $amount,
  at: time::now()
};

COMMIT TRANSACTION;
```

The entire block is atomic — if the `THROW` fires, nothing changes.

## 7. Nested array element update

Update a specific element in an array by index or condition:

```surql
-- append to array
UPDATE post:1 SET tags += "featured";

-- remove from array
UPDATE post:1 SET tags -= "draft";

-- update nested object in array by condition
UPDATE invoice:1 SET
  lines = array::map(lines, |$line| {
    IF $line.sku == $target_sku THEN
      { ...$line, quantity: $new_qty }
    ELSE
      $line
    END
  });
```

## 8. Computed aggregation view

Auto-maintained by SurrealDB — no cron, no manual refresh:

```surql
DEFINE TABLE product_stats AS
  SELECT
    count() AS total_products,
    math::sum(price) AS total_value,
    math::mean(price) AS avg_price,
    category
  FROM product
  WHERE status == 'active'
  GROUP BY category;

-- query the view like a normal table
SELECT * FROM product_stats WHERE category == type::record('category', $catId);
```

The view updates automatically when `product` rows change. It's read-only — you can't `CREATE` into it.

## 9. Record-level soft delete

Don't actually delete — mark as deleted and filter everywhere:

```surql
DEFINE FIELD deleted_at ON post TYPE option<datetime>;

-- "delete"
UPDATE post:1 SET deleted_at = time::now();

-- query only active records (use this WHERE everywhere)
SELECT * FROM post WHERE deleted_at IS NONE;

-- query including deleted (admin use)
SELECT * FROM post;

-- permanently delete old soft-deleted records
DELETE post WHERE deleted_at IS NOT NONE AND deleted_at < time::now() - 90d;
```

For automatic filtering, use permissions:

```surql
DEFINE TABLE post PERMISSIONS
  FOR select WHERE deleted_at IS NONE OR $auth.role == 'admin';
```

## 10. Dynamic pivot / key-value to columns

Turn a key-value settings table into a single object:

```surql
-- settings stored as key-value
CREATE setting:site_name SET value = "My App";
CREATE setting:site_logo SET value = "/logo.png";
CREATE setting:site_lang SET value = "en";

-- pivot into one object
SELECT
  (SELECT VALUE value FROM ONLY setting:site_name) AS name,
  (SELECT VALUE value FROM ONLY setting:site_logo) AS logo,
  (SELECT VALUE value FROM ONLY setting:site_lang) AS lang;

-- or use object::from_entries with a query
SELECT VALUE object::from_entries(
  (SELECT id.id() AS key, value FROM setting)
);
```

## Bonus: safe existence check

```surql
-- check if a record exists without loading all fields
SELECT VALUE id FROM ONLY user:alice;
-- returns user:alice if exists, NONE if not

-- check in a condition
IF (SELECT VALUE id FROM ONLY user:alice) != NONE THEN
  -- exists
ELSE
  -- doesn't exist
END;
```
