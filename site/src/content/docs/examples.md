---
title: Examples
description: Three worked builds — a guestbook, a multi-user blog, and an AI help desk — from basic CRUD to hooks, queues, and vector search.
sidebar:
  order: 3
---

## Example 1 — Guestbook

**Basic**

A public message wall. One collection, plain CRUD — the smallest thing that's actually useful.

Uses: `collections` · `records` · `filter` · `sort` · public rules

1. **Create the collection**
   One base collection with two fields. Public `list_rule`/`create_rule` (`null`) so anyone can sign the book; everything else stays admin-only.

   ```json title="POST /api/v1/collections"
   {
     "name": "messages", "type": "base",
     "list_rule": null, "create_rule": null,
     "fields": [
       { "name": "name", "type": "text", "options": { "max": 60 } },
       { "name": "body", "type": "text", "required": true, "options": { "max": 280 } }
     ]
   }
   ```

2. **Sign the book**

   ```bash title="POST /api/v1/messages"
   curl -X POST .../api/v1/messages \
     -H 'content-type: application/json' \
     -d '{"name":"Ada","body":"First!"}'
   → { "data": { "id": "msg_1", "name": "Ada", "body": "First!", "created": 1751500000 } }
   ```

3. **Read the wall**
   Newest first, 20 per page, optionally filtered.

   ```http title="GET /api/v1/messages"
   GET /api/v1/messages?sort=-created&perPage=20&filter=body ~ 'hello'
   → { "data": [ … ], "page": 1, "perPage": 20, "totalItems": 42, "totalPages": 3 }
   ```

:::caution[Rate the writes]
A public `create_rule` means anyone can post. The built-in [rate limiter](#ops-ratelimit) caps abuse by default; add a `beforeCreate` [hook](#ext-hooks) if you want profanity/length checks.
:::

## Example 2 — Blog with authors

**Intermediate**

A multi-user blog: authenticated authors, posts they own, threaded comments, and live updates.

Uses: `auth` · 3 collections · relations · ownership rules · `expand` · file upload · realtime

1. **An auth collection for authors**

   ```json title="POST /api/v1/collections"
   { "name": "users", "type": "auth",
     "fields": [ { "name": "name", "type": "text" } ] }   # email/verified are implicit
   ```

2. **Posts, owned by their author**
   A `relation` to `users`, a `file` cover, and rules so anyone can read published posts while only the author edits their own.

   ```json title="POST /api/v1/collections"
   {
     "name": "posts", "type": "base",
     "list_rule":   "status = 'published' || author = @request.auth.id",
     "view_rule":   "status = 'published' || author = @request.auth.id",
     "create_rule": "@request.auth.id != \"\"",
     "update_rule": "author = @request.auth.id",
     "delete_rule": "author = @request.auth.id",
     "fields": [
       { "name": "title",  "type": "text", "required": true },
       { "name": "body",   "type": "editor" },
       { "name": "cover",  "type": "file", "options": { "mimeTypes": ["image/*"], "maxSize": 5000000 } },
       { "name": "author", "type": "relation", "collection": "users" },
       { "name": "status", "type": "select", "options": { "values": ["draft","published"] } }
     ]
   }
   ```

3. **Comments, related to posts**

   ```json title="POST /api/v1/collections"
   { "name": "comments", "type": "base",
     "list_rule": null,
     "create_rule": "@request.auth.id != \"\"",
     "delete_rule": "author = @request.auth.id",
     "fields": [
       { "name": "post",   "type": "relation", "collection": "posts" },
       { "name": "author", "type": "relation", "collection": "users" },
       { "name": "body",   "type": "text", "required": true }
     ] }
   ```

4. **Register, log in, publish**

   ```http title="Author flow"
   POST /api/v1/auth/users/register  { "email": "ada@ex.com", "password": "…", "name": "Ada" }
   POST /api/v1/auth/users/login     { "email": "ada@ex.com", "password": "…" }
   → token

   POST /api/v1/posts                             # Bearer token
     { "title": "Hello", "author": "<my-id>", "status": "published" }
   # upload a cover into the file field
   POST /api/v1/files/posts/<post-id>/cover       -F "file=@cover.jpg"
   ```

5. **Render the feed with everything expanded**
   One request returns published posts with their author and comments attached.

   ```json title="GET /api/v1/posts?expand=author,comments_via_post&sort=-created"
   { "data": [ {
       "id": "post_1", "title": "Hello", "cover": "a1b2.jpg",
       "expand": {
         "author": { "id": "usr_9", "name": "Ada" },
         "comments_via_post": [ { "id": "cmt_1", "body": "Nice!" } ]
       } } ], "page": 1, "perPage": 30, "totalItems": 1 }
   ```

6. **Live comments**
   Subscribe over WebSocket so new comments appear without polling.

   ```js title="Realtime (browser)"
   const ws = new WebSocket("wss://api.example.com/realtime");
   ws.onopen = () => {
     ws.send(JSON.stringify({ type: "auth", token }));           // see only what rules allow
     ws.send(JSON.stringify({ type: "subscribe", topics: ["comments.create"] }));
   };
   ws.onmessage = e => {
     const ev = JSON.parse(e.data);
     if (ev.type === "create") addComment(ev.record);
   };
   ```

## Example 3 — AI help desk

**Advanced**

A support desk that validates and embeds tickets on write, notifies your team, streams live updates to a browser dashboard, and answers with both keyword and semantic search.

Uses: `5 collections` · CORS · hooks · queue worker · webhooks · full-text + vector search · feature flags · cron · realtime

### Data model

| Collection | Type | Purpose |
| --- | --- | --- |
| `users` | auth | Customers who open tickets |
| `agents` | auth | Support staff (separate login) |
| `tickets` | base | Subject, body, status, priority, opener, `embedding` (vector) |
| `ticket_messages` | base | The thread — relation to ticket + author |
| `canned_replies` | base | Reusable macros for agents |

1. **Open CORS for your dashboard**
   The browser dashboard lives on another origin, so allow it (this also gates WebSocket/SSE origins).

   ```json title="PATCH /api/v1/admin/settings"
   { "cors.origins": "https://support.acme.com",
     "cors.credentials": "1",
     "app.url": "https://support.acme.com" }
   ```

2. **The tickets collection with a vector field**

   ```json title="POST /api/v1/collections (excerpt)"
   { "name": "tickets", "type": "base",
     "list_rule": "opener = @request.auth.id || @request.auth.type = 'admin'",
     "fields": [
       { "name": "subject", "type": "text",   "required": true, "options": { "searchable": true } },
       { "name": "body",    "type": "editor", "options": { "searchable": true } },
       { "name": "status",  "type": "select", "options": { "values": ["open","pending","closed"] } },
       { "name": "priority","type": "select", "options": { "values": ["low","normal","high"] } },
       { "name": "opener",  "type": "relation", "collection": "users" },
       { "name": "embedding","type": "vector", "options": { "dimensions": 1536 } }
     ] }
   ```

3. **Enrich on write with a hook**
   A `beforeCreate` hook validates, defaults the priority, and computes an embedding by calling your model provider through the SSRF-guarded `helpers.http`.

   ```js title="Hook: tickets · beforeCreate"
   if (!ctx.record.subject) ctx.helpers.abort("subject is required");
   ctx.record.status   = "open";
   ctx.record.priority = ctx.record.priority || "normal";

   // embed subject+body for semantic search
   const res = await ctx.helpers.http.postJson(
     "https://api.openai.com/v1/embeddings",
     { model: "text-embedding-3-small", input: ctx.record.subject + "\n" + ctx.record.body },
     { authorization: "Bearer " + ctx.helpers.os.env("OPENAI_KEY") }
   );
   ctx.record.embedding = res.json.data[0].embedding;
   ```

4. **Notify the team after write**
   An `afterCreate` hook queues an email and pings Slack — both non-blocking.

   ```js title="Hook: tickets · afterCreate"
   await ctx.helpers.enqueue("emails",
     { to: "support@acme.com", ticket: ctx.record.id, subject: ctx.record.subject },
     { uniqueKey: "new-ticket-" + ctx.record.id });

   await ctx.helpers.webhooks.dispatch("ticket.opened",
     { id: ctx.record.id, subject: ctx.record.subject, priority: ctx.record.priority });
   ```

5. **A queue worker to send the mail**
   Register a worker on the `emails` queue (retries + backoff are built in).

   ```js title="Worker: queue emails"
   await ctx.helpers.mails.send({
     to: ctx.payload.to,
     subject: "New ticket: " + ctx.payload.subject,
     html: `<p>Ticket <b>${ctx.payload.ticket}</b> was opened.</p>`
   });
   ```

   Register the Slack webhook once (admin): `POST /admin/webhooks` with `{ "url":"https://hooks.slack.com/…", "events":["ticket.opened"] }`.

6. **Search — keyword and semantic**
   Full-text search is instant on the `searchable` fields. For "find similar tickets," embed the query and rank by vector distance — gated behind a feature flag so you can dark-launch it.

   ```http title="Two ways to search"
   # keyword
   GET /api/v1/tickets?search=login not working&filter=status='open'

   # semantic — behind a flag your app checks first
   POST /api/v1/flags/evaluate  { "context": { "userId": "agent_2" }, "keys": ["semantic_search"] }
   GET /api/v1/tickets?nearVector=[…]&nearVectorField=embedding&nearLimit=5
   ```

7. **Live agent dashboard**
   Agents watch every ticket change over SSE with automatic reconnect + replay.

   ```js title="Realtime dashboard"
   const es = new EventSource("https://api.acme.com/api/v1/realtime");
   es.addEventListener("connect", e => {
     const { clientId } = JSON.parse(e.data);
     fetch("https://api.acme.com/api/v1/realtime", { method: "POST",
       headers: { "content-type": "application/json" },
       body: JSON.stringify({ clientId, topics: ["tickets", "ticket_messages.create"] }) });
   });
   es.onmessage = e => applyChange(JSON.parse(e.data));
   // on reconnect the browser sends Last-Event-ID and misses nothing
   ```

8. **Auto-close stale tickets**
   A nightly cron job closes anything untouched for a week.

   ```json title="POST /api/v1/admin/jobs"
   { "name": "auto-close", "cron": "0 3 * * *", "mode": "inline",
     "code": "const cutoff = ctx.scheduledAt - 86400*7; ctx.helpers.db.exec(\"UPDATE cw_tickets SET status='closed' WHERE status='pending' AND updated_at < ?\", cutoff);" }
   ```

:::tip[What this touched]
Five collections, two auth flows, CORS, a validating + embedding hook, an async queue worker, an outbound webhook, full-text _and_ vector search, a feature flag, realtime with resume, and a scheduled job — all from one binary, no extra services.
:::
