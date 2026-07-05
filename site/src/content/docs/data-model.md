---
title: Data model
description: Collections, field types and validation, and the access-rule expression language.
sidebar:
  order: 4
---

## Collections

A collection is a typed set of records. There are three kinds:

| Type | Backed by | Behavior |
| --- | --- | --- |
| **base** | a real table `cw_<name>` | Plain data collection with your fields. |
| **auth** | a table + auth columns | Everything base has, plus login: implicit `email`/`verified` fields and managed columns for password, TOTP, and passkeys. Users of this collection can authenticate. |
| **view** | a SQLite `VIEW` | Read-only. Defined by a `view_query` SELECT; fields are inferred from the result. Defaults to **admin-only** because raw SQL has unrestricted reach. |

Every record carries system fields: `id` (a UUID string), `created`, and `updated` (both unix seconds), plus your defined fields. Collections are managed through the admin UI or the admin API:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/collections` | List collections (open) |
| `GET` | `/collections/:id` | Get one by id or name |
| `POST` | `/collections` | Create — admin |
| `PATCH` | `/collections/:id` | Update schema / rules — admin |
| `DELETE` | `/collections/:id` | Drop — admin |

```bash title="POST /api/v1/collections — a base collection"
curl -X POST .../api/v1/collections \
  -H "authorization: Bearer <admin-jwt>" \
  -d '{
    "name": "posts",
    "type": "base",
    "list_rule": "",
    "view_rule": null,
    "create_rule": "@request.auth.id != \"\"",
    "fields": [
      { "name": "title",  "type": "text",     "required": true, "options": { "max": 120 } },
      { "name": "body",   "type": "editor" },
      { "name": "author", "type": "relation", "collection": "users" },
      { "name": "status", "type": "select",   "options": { "values": ["draft","published"] } }
    ]
  }'

→ { "data": { "id": "col_1", "name": "posts", "type": "base", "fields": [ … ],
             "list_rule": "", "create_rule": "…", "created_at": 1751500000 } }
```

Update the schema by `PATCH`ing `fields` — Cogworks diffs old vs new and runs the `ALTER TABLE`s (adding a column strips `NOT NULL`; changing a field's _type_ is refused — drop and re-add). A duplicate collection name returns `400`; invalid field definitions return `422`.

### View collections

A view exposes a read-only SELECT as a collection. The query is validated as a single statement that must begin with `SELECT`; DDL/DML keywords (`insert`, `update`, `drop`, `pragma`, `attach`, `with`, …) are rejected. It is _not_ a sandbox — an admin can still read sensitive tables, which is why views default to admin-only rules.

```json title="POST /api/v1/collections — a view"
{
  "name": "published_posts",
  "type": "view",
  "view_query": "SELECT id, title, author FROM cw_posts WHERE status = 'published'"
}
```

## Fields & validation

Fields are typed and validated on every write. Validation failures return `422` with a per-field `details` map.

| Type | Stores | Validation & notes |
| --- | --- | --- |
| `text` | string | `min`/`max` length, `pattern` regex |
| `number` | float | finite number; `min`/`max` value bounds |
| `bool` | 0 / 1 | must be boolean |
| `email` | string | email-shaped |
| `url` | string | http(s) URL |
| `date` | integer | unix seconds or an ISO string (parsed) |
| `autodate` | integer | system-managed timestamp; set on create/update per config |
| `select` | string / array | value(s) must be in `values`; `multiple` → array |
| `relation` | record id(s) | target must exist; `collection` names the target; cascade config |
| `file` | filename(s) | upload validated by the files API (`maxSize`, `mimeTypes`) |
| `json` | any JSON | no validation |
| `editor` | HTML string | `max` length; server-side sanitized (strips scripts/handlers) |
| `password` | argon2id hash | string; `min`/`max`; never returned by the API |
| `geoPoint` | `{lat,lng}` | lat ∈ [-90,90], lng ∈ [-180,180] |
| `vector` | float array | requires `dimensions` (1–4096); exact-length numeric array |

### Field options

| Option | Applies to | Effect |
| --- | --- | --- |
| `min` / `max` | text/editor/password (length), number (value) | Bounds — length for strings, value for numbers |
| `pattern` | text | Regex the value must match |
| `unique` | any | `UNIQUE` constraint + runtime uniqueness check (excludes self on update) |
| `values` / `multiple` | select | Allowed set; `multiple` makes the value an array |
| `searchable` | text / email / url / editor | Include in the full-text index (see [Search](#search)) |
| `encrypted` | text / email / url / json | AES-GCM at rest; requires `COGWORKS_ENCRYPTION_KEY` |
| `cascade` | relation | `setNull` (default) · `cascade` (delete referrers) · `restrict` (block delete, 409) |
| `maxSize` / `mimeTypes` | file | Per-file size cap and allowed MIME patterns (`image/*`) |
| `protected` · `viewRule` · `requireAuth` | file | Download gating — token required, per-field rule, auth required (see [Files](#files-transfer)) |
| `oneTimeToken` · `bindTokenIp` · `auditDownloads` | file | Single-use download tokens · IP-bound tokens · audit each fetch |
| `dimensions` | vector | Embedding length (1–4096) |

### Field values on the wire

Here's how each type looks in a record body. Multi-valued `select`/`file`/`relation` are arrays; `geoPoint` is an object; `vector` is a number array; `password` is write-only (accepted on input, never returned).

```js title="A record"
{
  "id": "rec_1", "created": 1751500000, "updated": 1751500000,
  "title":    "Launch plan",             // text / editor / email / url
  "views":    1280,                       // number
  "pinned":   true,                       // bool
  "due":      1751600000,                 // date (unix seconds)
  "tags":     ["news", "featured"],       // select (multiple)
  "author":   "usr_9",                    // relation (id)
  "cover":    "a1b2c3.jpg",               // file (stored filename)
  "meta":     { "plan": "pro" },          // json
  "where":    { "lat": 51.5, "lng": -0.12 }, // geoPoint
  "embedding": [0.12, 0.04, 0.98]         // vector
}
```

:::note[Auth collections]
Auth collections always have implicit `email` (unique per collection) and `verified` fields. The names `email`, `password`, `verified`, `tokenKey`, `password_hash`, and `email_verified` are reserved for your own fields.
:::

## Access rules

Each collection has five rule columns — `list_rule`, `view_rule`, `create_rule`, `update_rule`, `delete_rule`. Each is one of:

| Value | Meaning |
| --- | --- |
| `null` | **Public** — anyone may perform the action |
| `""` (empty) | **Admin only** — non-admins get `403` |
| an expression | Evaluated per request; admins always pass. A false result → `403` (or, for lists, the row is filtered out) |

`list_rule` is compiled into the query as a `WHERE` filter, so non-matching rows are silently excluded. The other four are per-record checks. A parse error or an unauthenticated reference to `@request.auth.*` denies by default (fail-closed).

### Rule expression language

The same language powers the `filter=` query param and access rules. Compose comparisons with `&&` / `||` and parentheses.

| Operand | Resolves to |
| --- | --- |
| `field`, `a.b.c` | A record field (dotted paths do JSON extraction) |
| `@request.auth.id` / `.email` / `.type` | The authenticated principal |
| `@request.method` / `.context` | HTTP method · request context: `default`, `password`, `oauth2`, `otp`, `realtime`, `protectedFile` |
| `@request.headers.x` / `.query.x` / `.body.x` | Request maps (`authorization`/`cookie` are redacted) |
| `@collection.name.field` / `@collection.name:alias.field` | Join into another collection (inherits its `view_rule`; alias for self-joins). Chains capped at depth 4 |
| `target_via_field` | Back-relation: ids of records pointing here |
| Datetime macros (16) | `@now` · `@yesterday` · `@tomorrow` · `@todayStart/End` · `@monthStart/End` · `@yearStart/End` · `@second/minute/hour/day/weekday/month/year` |

Operators: `=` `!=` `>` `>=` `<` `<=` `~` (contains) `!~`. Prefix `?` for array match-any (`?=`, `?~`, …). Suffix modifiers: `:isset`, `:changed` (update rules), `:length`, `:lower`, `:each` (match-every).

```bash title="Example rules"
# Owners only can view/update their rows
@request.auth.id = user_id

# Public reads of published rows, or the owner sees drafts too
status = 'published' || owner = @request.auth.id

# Any signed-in non-admin user
@request.auth.id != "" && @request.auth.type = 'user'

# Membership via a join
@collection.team_members.user = @request.auth.id
```

### Rules in practice

Say `posts` has `list_rule = "status = 'published' || author = @request.auth.id"`. An anonymous caller sees only published rows; the author additionally sees their own drafts — from the _same_ request, with no extra query.

```bash title="Same endpoint, different callers"
GET /api/v1/posts                          # anonymous
→ only published rows

GET /api/v1/posts  (Bearer alice's token)  # the author
→ published rows + alice's own drafts

PATCH /api/v1/posts/<someone-elses>  (Bearer alice)   # update_rule fails
→ { "error": "Forbidden", "code": 403 }
```

:::caution[Note on `@request.ip`]
An `@request.ip` operand is available only in file-download rules (the `viewRule` field option), not in general collection rules.
:::
