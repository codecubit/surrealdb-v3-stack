# Data modeling — record links vs graph edges vs embedding

SurrealDB is multi-model. Every relationship decision has three options. Pick wrong and you'll fight the query language instead of using it.

## Decision tree

```
Does the relationship have its own attributes (timestamp, role, weight)?
  YES → graph edge (RELATE)
  NO  ↓

Is it many-to-many?
  YES → graph edge (RELATE)
  NO  ↓

Is it 1:1 or 1:N and clearly "belongs to" one side?
  YES ↓
    Will you always need the related data when reading the parent?
      YES → embed (nested object/array)
      NO  → record link (record<t> field)
```

## The three options compared

| | Record link | Graph edge | Embed |
|---|---|---|---|
| **Schema** | `DEFINE FIELD author ON post TYPE record<user>` | `DEFINE TABLE wrote TYPE RELATION IN user OUT post` | `DEFINE FIELD address ON user TYPE object` |
| **Create** | `CREATE post SET author = type::record('user', $uid)` | `RELATE user:tobie -> wrote -> post:1 SET at = time::now()` | `CREATE user SET address = { city: "NYC", zip: "10001" }` |
| **Read** | `SELECT *, author.name FROM post FETCH author` | `SELECT ->wrote->post AS posts FROM user:tobie` | `SELECT address.city FROM user:tobie` |
| **Cardinality** | 1:1 or 1:N | M:N or attributed | 1:1 (object) or 1:N (array) |
| **Separate record** | No (field on parent) | Yes (edge table) | No (nested in parent) |
| **Can have attributes** | No | Yes (fields on the edge) | N/A |
| **Deletion** | Field becomes NONE | Edge record deleted separately | Data gone with parent |
| **Query cost** | One FETCH | Traversal (`->`) | Zero (already loaded) |

## When to use record links

**Best for**: "this post has one author", "this order belongs to one user", "this comment is on one post".

```surql
DEFINE TABLE post SCHEMAFULL;
DEFINE FIELD author ON post TYPE record<user>;
DEFINE FIELD category ON post TYPE option<record<category>>;  -- optional link

-- read with resolved link
SELECT *, author.name AS author_name, category.label FROM post FETCH author, category;
```

**Rules of thumb**:
- The child "belongs to" one parent.
- The link rarely changes after creation.
- You don't need metadata about the relationship itself.
- Use `option<record<t>>` when the link is nullable.

## When to use graph edges

**Best for**: "user follows user", "user purchased product", "user has role in org", anything M:N or with relationship attributes.

```surql
DEFINE TABLE follows TYPE RELATION IN user OUT user ENFORCED;
DEFINE TABLE purchased TYPE RELATION IN user OUT product ENFORCED;
DEFINE FIELD at ON purchased TYPE datetime VALUE time::now();
DEFINE FIELD quantity ON purchased TYPE int DEFAULT 1;

-- create
RELATE user:alice -> purchased -> product:widget SET quantity = 3;

-- traverse: "what did Alice buy?"
SELECT ->purchased->product.* AS items FROM user:alice;

-- reverse: "who bought this product?"
SELECT <-purchased<-user.name AS buyers FROM product:widget;

-- filtered traversal: "recent purchases"
SELECT ->purchased[WHERE at > time::now() - 30d]->product AS recent FROM user:alice;

-- count over graph
SELECT name, count(->purchased->product) AS total_purchases FROM user;
```

**Use `ENFORCED`** to validate that `in` and `out` records exist at insert time. Without it, you can create dangling edges.

### Edge attributes are the killer feature

If you need timestamps, roles, weights, status, or any metadata about the relationship itself, that's a graph edge:

```surql
DEFINE TABLE member_of TYPE RELATION IN user OUT org ENFORCED;
DEFINE FIELD role ON member_of TYPE string ASSERT $value IN ["viewer", "editor", "admin"];
DEFINE FIELD joined_at ON member_of TYPE datetime VALUE time::now();

RELATE user:alice -> member_of -> org:acme SET role = "admin";

-- "what role does Alice have in Acme?"
SELECT ->member_of[WHERE out = org:acme].role FROM user:alice;
```

## When to embed

**Best for**: data that has no identity of its own, is always read with the parent, and doesn't need independent queries.

```surql
DEFINE FIELD address ON user TYPE object;
DEFINE FIELD address.street ON user TYPE string;
DEFINE FIELD address.city ON user TYPE string;
DEFINE FIELD address.zip ON user TYPE string;

-- arrays of objects
DEFINE FIELD tax_lines ON invoice TYPE array<object>;
DEFINE FIELD tax_lines[*].label ON invoice TYPE string;
DEFINE FIELD tax_lines[*].rate ON invoice TYPE decimal;
DEFINE FIELD tax_lines[*].amount ON invoice TYPE decimal;
```

**Don't embed when**:
- You need to query the nested data independently (`SELECT * FROM address WHERE city = "NYC"` — can't do this on embedded).
- The nested data grows unboundedly (use a separate table + record link).
- Multiple parents reference the same nested data (that's a record link).

## Anti-patterns

### 1. Using record links for M:N

```surql
-- bad: array of record links for M:N
DEFINE FIELD tags ON post TYPE array<record<tag>>;
-- problem: can't store relationship attributes, hard to query reverse ("posts with tag X")

-- good: graph edge
DEFINE TABLE tagged TYPE RELATION IN post OUT tag;
SELECT <-tagged<-post FROM tag:javascript;  -- easy reverse lookup
```

### 2. Using graph edges for simple ownership

```surql
-- overkill: edge table for "post belongs to user"
RELATE user:alice -> authored -> post:1;

-- simpler: record link
DEFINE FIELD author ON post TYPE record<user>;
CREATE post SET author = type::record('user', $uid);
```

### 3. Embedding large or growing data

```surql
-- bad: unbounded array on parent
DEFINE FIELD comments ON post TYPE array<object>;
-- grows without limit, slows every SELECT on post

-- good: separate table with record link
DEFINE TABLE comment SCHEMAFULL;
DEFINE FIELD post ON comment TYPE record<post>;
DEFINE FIELD body ON comment TYPE string;
```

## Denormalization — when to duplicate data

SurrealDB's `FETCH` resolves links cheaply, so you rarely need to denormalize. But there are exceptions:

| Denormalize when | Example | How |
|---|---|---|
| Hot read path needs zero joins | Product listing showing category name | `DEFINE FIELD category_name ON product VALUE (SELECT VALUE name FROM ONLY $this.category)` |
| Historical snapshot needed | Invoice line items at time of purchase | Store the price/name directly, not a link to the current product |
| Cross-namespace data | Reporting table aggregating from multiple DBs | Materialized view: `DEFINE TABLE stats AS SELECT ...` |

**Default to normalized** (links) and denormalize only when you measure a performance problem.
