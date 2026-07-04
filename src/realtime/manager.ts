import type { RecordWithMeta } from "../core/records.ts";
import { evaluateRule, evaluateExpression, type AuthContext } from "../core/rules.ts";
import { publishRecord, publishSystem, maxEventSeq, readEventsSince } from "./cluster-bus.ts";

export interface WSLike {
  /** `id` (optional) is the event's global seq — SSE emits it as `id:` for resume. */
  send(data: string, id?: number): void;
}

export type RealtimeEvent =
  | { type: "connected" }
  | { type: "create"; collection: string; record: RecordWithMeta }
  | { type: "update"; collection: string; record: RecordWithMeta }
  | { type: "delete"; collection: string; id: string };

/** Auth context attached to a WS connection (used for per-record view_rule filtering at broadcast time). */
export interface WSAuth {
  id: string;
  type: "user" | "admin";
  email?: string;
}

/**
 * Optional context passed by record-mutating callers so broadcast can enforce
 * each subscriber's `view_rule` before fanning out.
 *
 *   - `viewRule = undefined`     → no filtering (back-compat — any caller that
 *                                  doesn't pass this gets the legacy behavior)
 *   - `viewRule = null`          → public — every subscriber gets the event
 *   - `viewRule = ""`            → admin-only — non-admin subscribers skipped
 *   - expression                 → evaluated per-subscriber against `record`
 *
 * For delete events, pass the just-deleted record so the rule still has fields
 * to evaluate against (the row is gone in the DB by the time we broadcast).
 */
export interface BroadcastOpts {
  viewRule?: string | null;
  record?: Record<string, unknown> | null;
}

const WILDCARD = "*";

/**
 * Topic strings:
 *   - "<collection>"          → all events for the collection
 *   - "<collection>/<id>"     → events for one specific record
 *   - "*"                     → every event everywhere
 *
 * Storage is keyed by **connection id** (string), not by `WSLike` object
 * identity. Bun/Elysia can hand you a different wrapper per handler call
 * (one for `open`, another for `message`); using `===` for membership
 * misbehaves — subscribe stored wrapper A, unsubscribe looked up wrapper B,
 * cross-call mutation silently dropped. The id is minted at connect time
 * and stashed in Bun's persistent `ws.data` slot.
 *
 * The inner Map maps connId → adapter so broadcast can still call .send()
 * via the wrapper that's currently live. Whichever wrapper subscribed last
 * "wins" — the most recent send target is what fires.
 */
const subs = new Map<string, Map<string, WSLike>>();
const wsAuth = new Map<string, WSAuth>();
/**
 * Per-connection subscription filters (E-2): connId → topic → filter expression.
 * When set, an event is delivered to that (connection, topic) only if the filter
 * also matches the record — AND-combined with the collection's `view_rule`.
 * Unlike a view rule, this is the client's own preference, so admins are NOT
 * exempt from it.
 */
const subFilters = new Map<string, Map<string, string>>();

/** Pull the persistent connection id off `ws.data` (set by the WS open handler). */
function connId(ws: WSLike): string {
  const id = (ws as unknown as { data?: { connId?: string } }).data?.connId;
  if (typeof id !== "string")
    throw new Error("realtime: ws.data.connId missing — open handler must mint one");
  return id;
}

export function setWSAuth(ws: WSLike, auth: WSAuth | null): void {
  const id = connId(ws);
  if (auth) wsAuth.set(id, auth);
  else wsAuth.delete(id);
}

export function getWSAuth(ws: WSLike): WSAuth | undefined {
  return wsAuth.get(connId(ws));
}

/**
 * Canonicalise a topic string. The internal store keys are:
 *
 *   <collection>                 every event for the collection
 *   <collection>/<id>            events for one specific record
 *   <collection>.<event-type>    only that event-type (create / update / delete)
 *   *                            every event everywhere
 *   *.<event-type>               that event-type globally
 *
 * Ergonomic synonyms we collapse:
 *
 *   <collection>.*  → <collection>     (dotted-wildcard)
 *   <collection>/*  → <collection>     (slashed-wildcard)
 *
 * Symmetric — applied by both subscribe + unsubscribe so the two halves
 * always agree on the storage key. Returns `null` on empty input.
 */
const EVENT_KINDS = new Set(["create", "update", "delete"]);

export function normalizeTopic(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  if (t === "*") return "*";
  if (t.endsWith(".*")) return t.slice(0, -2) || null;
  if (t.endsWith("/*")) return t.slice(0, -2) || null;
  // `<base>.<event-type>` — keep verbatim only when the suffix is a
  // known event kind. Anything else stays as-is for legacy callers.
  const dot = t.lastIndexOf(".");
  if (dot > 0) {
    const suffix = t.slice(dot + 1);
    if (EVENT_KINDS.has(suffix)) return t; // canonical event-typed form
  }
  return t;
}

export function subscribe(ws: WSLike, topics: string[], filter?: string): string[] {
  const id = connId(ws);
  const accepted: string[] = [];
  const f = typeof filter === "string" && filter.trim() ? filter.trim() : null;
  for (const raw of topics) {
    const t = normalizeTopic(raw);
    if (!t) continue;
    let inner = subs.get(t);
    if (!inner) {
      inner = new Map();
      subs.set(t, inner);
    }
    inner.set(id, ws);
    accepted.push(t);
    // Attach (or clear) this connection's filter for the topic.
    if (f) {
      let fm = subFilters.get(id);
      if (!fm) {
        fm = new Map();
        subFilters.set(id, fm);
      }
      fm.set(t, f);
    } else {
      subFilters.get(id)?.delete(t);
    }
  }
  return accepted;
}

export function unsubscribe(ws: WSLike, topics: string[]): string[] {
  const id = connId(ws);
  const removed: string[] = [];
  for (const raw of topics) {
    const t = normalizeTopic(raw);
    if (!t) continue;
    if (subs.get(t)?.delete(id)) removed.push(t);
    subFilters.get(id)?.delete(t);
  }
  return removed;
}

/** Every topic this WS is currently subscribed to. Cheap introspection for debugging. */
export function listSubsFor(ws: WSLike): string[] {
  const id = connId(ws);
  const out: string[] = [];
  for (const [topic, inner] of subs.entries()) {
    if (inner.has(id)) out.push(topic);
  }
  out.sort();
  return out;
}

export function disconnectAll(ws: WSLike): void {
  const id = connId(ws);
  for (const inner of subs.values()) {
    inner.delete(id);
  }
  wsAuth.delete(id);
  subFilters.delete(id);
}

/**
 * Returns true when `ws` should receive this broadcast under the given
 * filtering context. Admin connections always pass. When no `viewRule` is
 * supplied, everyone passes (back-compat). When supplied, behavior matches
 * the records HTTP `view_rule` semantics.
 */
function shouldSendTo(id: string, opts?: BroadcastOpts): boolean {
  if (!opts || opts.viewRule === undefined) return true;
  const auth = wsAuth.get(id);
  if (auth?.type === "admin") return true;
  const rule = opts.viewRule;
  if (rule === null) return true; // public
  if (rule === "") return false; // admin only
  const ctx: AuthContext | null = auth
    ? { id: auth.id, type: auth.type, ...(auth.email ? { email: auth.email } : {}) }
    : null;
  return evaluateRule(rule, ctx, opts.record ?? null);
}

/**
 * E-2: apply this connection's optional subscription filter for `topic`. Returns
 * true when there's no filter, no record to test, or the filter matches. Admins
 * are NOT exempt — the filter is the client's own choice, not access control.
 */
function passesSubFilter(id: string, topic: string, opts?: BroadcastOpts): boolean {
  const f = subFilters.get(id)?.get(topic);
  if (!f) return true;
  const record = opts?.record;
  if (!record) return true; // nothing to evaluate against
  const auth = wsAuth.get(id);
  const ctx: AuthContext | null = auth
    ? { id: auth.id, type: auth.type, ...(auth.email ? { email: auth.email } : {}) }
    : null;
  return evaluateExpression(f, ctx, record);
}

/**
 * Broadcast a record event: deliver to THIS worker's local subscribers and,
 * under cluster mode, publish it so sibling workers deliver to theirs too.
 * `opts.viewRule`/`opts.record` are JSON-serializable, so cross-worker delivery
 * still filters per-subscriber on each worker.
 */
export function broadcast(collection: string, event: RealtimeEvent, opts?: BroadcastOpts): void {
  // Persist first to obtain the event's global seq, then deliver locally with it
  // (so SSE clients get an `id:` for resume). Other workers deliver via the tail
  // with the same seq. `?? undefined`: a failed persist just omits the id.
  const seq = publishRecord(collection, event, opts) ?? undefined;
  deliverRecordLocal(collection, event, opts, seq);
}

/** Topics a record event fans out to (shared by live delivery + resume replay). */
function recordEventTargets(collection: string, event: RealtimeEvent): string[] {
  const targets = [
    collection,
    WILDCARD,
    `${collection}.${event.type}`,
    `${WILDCARD}.${event.type}`,
  ];
  if (event.type === "create" || event.type === "update") {
    targets.push(`${collection}/${event.record.id}`);
  } else if (event.type === "delete") {
    targets.push(`${collection}/${event.id}`);
  }
  return targets;
}

/**
 * Deliver a record event to subscribers ON THIS WORKER ONLY. Sends to
 * subscribers of `<collection>`, `<collection>/<id>` (when the event has a
 * record id), and the wildcard `*` topic — fans out with per-id dedup. When the
 * caller passes `opts.viewRule` (and `opts.record` for the eval target), each
 * subscriber's auth is checked against the rule and non-matching connections are
 * skipped silently. Called directly by the cluster tail for events from siblings.
 */
export function deliverRecordLocal(
  collection: string,
  event: RealtimeEvent,
  opts?: BroadcastOpts,
  seq?: number,
): void {
  const targets = recordEventTargets(collection, event);
  const payload = JSON.stringify(event);
  // Dedup: a connection subscribed to both "posts" and "*" should still receive
  // the event once.
  const sent = new Set<string>();
  for (const topic of targets) {
    if (!topic) continue;
    const inner = subs.get(topic);
    if (!inner) continue;
    for (const [id, ws] of inner) {
      if (sent.has(id)) continue;
      if (!shouldSendTo(id, opts)) continue;
      // E-2: a per-topic filter that rejects this record must NOT block delivery
      // via another matching topic (e.g. a `*` subscription), so only mark the
      // connection `sent` once it actually receives the event.
      if (!passesSubFilter(id, topic, opts)) continue;
      sent.add(id);
      try {
        ws.send(payload, seq);
      } catch {
        inner.delete(id);
      }
    }
  }
}

/**
 * Fan out an arbitrary system message to subscribers of `topic`. Unlike
 * `broadcast()`, this isn't tied to a record event — used for flag deltas,
 * settings hot-reload notices, and similar admin signals. Topic naming
 * convention: leading double underscore (e.g. `__flags`) so it can't
 * collide with a user-defined collection. Cross-worker under cluster mode.
 */
export function broadcastSystem(topic: string, message: object): void {
  const seq = publishSystem(topic, message) ?? undefined;
  deliverSystemLocal(topic, message, seq);
}

/** Deliver a system message to subscribers of `topic` ON THIS WORKER ONLY. */
export function deliverSystemLocal(topic: string, message: object, seq?: number): void {
  const inner = subs.get(topic);
  if (!inner) return;
  const payload = JSON.stringify(message);
  for (const [id, ws] of inner) {
    try {
      ws.send(payload, seq);
    } catch {
      inner.delete(id);
    }
  }
}

// ── SSE client registry ─────────────────────────────────────────────────────
// SSE is one-directional (server → client). Subscriptions can't ride on the
// same stream the way they do over WebSocket, so we mint a `clientId` per SSE
// connection and let clients pair it with `POST /api/v1/realtime` to set their
// topic list. Same `WSLike` interface backs both transports — broadcast logic
// doesn't need to know which one a subscriber is on.

const sseClients = new Map<string, WSLike>();

export function registerSSEClient(clientId: string, adapter: WSLike, lastEventId?: number): void {
  // Mirror the WS contract: every adapter must carry a stable `data.connId`
  // so subscribe / unsubscribe / disconnectAll have a real key. SSE adapters
  // typically don't carry `data`, so we attach it here.
  const a = adapter as unknown as { data?: { connId?: string; replaySince?: number } };
  if (!a.data || typeof a.data !== "object") a.data = { connId: clientId };
  else if (typeof a.data.connId !== "string") a.data.connId = clientId;
  // Reconnect with `Last-Event-ID` → replay from there once the client (re)sets
  // its topics (SSE subscriptions arrive on a separate POST).
  if (typeof lastEventId === "number" && lastEventId >= 0) a.data.replaySince = lastEventId;
  sseClients.set(clientId, adapter);
}

export function getSSEClient(clientId: string): WSLike | undefined {
  return sseClients.get(clientId);
}

/** Drop the client + remove from every topic + clear stored auth. */
export function unregisterSSEClient(clientId: string): void {
  const adapter = sseClients.get(clientId);
  if (!adapter) return;
  disconnectAll(adapter);
  sseClients.delete(clientId);
}

/** Replace the client's topic list (PocketBase-style: PUT semantics). */
export function setSSESubscriptions(clientId: string, topics: string[], filter?: string): boolean {
  const adapter = sseClients.get(clientId);
  if (!adapter) return false;
  const id = connId(adapter);
  const data = (adapter as unknown as { data?: { replaySince?: number } }).data;
  // Capture the replay upper bound BEFORE subscribing so live events (seq >
  // upTo) are strictly newer than anything replayed → no dup, no gap.
  const replayUpTo = maxEventSeq();
  // Remove from every topic (and clear stale filters), then re-add the new set.
  for (const inner of subs.values()) inner.delete(id);
  subFilters.delete(id);
  subscribe(adapter, topics, filter);
  // On a resumed connection, replay the missed window once against the new topics.
  if (data && typeof data.replaySince === "number") {
    const since = data.replaySince;
    delete data.replaySince; // replay only once per reconnect
    replayToClient(adapter, topics, since, replayUpTo);
  }
  return true;
}

/**
 * Replay persisted events in `(since, upTo]` that match `topics` to a single
 * client, oldest first, each tagged with its seq. Re-applies the same topic +
 * view_rule filtering as live delivery so a resume never leaks a row the client
 * couldn't see live.
 */
function replayToClient(adapter: WSLike, topics: string[], since: number, upTo: number): void {
  if (upTo <= since) return;
  const topicSet = new Set(
    topics.map((t) => normalizeTopic(t)).filter((t): t is string => t !== null),
  );
  if (topicSet.size === 0) return;
  const id = connId(adapter);
  for (const r of readEventsSince(since, upTo)) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    try {
      if (r.kind === "record") {
        const event = data.event as RealtimeEvent;
        const collection = data.collection as string;
        const opts = (data.opts ?? undefined) as BroadcastOpts | undefined;
        const matched = recordEventTargets(collection, event).filter(
          (t): t is string => !!t && topicSet.has(t),
        );
        if (matched.length === 0) continue;
        if (!shouldSendTo(id, opts)) continue;
        // E-2: deliver on resume only if at least one matched topic's filter passes.
        if (!matched.some((t) => passesSubFilter(id, t, opts))) continue;
        adapter.send(JSON.stringify(event), r.seq);
      } else if (r.kind === "system") {
        if (!topicSet.has(data.topic as string)) continue;
        adapter.send(JSON.stringify(data.message), r.seq);
      }
    } catch {
      /* client vanished mid-replay — stop quietly */
      break;
    }
  }
}

export function _reset(): void {
  subs.clear();
  sseClients.clear();
}
