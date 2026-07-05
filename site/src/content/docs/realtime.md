---
title: Realtime
description: WebSocket and SSE realtime streams, topic subscriptions, reconnect replay, and presence tracking.
sidebar:
  order: 7
---

## Realtime — WebSocket

Connect to `WS` `/realtime` (note: not under `/api/v1`). On open the server sends `{"type":"connected"}`. Subscribe to topics and optionally attach a bearer token so per-record `view_rule` filtering applies.

```json title="Client → server"
{ "type": "auth", "token": "<user-jwt>" }
{ "type": "subscribe", "topics": ["posts", "comments/abc123", "orders.create", "*.delete"] }
{ "type": "subscribe", "topics": ["posts"], "filter": "status = 'published'" }
{ "type": "unsubscribe", "topics": ["posts"] }
{ "type": "list-subs" }
```

The server acknowledges control messages and streams events:

```js title="Server → client"
// acks
{ "type": "subscribed",   "topics": ["posts", …] }   // canonicalized
{ "type": "unsubscribed", "topics": ["posts"] }
{ "type": "subs",         "topics": [ … ] }         // reply to list-subs
{ "type": "error", "code": "invalid_topics", "message": "…" }
```

Record events arrive as frames:

```json title="Server → client"
{ "type": "create", "collection": "posts", "record": { … } }
{ "type": "update", "collection": "posts", "record": { … } }
{ "type": "delete", "collection": "posts", "id": "…" }
```

### Topics

| Topic | Matches |
| --- | --- |
| `posts` | Every event on the collection |
| `posts/<id>` | One specific record |
| `posts.create` | Only that event type (`create`/`update`/`delete`) |
| `*` · `*.delete` | Everything · that event type globally |

### Subscription filters

Add a `filter` to a `subscribe` message (or the SSE topic POST) to receive only the matching records — the same [expression syntax](#rules) as access rules, AND-combined with the collection's `view_rule` and evaluated per event against the record. It narrows delivery so clients don't over-subscribe; unlike a view rule it's the client's own choice, so admins aren't exempt. It's per-topic, so a broader unfiltered subscription (e.g. `*`) still delivers.

## Server-Sent Events

For environments that can't hold a WebSocket, use SSE. Open the stream, read your `clientId` from the first frame, then set topics with a companion POST.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/realtime` | Open the event stream |
| `POST` | `/api/v1/realtime` | Set topics for a clientId |
| `DELETE` | `/api/v1/realtime/:clientId` | Disconnect |

```js title="SSE"
const es = new EventSource("/api/v1/realtime");
es.addEventListener("connect", e => {
  const { clientId } = JSON.parse(e.data);
  fetch("/api/v1/realtime", { method: "POST",
    body: JSON.stringify({ clientId, topics: ["posts"] }) });
});
es.onmessage = e => console.log(JSON.parse(e.data));
```

## Resume & delivery

SSE events carry an `id:` (a global sequence number). On reconnect the browser automatically sends `Last-Event-ID` and Cogworks replays the events you missed — filtered by your topics and rules, in order, with no gaps or duplicates.

```http title="Reconnect with replay"
GET /api/v1/realtime
Last-Event-ID: 4211
# non-browser clients can use ?lastEventId=4211
```

:::note[Retention]
The replay buffer holds `realtime.retention_sec` seconds of events (default 30). A client that reconnects within that window resumes cleanly; beyond it, refetch. Connections are gated by `cors.origins` — a browser `Origin` must be allowlisted; non-browser clients (no Origin) are allowed.
:::

:::caution[SSE replay fires on the topic POST, not the reconnect]
Because SSE topics arrive over the companion `POST /api/v1/realtime`, replay happens when you re-send that POST after reconnecting — a bare stream reopen replays nothing. Replay is re-filtered against your current topics + rules (it never leaks a row you couldn't see live) and is capped at 1000 events per resume. The stream also emits a `: ping` comment every 30 s to defeat idle-proxy timeouts.
:::

## Presence

Presence tracks **who is currently on a channel** and the ephemeral state each connection shares — typing indicators, cursor positions, "online" dots. A _channel_ is any string you choose (`room:42`, `doc:abc`). State lives only while the connection does: when a client disconnects, everyone else on the channel is told it left. It is backed by SQLite, so presence is correct across cluster workers with no extra setup.

```js title="Track your presence (WebSocket)"
// announce yourself on a channel — also subscribes you to its updates
ws.send(JSON.stringify({
  type: "presence-track",
  channel: "room:42",
  key: "alice",          // optional; defaults to your auth id, else connection id
  state: { typing: true }  // any JSON, ≤ 4 KB
}));

// update = send presence-track again with new state · leave one channel:
ws.send(JSON.stringify({ type: "presence-untrack", channel: "room:42" }));

// observe without appearing (get the snapshot + future events):
ws.send(JSON.stringify({ type: "presence-state", channel: "room:42" }));
```

Tracking or requesting state returns a full snapshot, and every change on the channel arrives as a `presence` event. Assemble your roster from the snapshot (authoritative) plus the deltas:

```js title="Messages you receive"
// snapshot — key → array of connection metas (a key can have several tabs)
{ type: "presence-state", channel: "room:42", state: {
    "alice": [ { conn_id, key: "alice", state: { typing: true },
               identity: { id: "u_1", type: "user" }, online_at: 1751500000 } ]
} }

// deltas — event is "join" | "update" | "leave"
{ type: "presence", event: "join", channel: "room:42", meta: { conn_id, key, state, identity } }
```

The `identity` field is **set by the server** from the connection's auth (`{ id, type }`, or `null` when anonymous) — clients can't spoof who they are, even though the free-form `state` and `key` are their own. A snapshot is also available over plain HTTP, which is how [SSE](#rt-sse) observers (that can't send messages upstream) read a channel:

```http title="GET /api/v1/realtime/presence/:channel"
GET /api/v1/realtime/presence/room:42
→ { "data": { "alice": [ { …meta } ] } }
```

:::note[Ephemeral & cross-worker]
Presence is not durable — treat the snapshot as truth on every (re)connect and the events as deltas. A graceful disconnect emits `leave` immediately; a hard worker crash is cleaned up by a reaper within ~a minute (a heartbeat keeps live connections fresh). In [cluster](#ops-cluster) mode every worker sees the same presence because the state lives in the shared database, not in one process's memory.
:::
