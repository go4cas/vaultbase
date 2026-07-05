---
title: REST API
description: Conventions, records, filtering, sorting, expanding relations, pagination, search, batch, CSV, and record history.
sidebar:
  order: 5
---

## REST conventions

All endpoints live under `/api/v1`. Send credentials as a bearer token; successful responses are wrapped in `{ "data": … }`; errors are `{ "error": string, "code": number, "details"?: … }`.

```http title="Authentication header"
Authorization: Bearer <jwt>          # user or admin session token
Authorization: Bearer cwat_<jwt>    # long-lived API token
```

Tokens can also arrive as the `cogworks_user_token` / `cogworks_admin_token` cookies. Absent credentials means anonymous — you get whatever public rules allow.

## Records

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/:collection` | List (paginated, filterable) |
| `GET` | `/:collection/:id` | Get one (sends ETag) |
| `POST` | `/:collection` | Create |
| `PATCH` | `/:collection/:id` | Partial update |
| `DELETE` | `/:collection/:id` | Delete |

Every returned record carries system fields — `id`, `collectionId`, `collectionName`, `created`, `updated` — alongside your fields. Password fields and auth-private columns are never emitted; expanded relations appear under `expand`.

```bash title="Create → update → list"
# create
curl -X POST .../api/v1/posts -H 'content-type: application/json' \
  -d '{"title":"Hello","body":"…","tags":["news"]}'
→ { "data": { "id":"…", "title":"Hello", "tags":["news"], "created":1751, "updated":1751 } }

# partial update
curl -X PATCH .../api/v1/posts/<id> -d '{"title":"Hello, world"}'

# list (paginated envelope)
curl '.../api/v1/posts?perPage=30&sort=-created'
→ { "data":[ … ], "page":1, "perPage":30, "totalItems":42, "totalPages":2 }
```

### List query parameters

| Param | Purpose |
| --- | --- |
| `page` / `perPage` | Offset pagination (defaults 1 / 30) |
| `filter` | Filter expression — see [Filtering](#filtering) |
| `sort` | Order — see [Sorting](#sorting) |
| `expand` | Attach relations — see [Expanding](#expand) |
| `fields` | Comma-separated projection (`id` always kept) |
| `skipTotal` | `1` to skip the `COUNT` (totals return `-1`) |
| `cursor` | Keyset pagination — see [Pagination](#pagination) |
| `search` | Full-text search — see [Search](#search) |
| `nearVector` / `nearVectorField` / `nearLimit` / `nearMinScore` | Vector search — see [Vector](#vector) |

### Optimistic concurrency (ETags)

Every record read returns a weak `ETag` derived from `updated`. Send it back to make writes conditional:

- `If-None-Match` on `GET` → `304 Not Modified` when unchanged.
- `If-Match` on `PATCH`/`DELETE` → `412 Precondition Failed` (with the current ETag) if the record moved on. `updated` is strictly monotonic, so two writes in the same second still get distinct tags.

### Error responses

Errors are always `{ "error": string, "code": number }`, sometimes with `details`.

| Code | When |
| --- | --- |
| 403 | Rule denied (or admin-only collection for a non-admin), or an API token lacks the [`collection:<name>:<read\|write>` scope](#auth-tokens) — `"Insufficient token scope"` |
| 404 | Collection or record not found |
| 405 | Write attempted on a read-only view collection |
| 409 | Delete blocked by a `restrict` relation (with `details`) |
| 412 | `If-Match` ETag mismatch (current ETag returned) |
| 422 | Validation failed — `details` maps each bad field to a message |

:::note[Auth collections]
Auth collections reject a direct `POST /:collection` — create users through [register](#auth-password) so passwords are hashed and hooks run.
:::

## Filtering

Pass a `filter=` expression on any list request. It's the same language that powers [access rules](#rules), compiled to parameterized SQL — so it's injection-safe. Compose comparisons with `&&` (and) / `||` (or) and group with parentheses. Limits: 4096 characters, 50 operands, nesting depth 32. A malformed `filter=` on a list is silently dropped (returns everything the rules allow); an invalid _rule_ denies.

### Literals

- **String** — single or double quoted: `'active'` or `"active"`. Escape an embedded quote with a backslash: `'it\'s'`.
- **Number** — bare: `42`, `-3.14`.
- **Boolean / null** — `true`, `false`, `null`. With `=`/`!=`, `null` compiles to `IS NULL` / `IS NOT NULL`.
- **Field reference** — a bare identifier (`status`) or a dotted path for JSON extraction (`meta.plan.tier`).

### Scalar operators

| Op | Meaning | Example |
| --- | --- | --- |
| `=` | equal (null-aware) | `status = 'active'` |
| `!=` | not equal (null-aware) | `status != 'archived'` |
| `>` `>=` | greater / greater-or-equal | `price >= 100` |
| `<` `<=` | less / less-or-equal | `stock < 5` |
| `~` | contains (substring `LIKE`, auto-wrapped `%…%`) | `title ~ 'sql'` |
| `!~` | does not contain | `title !~ 'draft'` |

### Array operators

For JSON-array columns (multi-`select`, multi-`file`, or a `_via_` back-relation). Prefix with `?` to match **any** element; add the `:each` modifier to require **every** element.

| Op | Meaning | Example |
| --- | --- | --- |
| `?=` `?!=` | any element equals / differs | `tags ?= 'urgent'` |
| `?>` `?>=` `?<` `?<=` | any element compares | `scores ?>= 90` |
| `?~` `?!~` | any element contains / not | `tags ?~ 'work'` |
| `field:each OP v` | every element satisfies (array non-empty) | `scores:each >= 50` |

### Field modifiers

Append a `:modifier` to a field reference.

| Modifier | Effect |
| --- | --- |
| `:lower` | Case-fold before comparing — `email:lower = 'a@b.com'` |
| `:length` | Array length or string length — `tags:length > 2` |
| `:isset` | 1/0 whether a request key is present — `@request.body.role:isset = false` |
| `:changed` | (update rules) whether the body value differs from the stored one |
| `:each` | Match-every over an array (see above) |

### Request & join references

Mostly used in rules, but valid in filters too. See the full operand list under [Access rules](#rules). In brief: `@request.auth.*`, `@request.method`/`.context`, `@request.headers|query|body.*`, cross-collection `@collection.name.field`, back-relations `target_via_field`, the datetime macros (`@now`, `@todayStart`, `@monthStart`, …), and functions `geoDistance(lonA,latA,lonB,latB)` and `strftime(...)`.

```text title="Filter examples"
?filter=status = 'active' && age >= 18
?filter=(role = 'admin' || role = 'editor') && verified = true
?filter=title ~ 'report' && archived != true
?filter=published = true && created >= @monthStart
?filter=tags ?= 'featured' || priority > 5
?filter=scores:each >= 50
?filter=meta.plan = 'pro' && seats:length > 10
```

## Sorting

Comma-separated columns; prefix `-` for descending. `created` and `updated` are aliases for the timestamp columns. Base and auth collections default to `-created`. Only whitelisted columns are accepted (unknown ones are ignored).

```text title="Sort"
?sort=-created            # newest first
?sort=-priority,name      # priority desc, then name asc
```

## Expanding relations

Attach related records inline with `expand=`. Expanded data appears under each record's `expand` object.

| Form | Behavior |
| --- | --- |
| `expand=author` | **Forward** — attach the referenced record |
| `expand=author.company` | **Nested** — expand relations of the expanded record |
| `expand=comments_via_post` | **Reverse** — all records whose relation points back here (as an array) |
| `expand=author,tags,comments_via_post` | Multiple, comma-separated |

```json title="GET /api/v1/posts?expand=author,comments_via_post"
{
  "data": [{
    "id": "rec_p1", "title": "Hello", "author": "usr_9",
    "created": 1751500000, "updated": 1751500000,
    "expand": {
      "author": { "id": "usr_9", "email": "a@ex.com", "name": "Ada" },
      "comments_via_post": [
        { "id": "cmt_1", "post": "rec_p1", "body": "Nice!" }
      ]
    }
  }],
  "page": 1, "perPage": 30, "totalItems": 1, "totalPages": 1
}
```

Forward expands attach a single object; reverse expands attach an array. Nesting recurses on the expanded records (`author.company` puts `company` under `expand.author.expand.company`).

:::note[Reverse expand respects rules]
Because a reverse expand can return many rows from another collection, it enforces that collection's `list_rule` — it never leaks records the caller couldn't list directly. Single (non-`multiple`) relations only.
:::

## Pagination

Two modes. Offset is the default and gives you totals; keyset is O(log n) at any depth and skips the `COUNT`.

### Offset

`?page=2&perPage=50` → response includes `page`, `perPage`, `totalItems`, `totalPages`. Add `?skipTotal=1` to skip the count (totals come back as `-1`).

### Keyset / cursor

Send `?cursor=` (empty for the first page), then follow the returned `nextCursor` until it is `null`. Requires exactly one sort column; `id` is appended automatically as a stable tiebreaker.

```bash title="Cursor pagination"
GET /api/v1/posts?sort=-created&cursor=
  → { "data":[…], "perPage":30, "nextCursor":"eyJ2Ijo…" }

GET /api/v1/posts?sort=-created&cursor=eyJ2Ijo…
  → { "data":[…], "perPage":30, "nextCursor":null }   // exhausted
```

A malformed cursor or a multi-column sort with a cursor returns `400`.

## Full-text search

Flag any text-like field (`text`, `email`, `url`, `editor`) with `searchable: true`. Cogworks builds an FTS5 index kept in sync by triggers, then `?search=` runs a full-text `MATCH`.

```json title="GET /api/v1/articles?search=graph database&filter=published=true"
{
  "data": [
    { "id": "art_7", "title": "Graph databases explained", "published": true },
    { "id": "art_2", "title": "Modeling a social graph in SQLite", "published": true }
  ],
  "page": 1, "perPage": 30, "totalItems": 2, "totalPages": 1
}
```

- **Composes with everything** — `filter`, access rules, sort, and pagination all apply, so search never surfaces a row the caller can't see.
- **Safe input** — the query is split into terms, each wrapped as a quoted phrase and AND-combined (max 32 terms). Operator characters, boolean words, and wildcards are neutralized, so arbitrary user text can never cause an FTS syntax error.
- **Accent-insensitive** tokenizer (`café` matches `cafe`).
- Results keep your `sort` (default `-created`) — relevance ranking is a planned enhancement.
- A collection with no `searchable` fields returns an **empty** result for a `search=` query (rather than everything), so a stray search never dumps the table.

## Vector search

Add a `vector` field with a fixed `dimensions`, then pass a query vector to rank by cosine similarity. It respects filters and rules and never ranks hidden rows.

| Param | Meaning |
| --- | --- |
| `nearVector` | The query vector (JSON array or comma list) |
| `nearVectorField` | Name of the `vector` field to compare against |
| `nearLimit` | Top-K (1–1000, default 10) |
| `nearMinScore` | Optional minimum cosine score |

```json title="GET /api/v1/docs?nearVector=[0.12,0.04,…]&nearVectorField=embedding&nearLimit=3"
{
  "data": [
    { "id": "doc_9", "title": "Vector indexes", "_score": 0.94 },
    { "id": "doc_3", "title": "Embeddings 101",  "_score": 0.88 },
    { "id": "doc_5", "title": "Cosine similarity", "_score": 0.81 }
  ],
  "page": 1, "perPage": 3, "totalItems": 3, "totalPages": 1,
  "_vector": { "scanned": 1234, "truncated": false }
}
```

Each record gets a `_score` (cosine, higher = closer) that survives a `fields` projection. `_vector.scanned` is how many candidates were compared; `_vector.truncated` is `true` when the scan hit `vector.max_candidates` (default 100,000). Search runs in-process — ideal for the tens-to-hundreds of thousands of vectors an embedded database realistically holds; `filter` and rules narrow the candidate set first.

**Validation (422):** the field isn't a `vector` field, `nearVector` isn't a numeric array, or its length doesn't match the field's `dimensions`.

## Batch

Apply up to **100** record operations atomically. The entire batch runs inside one SQLite transaction — if any operation fails, the whole batch is rolled back and nothing is written.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/batch` | Transactional multi-op |

Each entry has `method`, `url` (a normal record URL, versioned or legacy), and a `body` for writes. Supported ops mirror the HTTP API: create, list, get, update (`PATCH`/`PUT`), delete. Per-operation rules are enforced exactly as they would be over HTTP.

```json title="POST /api/v1/batch"
{
  "requests": [
    { "method": "POST",   "url": "/api/v1/orders",      "body": { "item": "sku_9", "qty": 2 } },
    { "method": "PATCH",  "url": "/api/v1/stock/sku_9", "body": { "count": 8 } },
    { "method": "DELETE", "url": "/api/v1/carts/c_1" }
  ]
}
```

```json title="200 — one result per request, in order"
{
  "data": [
    { "status": 201, "body": { "id": "ord_5", "item": "sku_9", "qty": 2 } },
    { "status": 200, "body": { "id": "sku_9", "count": 8 } },
    { "status": 204, "body": null }
  ]
}
```

Per-op status codes: create `201`, list/get/update `200`, delete `204`. If any op throws, the transaction rolls back and the call returns a single error naming the failing index — e.g. `{ "error": "Batch failed at request 1: Validation failed", "code": 422, "details": {…} }`.

:::note[Limits]
Max 100 requests (empty or over-limit → `422`). The reserved collection names `admin`, `auth`, `files`, `collections`, `health`, `batch`, and `custom` can't be targeted in a batch.
:::

## CSV import / export

Admin-only; base collections only (auth/view collections return `422`).

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/admin/export/:collection` | Download all rows as CSV |
| `POST` | `/admin/import/:collection` | Body = raw CSV text |

### Export

Streams `text/csv` with `Content-Disposition: attachment; filename="<name>.csv"`. Columns are `id, created, updated` then your fields in schema order (system, implicit, autodate, and password fields are omitted). Object/array values are JSON-stringified; nulls become empty cells.

### Import

The body is raw CSV text. The `id`, `created`, and `updated` columns are ignored (regenerated); unknown columns are skipped. Cells are decoded by the target field's type — numbers, booleans (`true`/`1`), JSON for `json`/`geoPoint`, scalar-or-array for `select`/`file`, numeric-or-ISO for `date`. Each row runs through the full create path (validation included).

```json title="200 — import result"
{ "data": {
  "created": 10, "failed": 2, "total": 12,
  "errors": [
    { "row": 3, "details": { "email": "must be a valid email" } },
    { "row": 9, "details": "title is required" }
  ]
} }
```

`row` is 1-based counting the header as row 1; errors are capped at 50.

## Record history

Set `history_enabled: 1` on a collection and every create, update, and delete is snapshotted to an internal history table. Endpoints return `404` when history isn't enabled for the collection.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/:collection/:id/history` | Paginated snapshots (inherits `view_rule`; `perPage` ≤ 200) |
| `POST` | `/:collection/:id/restore?at=<unix>` | Restore to a point in time — admin |

```json title="GET /api/v1/posts/rec_p1/history"
{ "data": {
  "data": [
    { "op": "update", "at": 1751500900, "snapshot": { "title": "Hello, world" } },
    { "op": "create", "at": 1751500000, "snapshot": { "title": "Hello" } }
  ],
  "page": 1, "perPage": 50, "totalItems": 2, "totalPages": 1
} }
```

Each entry also carries `id`, `collection`, `record_id`, and the actor (`actor_id`, `actor_type`) — so you can see who made each change. Restore finds the snapshot at-or-before `at` (`?at=` is required — `422` if missing) and applies it as an update, stripping `id`/timestamps first. History survives a record delete, but restoring a _deleted_ record isn't supported in v1 (returns `409`).
