---
title: Extensibility
description: Server-side JavaScript — hooks, custom routes, cron jobs, queue workers, durable workflows, the helpers API, and execution limits.
sidebar:
  order: 9
---

## Hooks

Run your own JavaScript on record events. Hooks are authored in the admin UI (or the admin API) and execute in-process with a rich [helpers](#ext-helpers) object. Six events: `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`.

A hook receives `ctx` with `record`, `existing` (prior row, on update/delete), `auth`, and `helpers`. **Before-hooks** run sequentially and can block (throw or `helpers.abort()` → `422`) or mutate `ctx.record` to change what's stored. **After-hooks** are fire-and-forget.

```js title="beforeCreate on orders"
// validate, enrich, and enqueue side effects
if (!ctx.record.customer_id) ctx.helpers.abort("customer_id is required");
ctx.record.ref = "ORD-" + ctx.helpers.uuid().slice(0, 8);
await ctx.helpers.enqueue("emails", { to: ctx.record.email, tmpl: "order_created" });
```

Managed at `/api/v1/admin/hooks` (list / create / update / delete — admin).

## Custom routes

Add your own endpoints under `/api/v1/custom/<path>` with any method. The route's `ctx` gives you `params`, `query`, `body`, `auth`, `helpers`, and `set` (status + headers). The return value becomes the JSON response.

```js title="GET /api/v1/custom/me/summary"
if (!ctx.auth) { ctx.set.status = 401; return { error: "sign in" }; }
const orders = await ctx.helpers.query("orders",
  { filter: `customer = "${ctx.auth.id}"` });
return { orders: orders.totalItems };
```

Managed at `/api/v1/admin/routes`.

## Cron jobs

Scheduled JavaScript on a standard 5-field cron expression, evaluated in UTC. Jobs run `inline` (in-process) or in `worker:<queue>` mode (enqueue for async processing). `ctx` exposes `helpers` and `scheduledAt`.

```json title="POST /api/v1/admin/jobs"
{
  "name": "purge-stale-carts",
  "cron": "30 2 * * *",          # daily 02:30 UTC
  "mode": "inline",
  "code": "const cutoff = ctx.scheduledAt - 86400*7; ctx.helpers.db.exec('DELETE FROM carts WHERE updated_at < ?', cutoff);"
}
```

Trigger any job immediately with `POST` `/admin/jobs/:id/run`. In cluster mode the scheduler runs only on the leader.

### One-off (run at)

To run a job _once_ at a specific time instead of on a recurring schedule, send `run_at` (a future unix timestamp, in **seconds**) in place of `cron`. The job fires a single time and then disables itself — it is never rescheduled. Everything else (`mode`, `code`) works the same.

```json title="POST /api/v1/admin/jobs"
{
  "name": "send-launch-email",
  "run_at": 1751500000,        # fire once at this unix time (seconds)
  "mode": "worker:emails",
  "code": "// enqueued onto the emails queue at run_at"
}
```

In the admin UI this is the **One-off (run at)** option on a job, with a date-time picker (entered in your local time, stored as UTC). A completed one-off keeps its history but has no next run.

## Queue workers

An in-process job queue — no Redis, no external broker. Enqueue work (from a hook, route, or job) and a worker processes it asynchronously with retries and backoff.

```js title="Enqueue + worker"
// producer (in any hook / route / job)
await ctx.helpers.enqueue("emails", { to, subject }, { delay: 60, uniqueKey: to });

// worker code (ctx: payload, attempt, queue, jobId, helpers)
await ctx.helpers.mails.send({ to: ctx.payload.to, subject: ctx.payload.subject, html });
```

Enqueue options: `delay` (seconds), `uniqueKey` (dedup), `retries`, `backoff` (`exponential`/`fixed`), `retryDelayMs`. Jobs move through `queued → running → succeeded` or, after exhausting retries, `dead` (a retryable dead-letter). Workers, jobs, and stats live under `/api/v1/admin/workers` and `/admin/queues/*`. Worker claims are atomic, so every cluster worker can process safely.

**Crash recovery.** If a worker process dies mid-job, the row would otherwise sit in `running` forever (and its `uniqueKey` would block re-enqueues). A reaper reclaims jobs stuck past `queues.visibility_timeout_sec` (default 300) — re-queuing them for another attempt, or dead-lettering once retries are exhausted. Keep the timeout well above `execution.timeout_ms`; delivery is at-least-once, so a job that runs longer than the timeout may run twice. Concurrency is counted from the database, so a worker's `concurrency` cap holds across all cluster processes.

:::note[Built-in queues: `_mail` and `_notify`]
Two queues ship with their own workers. System emails (verification, password reset, OTP) are **enqueued onto `_mail`** rather than sent inline — so a transient SMTP hiccup retries with backoff, dead-letters on exhaustion, and is reclaimed by the reaper, instead of silently dropping. Push notifications run the same way on `_notify`. It is the same durable machinery as your own queues; the mail transport itself (`mail.transport = smtp | http`, the latter being Resend's HTTP API) is configured in [Settings](#ops-settings).
:::

## Durable workflows

:::caution[Preview — in-source registration only]
The workflow engine is live and tested, but there is **no way to register a workflow from a running instance yet** — definitions are declared in source at boot. Admin-authored workflow definitions (compiled like queue workers) and an ops UI are the remaining piece (roadmap F-11c). The API below is stable; what's missing is the authoring surface.
:::

A code-first, resumable state machine persisted to SQLite (`cogworks_workflow_runs`). A workflow is an async function that orchestrates `step.run()` (a unit of work whose result is memoized) and `step.sleep()` / `step.waitForEvent()` (park, then resume). The function **re-executes from the top** each time the run advances — after a sleep, an event, or a process restart — and completed steps return their persisted result without re-running. This "memoized steps" model (DBOS / Inngest) means your function can use ordinary control flow; only `step.run` side effects are dedup'd. Runs move through `running → sleeping / waiting → completed` (or `failed`).

```js title="Define a workflow (in source)"
// register at boot — name must be unique
defineWorkflow("fulfill-order", async (step, input) => {
  const charge = await step.run("charge", () => billing.charge(input.orderId));

  // park until this order ships (correlated by key; match is plain JS)
  const ship = await step.waitForEvent("order.shipped", {
    key: input.orderId,
    match: (p) => p.orderId === input.orderId,
  });

  await step.run("notify", () => mail.send(input.email, "Shipped!", ship.tracking));
});
```

Drive runs from any hook, route, or job via `helpers.workflows`:

```js title="Start a run · deliver an event"
// kick one off → { runId }
await ctx.helpers.workflows.start("fulfill-order", { orderId, email });

// later, wake every run parked on order.shipped for this key
await ctx.helpers.workflows.emit("order.shipped", { orderId, tracking }, { key: orderId });
```

**Step semantics.** `step.run` is at-least-once (a crash before its result persists re-runs it on resume) — make bodies idempotent where a repeat would matter. Step names are the memo key, so they must be unique and stable within a workflow. `step.sleep(name, seconds)` parks the run for a duration; `step.waitForEvent(name, { key?, match? })` parks until a matching `emit` arrives.

## Helpers reference

Every hook, route, cron job, and queue worker receives the same `helpers` object. It's the API your server-side code uses to read data, call out, send mail, queue work, and more.

### Core helpers

| Helper | Signature & behavior |
| --- | --- |
| `find` | `find(collection, id)` → the record or `null` |
| `query` | `query(collection, {filter?, sort?, perPage?})` → `{data, totalItems}` (perPage default 100) |
| `enqueue` | `enqueue(queue, payload, {delay?, uniqueKey?, retries?, backoff?, retryDelayMs?})` → `{jobId, deduped}` |
| `notify` | `notify(userId, {title, body, data?}, {providers?, inbox?, push?})` → inbox row + push fan-out |
| `email` | `email({to, subject, body})` — HTML auto-detected; uses configured SMTP |
| `abort` | `abort(msg)` — throw a `422` (use in before-hooks to reject) |
| `uuid` / `id` | `crypto.randomUUID()` |
| `slug` | `slug(s)` — lowercase, non-alphanumeric → `-` |
| `log` | `log(...args)` — writes to the server log + hook log file |
| `fetch` | The raw platform `fetch` — **no SSRF guard** (see note) |

### Namespaced helpers

| Namespace | Members |
| --- | --- |
| `helpers.http` | `request({url, method?, headers?, body?, json?, retries?, timeoutMs?})` → `{status, ok, headers, text, json?}`; `getJson(url, headers?)`; `postJson(url, body, headers?)`. **SSRF-guarded**; retries 5xx/429 with backoff. |
| `helpers.db` | `query`, `queryOne`, `exec` → `{changes, lastInsertRowid}`, `execMulti`. Positional `?` or named `:name` params. |
| `helpers.security` | `hash`, `hmac`, `randomString`, `randomBytes`, `jwtSign`/`jwtVerify` (HS/RS/ES256), `aesEncrypt`/`aesDecrypt`, `constantTimeEqual` |
| `helpers.mails` | `send({to, cc?, bcc?, replyTo?, from?, subject, text?, html?, attachments?})` → `{messageId}` |
| `helpers.template` | `render(tmpl, vars)` — `{{var}}`, `{{#if x}}…{{/if}}`, dotted paths (not HTML-escaped); `escapeHtml(s)` |
| `helpers.flags` | `isEnabled`, `getString`, `getNumber`, `getJson` |
| `helpers.webhooks` | `dispatch(event, data?)` → `{enqueued}` (fire a custom webhook event) |
| `helpers.cron` | `add({name, schedule, code, enabled?})` (upsert), `remove(name)`, `list()` |
| `helpers.fs` | `read`, `readBytes`, `write`, `append`, `exists`, `stat`, `list`, `mkdir`, `remove`, `copy`, `mimeOf` |
| `helpers.os` · `helpers.path` · `helpers.util` | `env`/`cwd`/`platform`/`hostname` · `join`/`basename`/`dirname`/`ext` · `sleep`/`unmarshal` |

:::caution[Two fetches — pick deliberately]
`helpers.fetch` is the raw platform fetch with **no** SSRF protection. For any request to a user-controlled URL use `helpers.http.*`, which resolves the host and blocks private/loopback/link-local/metadata ranges before connecting.
:::

## Timeouts & egress

### Execution timeout

Every hook / route / job / worker runs under `execution.timeout_ms` (default 5000; `0` disables). This interrupts code that _awaits_ — a hung external call — but not a synchronous `while(true)` busy-loop.

### SSRF egress guard

`helpers.http.*` resolves each target host and blocks private/loopback/link-local/metadata ranges before connecting. Customize with settings `hooks.http.deny` (CIDR list; replaces the default set, or `"off"` to disable) and `hooks.http.allow` (punch holes for specific ranges).

:::caution[Hooks are trusted code, not a sandbox]
The egress guard reduces _accidental_ SSRF from `helpers.http` — it does **not** contain a malicious author. Hook/route/job code runs in the API process with the full JS global scope reachable (`fetch`, `Bun`, `process`), so raw `fetch`, subprocesses, and filesystem access all bypass it. Authoring server-side code is host-RCE-equivalent _by design_ — which is why it's restricted to the `owner`/`developer` admin roles. To run genuinely untrusted code, isolate the process at the OS level (network namespace + seccomp/nftables).
:::
