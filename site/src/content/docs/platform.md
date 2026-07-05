---
title: Platform features
description: Signed webhooks, feature flags, push and inbox notifications, the admin SQL runner, a first-party MCP server, encrypted fields, and the audit log.
sidebar:
  order: 10
---

## Webhooks

Deliver signed HTTP callbacks when records change (or on custom events you dispatch). Deliveries are queued, retried with backoff, capped, and recorded — every attempt is inspectable.

### Subscribing to events

A webhook's `events` is a list of patterns. Record CRUD auto-fires `<collection>.create`, `.update`, and `.delete`; you can also fire your own from a hook with `helpers.webhooks.dispatch(event, data)`.

| Pattern | Matches |
| --- | --- |
| `posts.create` | Exactly that event |
| `posts.*` | Every event on `posts` |
| `*` | Everything |

### Configuration

| Field | Default | Notes |
| --- | --- | --- |
| `url` | — | Required; must be `http(s)://` |
| `events` | `[]` | Pattern array (empty = nothing) |
| `secret` | random | HMAC signing key; auto-generated (32 bytes hex) if omitted |
| `custom_headers` | `{}` | Extra request headers (reserved/security headers are stripped) |
| `enabled` | `true` | Master switch |
| `retry_max` | 3 | Total attempts |
| `retry_backoff` | `exponential` | `exponential` or `fixed` |
| `retry_delay_ms` | 1000 | Base delay |
| `timeout_ms` | 30000 | Per-attempt timeout (floored at 1000) |

### Delivery payload & headers

```http title="POST body + headers"
# headers
content-type:          application/json
user-agent:            cogworks-webhook
x-cogworks-event:      posts.create
x-cogworks-delivery:   <delivery uuid>
x-cogworks-timestamp:  1751500000        # unix seconds, sampled at send time
x-cogworks-signature:  sha256=<hex>

# body
{ "id": "<delivery uuid>",
  "event": "posts.create",
  "timestamp": 1751500000,
  "data": { "record": { "id": "rec_123", "title": "Hello" } } }
```

Delete events send `data: { id, record }` (the pre-delete snapshot).

### Verifying deliveries

The signature is `sha256=` + HMAC-SHA-256 of `<timestamp>.<raw body>` (the header timestamp, a literal dot, then the exact body bytes), keyed by the webhook secret. Compare in constant time and reject stale timestamps.

```js title="Receiver verification (Node)"
import crypto from "node:crypto";

function verify(headers, rawBody, secret) {
  const ts  = headers["x-cogworks-timestamp"];
  const sig = headers["x-cogworks-signature"];        // "sha256=<hex>"
  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(sig || "");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  if (Math.floor(Date.now()/1000) - parseInt(ts, 10) > 300) return false; // 5-min replay window
  return true;
}
```

### Delivery lifecycle

A background dispatcher ticks every 2 seconds, claims up to 50 due deliveries, and POSTs each with `redirect: manual`. A `2xx` marks the delivery `succeeded`; anything else (including `3xx` — redirects are refused as an SSRF defense) fails and reschedules until `retry_max`, then lands in `dead`. Exponential backoff is capped at 24 hours; the response body is captured up to 2 KB. Target URLs pass the same [SSRF egress guard](#ext-limits) as `helpers.http`.

### Admin endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/admin/webhooks` | List |
| `POST` | `/admin/webhooks` | Create |
| `PATCH` | `/admin/webhooks/:id` | Update |
| `DELETE` | `/admin/webhooks/:id` | Delete |
| `POST` | `/admin/webhooks/:id/test` | Fire a synthetic delivery |
| `GET` | `/admin/webhooks/:id/deliveries` | Delivery history (`?limit`, `?since`) |

Each delivery row records `attempt`, `status`, `response_status`, `response_body`, `error`, and timestamps — so you can debug a failing endpoint from the admin UI or API.

## Feature flags

Runtime flags with rule-based targeting, percentage rollouts, multivariate values, reusable segments, and flag prerequisites. Evaluate from your app (public endpoint) or from server-side code via `helpers.flags`.

### Anatomy of a flag

A flag has a `type` (`bool`, `string`, `number`, `json`), a `default_value`, an ordered list of `rules`, and named `variations`. Each rule has an optional `when` condition, an optional percentage `rollout`, optional `prerequisites`, and the `variation` it resolves to. The first matching rule wins; otherwise the default applies.

```json title="A targeted flag"
{
  "key": "new_dashboard", "type": "bool", "default_value": "false",
  "rules": [
    { "id": "beta",
      "when": { "all": [ { "segment": "internal" },
                        { "attr": "plan", "op": "in", "value": ["pro","team"] } ] },
      "rollout": { "value": 25, "sticky": "userId" },   // 25%, stable per userId
      "variation": "true" }
  ]
}
```

Condition operators: `eq`, `neq`, `in`, `not_in`, `contains`, `starts_with`, `ends_with`, `gt`/`gte`/`lt`/`lte`, `between`, `exists`, `regex`. Conditions nest with `all` / `any` / `not` and can reference a named `segment`. A percentage `rollout` hashes `key:stickyValue` for a stable per-user bucket.

### Evaluating

```json title="POST /api/v1/flags/evaluate — public"
{ "context": { "userId": "u_1", "plan": "pro" },
  "keys": ["new_dashboard", "beta_search"] }
→ { "data": { "new_dashboard": true, "beta_search": false } }
```

Omit `keys` to evaluate every flag. The admin preview endpoint (`POST /admin/flags/:key/evaluate`) returns the full result including the winning `rule_id` and a `reason` (`rule_match`, `no_match`, `disabled`, …). Flag and segment changes broadcast on the realtime `__flags` topic, so clients can react live.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/admin/flags` | List |
| `POST` | `/admin/flags` | Create / upsert |
| `PATCH` | `/admin/flags/:key` | Update |
| `DELETE` | `/admin/flags/:key` | Delete |
| `GET` | `/admin/flag-segments` | Reusable targeting segments (+ CRUD) |

## Notifications

Send in-app (inbox) and push notifications from your server-side code. One `helpers.notify()` call writes an inbox row _and_ fans out to every enabled push provider as independent queue jobs — one provider's outage never blocks the others, and each job retries with backoff.

### Triggering a notification

```js title="helpers.notify(userId, payload, opts?) — in any hook / route / job"
const res = await ctx.helpers.notify(userId,
  { title: "Order shipped", body: "Your order is on its way", data: { orderId, type: "order" } },
  { providers: ["fcm"], inbox: true, push: true });   // opts all optional
// res: { inboxRowId: "ntf_…" | null,
//        enqueued: [ { provider: "fcm", jobId: "job_…", deduped: false } ] }
```

`opts.providers` restricts the fan-out (default: all enabled); `inbox` (default true) writes the inbox row; `push` (default true) enqueues the provider jobs. The inbox row's `type` column is taken from `data.type` when it's a string, else `""`. It no-ops gracefully when nothing is bootstrapped (empty `enqueued`, `inboxRowId: null`).

### Bootstrapped collections

The first time you enable any provider, Cogworks idempotently creates two base collections. Deleting a user cascades to both (the `user` relations are cascade-delete).

| Collection (table) | Fields |
| --- | --- |
| `notifications` (`cw_notifications`) | `user` (relation, cascade), `type`, `title`, `body`, `data` (json), `read_at`. Read rule scopes to the owner; create is admin-only (rows are inserted by the server). |
| `device_tokens` (`cw_device_tokens`) | `user` (relation, cascade), `provider` (select: `fcm`, `apns`), `token` (text, **unique**), `platform` (select: `ios`, `android`, `web`), `app_version`, `enabled` (bool), `last_seen`. |

### Registering devices (FCM / APNs)

Native clients register their own push token. **OneSignal does not use this** — see below.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/notifications/devices` | `{ token, provider, platform, app_version? }` |
| `DELETE` | `/notifications/devices/:token` | Soft-delete (sets `enabled=0`) |

Register validates `token` (1–4096 chars), `provider` ∈ `fcm|apns` (`onesignal` is rejected 422), `platform` ∈ `ios|android|web`. It **upserts** on the unique `token` (`ON CONFLICT`), so re-registering rebinds the token to the current user and re-enables it. Deregister is scoped to `token AND user` (you can only remove your own). Both return `503` if notifications aren't bootstrapped yet.

### Providers

:::caution[OneSignal and FCM use fundamentally different models]
**FCM** is token-based: your app registers each device's FCM token via the endpoint above, and Cogworks sends to those tokens. **OneSignal** is `external_id`-based: Cogworks never stores OneSignal tokens — your client calls `OneSignal.login(cogworksUserId)`, and the fan-out targets `include_aliases.external_id = [userId]`. So `device_tokens` holds FCM/APNs tokens only.
:::

- **FCM** — auth is an OAuth2 bearer minted from the service-account JSON (RS256 JWT exchange, cached ~55 min). FCM v1 has no batch endpoint, so sends are one request per token (`Promise.allSettled`); all `data` values are coerced to strings. Tokens the platform reports dead (`UNREGISTERED`, `INVALID_ARGUMENT`, `SENDER_ID_MISMATCH`, `NOT_FOUND`) are auto-disabled (`enabled=0`).
- **OneSignal** — auth header is `Authorization: Basic <REST API key>` (the literal word "Basic" + the raw key, not base64). A `recipients: 0` response is logged as a warning — it usually means the client never called `OneSignal.login()`.

Both retry **transient** failures (5xx / 429 / network) through the queue's backoff + dead-letter; permanent **4xx** are logged and dropped (not retried).

#### Admin configuration

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/admin/notifications/providers` | Status: `onesignal.api_key_set`, `fcm.service_account_set` + parsed `client_email`; secrets masked unless `?reveal=1` |
| `PATCH` | `/admin/notifications/providers/:name` | Configure. Enabling FCM 422s unless `service_account` is present and valid JSON |
| `POST` | `/admin/notifications/providers/:name/test-connection` | Probe only — no message sent (OneSignal `GET /apps/:id`; FCM mints a token) |
| `POST` | `/admin/notifications/test` | `{ userId, title?, body?, data?, providers? }` — sends a real test push |

| Setting | Notes |
| --- | --- |
| `notifications.providers.onesignal.enabled` / `.app_id` / `.api_key` | Enabled requires all three |
| `notifications.providers.fcm.enabled` / `.project_id` / `.service_account` | Enabled requires `enabled` + valid `service_account` JSON; `project_id` falls back to the JSON's own |

:::tip[Debugging "why didn't user X get my push?"]
Check, in order: the provider is enabled (`GET …/providers`); for OneSignal, the client called `OneSignal.login(userId)` (a `recipients: 0` warning in the logs is the tell); for FCM, the user has an `enabled` row in `device_tokens` (dead tokens auto-disable); and the `_notify` queue job succeeded (Hooks → Jobs log — `concurrency 4`, `retry_max 5`, exponential backoff from 2 s, then dead-letter). Every send is logged; failures land in the job's `error`.
:::

## SQL runner

An admin SQL console with two modes: **read-only** against the live database, or a **per-admin sandbox** — an in-memory snapshot you can freely mutate without touching live data. The sandbox is rebuilt on demand and evicted after an hour idle.

| Mode | Behavior |
| --- | --- |
| `readonly` | Live DB opened read-only; mutating keywords are rejected (`COGWORKS_READONLY`) |
| `sandbox` | A per-admin on-disk snapshot (`VACUUM INTO` at `<dataDir>/sandboxes/<adminId>.db`); writes persist for your session only. Rebuild with `POST /admin/sql/sandbox/reset` |

```json title="POST /api/v1/admin/sql/run"
{ "sql": "SELECT id, title FROM cw_posts WHERE created > ?",
  "mode": "readonly", "params": [1751000000], "timeoutMs": 5000 }

→ { "data": {
     "ok": true, "columns": ["id","title"], "rows": [["rec_1","Hi"]],
     "rowCount": 42, "truncated": false, "durationMs": 3 } }
```

Results are capped at 1000 rows (`truncated: true` when hit); the time budget is 100–30000 ms (default 5000). On error the response is `ok: false` with an `errorCode` at HTTP 200, so the UI renders it inline.

:::caution[Interactive sessions only]
The SQL runner requires an interactive admin session — API tokens (even `admin`-scoped) are rejected. Automations use the MCP `run_sql` tool instead.
:::

### Saved queries & schema

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/admin/sql/sandbox/reset` | Rebuild the sandbox |
| `GET` | `/admin/sql/schema` | Tables, columns, indexes, foreign keys, row counts |
| `GET` | `/admin/sql/queries` | Saved queries (owner-scoped) + CRUD + run |

## MCP (AI agents)

Cogworks ships a first-party [Model Context Protocol](https://modelcontextprotocol.io) server so agents (Claude Desktop, Cursor, Continue, Cline) can manage your backend. Transport is HTTP + SSE, authorized by an API token with an `mcp:*` scope.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/v1/mcp` | JSON-RPC 2.0 turn |
| `GET` | `/api/v1/mcp/events` | SSE stream (server → client) |

It speaks JSON-RPC 2.0 (protocol `2025-06-18`) — `initialize`, `tools/list`, `tools/call`, `resources/read`, `prompts/get`. The registry is rebuilt each request, so schema changes appear immediately. Token scope determines which tools are visible.

| Tool group | Scope | Examples |
| --- | --- | --- |
| Per-collection records | `mcp:read` / `mcp:write` | `list_<col>`, `get_<col>`, `create_<col>`, `update_<col>`, `delete_<col>` |
| Introspection | `mcp:read` | `list_collections`, `describe_collection`, `read_logs`, `read_audit_log` |
| Schema & extensions | `mcp:admin` | `create_collection`, `alter_collection`, `create_hook`, `create_route`, `create_job`, `run_job_now` |
| Config | `mcp:admin` | `list_settings`, `update_setting`, `update_flag`, `dispatch_webhook_event` |
| Seed | `mcp:write` | `seed` — generate fake records (cap 1000) |
| SQL | `mcp:sql` | `run_sql` — read-only unless `allow_write:true`; `dry_run:true` returns the plan; 100-row cap |

Every tool name is **`cogworks.`-prefixed** on the wire (the table shows the short form) — e.g. `cogworks.list_posts`, `cogworks.run_sql`, `cogworks.create_collection`.

**Resources:** `cogworks://collections`, `://audit/recent`, `://settings`, `://server/info`, plus templates `://collection/{name}`, `://record/{collection}/{id}`, `://logs/{date}`. **Prompts:** `design-collection`, `debug-request`, `audit-rules`, `optimize-schema`, `import-from-pocketbase`. Scope note: `admin` implies everything, `mcp:admin` implies all `mcp:*`, and `mcp:write` does _not_ imply `mcp:read`.

:::caution[Write-tool safety]
Per-tool rate limits protect against a runaway agent: write-class tools are capped at **30 calls/min**, read tools at **240/min** (over-limit returns a tool error). `run_sql` writes need an explicit `allow_write:true` per call and reject mutating keywords even inside a `WITH`-CTE; pass `dry_run:true` to preview the `EXPLAIN QUERY PLAN` without executing. Raw-SQL writes bypass rules/validation/hooks/audit — prefer the typed `create_/update_` tools. Treat any record content an agent reads as an untrusted injection surface.
:::

A stdio bridge is published as `@cogworks/mcp` for local clients:

```json title="Claude Desktop / Cursor config"
{
  "cogworks": {
    "command": "npx",
    "args": ["-y", "@cogworks/mcp"],
    "env": { "COGWORKS_URL": "https://api.example.com",
             "COGWORKS_MCP_TOKEN": "cwat_…" }
  }
}
```

Run the bridge with `--read-only` to strip all write and admin tools.

## Encrypted fields

Mark a `text`, `email`, `url`, or `json` field `encrypted` and its values are AES-GCM encrypted at rest. Set `COGWORKS_ENCRYPTION_KEY` — the same key also encrypts secret-looking settings (SMTP passwords, S3 keys, OAuth secrets). Without it, secrets are stored in plaintext with a one-time startup warning.

:::caution[Key custody]
The encryption key is not stored in the database. Lose it and encrypted fields and secret settings become unreadable. Back it up separately from your data directory.
:::

### Rotating the key

Set the new key as `COGWORKS_ENCRYPTION_KEY` and the previous one as `COGWORKS_ENCRYPTION_KEY_OLD` (comma-separated for several). Decryption tries the primary key first, then each old key — so nothing breaks the moment you swap keys. Then re-encrypt everything under the new key:

```bash title="Rotate"
COGWORKS_ENCRYPTION_KEY=<new> COGWORKS_ENCRYPTION_KEY_OLD=<old> \
  cogworks rotate-key
→ Done: re-encrypted 128 field value(s) and 6 setting(s).
```

Runs in one transaction and is safe to re-run if interrupted. Keep `COGWORKS_ENCRYPTION_KEY_OLD` until backups and record history written under the old key are no longer needed, then drop it.

## Audit log

Every mutating admin action is recorded to an append-only log — who did what, to which target, and with what result. It's written by root middleware in a `finally` block, so failed requests are audited too.

### What's captured

- **Methods:** `POST`, `PUT`, `PATCH`, `DELETE` — reads (`GET`) are not audited.
- **Scope:** admin routes (`/api/admin/*`). Setup, login/logout, and preview/diff endpoints are excluded (auth events are tracked separately via sessions and login-failure records).
- Each entry derives a logical `action` from the path — e.g. `collections.delete`, `settings.update`, `hooks.create`, `webhooks.update`, `flags.delete`, `migrations.apply`.

| Field | Meaning |
| --- | --- |
| `actor_id` / `actor_email` | The admin (email cached so it survives account deletion) |
| `method` / `path` | HTTP method and path (no query string) |
| `action` / `target` | Derived label + affected id |
| `status` | HTTP status returned |
| `ip` | Client IP — populated only when `COGWORKS_TRUSTED_PROXIES` is set |
| `at` | Unix-seconds timestamp |

### Querying

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/admin/audit-log` | Filtered, paginated — admin |

Query params: `page`, `perPage` (≤500), `actorId`, `actionPrefix` (e.g. `collections.`), `from`, `to` (unix seconds).

```json title="GET /api/v1/admin/audit-log?actionPrefix=collections."
{ "data": {
  "data": [ { "actor_email": "admin@ex.com", "method": "DELETE",
              "action": "collections.delete", "target": "posts",
              "status": 200, "at": 1751500000 } ],
  "page": 1, "perPage": 50, "totalItems": 128, "totalPages": 3
} }
```
