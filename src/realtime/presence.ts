/**
 * Realtime presence — ephemeral "who's here + what are they doing" on a named
 * channel (Supabase-style). Backed by the `cogworks_presence` table so it is
 * correct across cluster workers with no extra plumbing: the table is the source
 * of truth, and every change is fanned out as a `broadcastSystem` message on the
 * channel's presence topic (which already delivers locally + cross-worker via the
 * realtime tail).
 *
 * Lifecycle:
 *   - `trackPresence`   — a connection announces/updates its state on a channel.
 *   - `untrackPresence` — it leaves one channel.
 *   - `dropConnPresence`— on disconnect, leave every channel it was on.
 *   - heartbeat + reaper — a live worker keeps its rows fresh; stale rows (a
 *     crashed worker's leftovers) are culled past a TTL and a `leave` is emitted.
 *
 * Not durable: presence is cleared per-worker on boot and never replayed as
 * truth — clients treat the `presence-state` snapshot as authoritative on
 * (re)connect and the join/leave/update events as deltas.
 */
import { getRawClient } from "../db/client.ts";
import { broadcastSystem } from "./manager.ts";

const WORKER_ID = process.env.COGWORKS_WORKER_ID ?? null;

/** Cap the client-supplied state blob — presence is a broadcast surface. */
const MAX_STATE_BYTES = 4096;
const MAX_CHANNEL_LEN = 128;
const HEARTBEAT_MS = 20_000;
/** Rows not refreshed within this window are treated as a dead connection. */
const TTL_SEC = 60;

export interface PresenceIdentity {
  id: string;
  type: string;
}

export interface PresenceMeta {
  conn_id: string;
  /** Grouping key — auth user id when signed in, else client-chosen, else conn id. */
  key: string;
  /** The client-supplied state payload (parsed). */
  state: unknown;
  /** Server-attached auth identity (trustworthy), or null for anonymous. */
  identity: PresenceIdentity | null;
  /** Unix seconds this entry was last seen. */
  online_at: number;
}

/** System topic a channel's presence events ride on. Clients subscribe to it. */
export function presenceTopic(channel: string): string {
  return `__presence:${channel}`;
}

function db() {
  return getRawClient();
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function emit(
  channel: string,
  event: "join" | "leave" | "update",
  meta: Partial<PresenceMeta>,
): void {
  broadcastSystem(presenceTopic(channel), { type: "presence", event, channel, meta });
}

/**
 * Announce or update a connection's presence on `channel`. Returns "join" for a
 * first appearance, "update" for a state change, or null if the input is
 * rejected (bad channel / oversize state).
 */
export function trackPresence(
  connId: string,
  channel: string,
  key: string,
  state: unknown,
  identity: PresenceIdentity | null,
): "join" | "update" | null {
  if (!channel || channel.length > MAX_CHANNEL_LEN) return null;
  const stateJson = JSON.stringify(state ?? {});
  if (stateJson.length > MAX_STATE_BYTES) return null;
  const existed = db()
    .prepare(`SELECT 1 FROM cogworks_presence WHERE channel = ? AND conn_id = ?`)
    .get(channel, connId);
  db()
    .prepare(
      `INSERT INTO cogworks_presence (channel, conn_id, key, state, identity, origin, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(channel, conn_id) DO UPDATE SET
         key = excluded.key, state = excluded.state, identity = excluded.identity, updated_at = unixepoch()`,
    )
    .run(channel, connId, key, stateJson, identity ? JSON.stringify(identity) : null, WORKER_ID);
  const event = existed ? "update" : "join";
  emit(channel, event, { conn_id: connId, key, state: state ?? {}, identity, online_at: nowSec() });
  return event;
}

/** Remove a connection's presence on one channel. Emits `leave` if it existed. */
export function untrackPresence(connId: string, channel: string): boolean {
  const row = db()
    .prepare(`SELECT key FROM cogworks_presence WHERE channel = ? AND conn_id = ?`)
    .get(channel, connId) as { key: string } | undefined;
  if (!row) return false;
  db()
    .prepare(`DELETE FROM cogworks_presence WHERE channel = ? AND conn_id = ?`)
    .run(channel, connId);
  emit(channel, "leave", { conn_id: connId, key: row.key });
  return true;
}

/** Drop ALL of a connection's presence (on disconnect). Emits `leave` per channel. */
export function dropConnPresence(connId: string): void {
  const rows = db()
    .prepare(`SELECT channel, key FROM cogworks_presence WHERE conn_id = ?`)
    .all(connId) as Array<{ channel: string; key: string }>;
  if (rows.length === 0) return;
  db().prepare(`DELETE FROM cogworks_presence WHERE conn_id = ?`).run(connId);
  for (const r of rows) emit(r.channel, "leave", { conn_id: connId, key: r.key });
}

/** Full snapshot for a channel: `key → [meta, …]` (a key may have several connections). */
export function presenceState(channel: string): Record<string, PresenceMeta[]> {
  const rows = db()
    .prepare(
      `SELECT conn_id, key, state, identity, updated_at
       FROM cogworks_presence WHERE channel = ? ORDER BY updated_at`,
    )
    .all(channel) as Array<{
    conn_id: string;
    key: string;
    state: string;
    identity: string | null;
    updated_at: number;
  }>;
  const out: Record<string, PresenceMeta[]> = {};
  for (const r of rows) {
    const meta: PresenceMeta = {
      conn_id: r.conn_id,
      key: r.key,
      state: safeParse(r.state, {}),
      identity: r.identity ? safeParse<PresenceIdentity | null>(r.identity, null) : null,
      online_at: r.updated_at,
    };
    (out[r.key] ??= []).push(meta);
  }
  return out;
}

/** Distinct presence channels with their member (key) counts, for the admin inspector. */
export function presenceChannels(): Array<{ channel: string; members: number }> {
  const rows = db()
    .prepare(
      `SELECT channel, COUNT(DISTINCT key) AS members
       FROM cogworks_presence GROUP BY channel ORDER BY members DESC, channel`,
    )
    .all() as Array<{ channel: string; members: number }>;
  return rows;
}

/** Keep this worker's rows fresh so the reaper doesn't cull live connections. */
export function heartbeatLocalPresence(): void {
  try {
    if (WORKER_ID === null) {
      db()
        .prepare(`UPDATE cogworks_presence SET updated_at = unixepoch() WHERE origin IS NULL`)
        .run();
    } else {
      db()
        .prepare(`UPDATE cogworks_presence SET updated_at = unixepoch() WHERE origin = ?`)
        .run(WORKER_ID);
    }
  } catch {
    /* transient DB error — next tick retries */
  }
}

/**
 * Cull rows not refreshed within `ttlSec` (a crashed worker's leftovers) and emit
 * a `leave` for each. Any live worker can reap another's dead rows. Duplicate
 * leaves across workers are harmless (idempotent client-side).
 */
export function reapStalePresence(ttlSec = TTL_SEC): number {
  try {
    const stale = db()
      .prepare(
        `SELECT channel, conn_id, key FROM cogworks_presence WHERE updated_at < unixepoch() - ?`,
      )
      .all(ttlSec) as Array<{ channel: string; conn_id: string; key: string }>;
    if (stale.length === 0) return 0;
    const del = db().prepare(`DELETE FROM cogworks_presence WHERE channel = ? AND conn_id = ?`);
    for (const r of stale) {
      del.run(r.channel, r.conn_id);
      emit(r.channel, "leave", { conn_id: r.conn_id, key: r.key });
    }
    return stale.length;
  } catch {
    return 0;
  }
}

/** Clear this worker's rows left over from a previous (crashed) run. Called on boot. */
export function clearWorkerPresence(): void {
  try {
    if (WORKER_ID === null) {
      db().prepare(`DELETE FROM cogworks_presence WHERE origin IS NULL`).run();
    } else {
      db().prepare(`DELETE FROM cogworks_presence WHERE origin = ?`).run(WORKER_ID);
    }
  } catch {
    /* table may not exist yet in a bare test DB — ignore */
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Boot: clear this worker's stale rows, then heartbeat + reap on an interval. */
export function startPresenceScheduler(): void {
  if (timer) return;
  clearWorkerPresence();
  timer = setInterval(() => {
    heartbeatLocalPresence();
    reapStalePresence();
  }, HEARTBEAT_MS);
  timer.unref?.();
}

export function stopPresenceScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
