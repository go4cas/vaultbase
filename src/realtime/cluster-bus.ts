/**
 * Cross-worker realtime fan-out over a shared SQLite table
 * (`cogworks_realtime_events`). Active ONLY under `cogworks cluster`
 * (COGWORKS_WORKER_ID set) — single-process deployments never read or write
 * the table, so this whole module is a set of no-ops there.
 *
 * Flow: a `broadcast()` on worker A delivers to A's own local subscribers AND
 * calls `publishRecord`/`publishSystem` to append the event here. Every worker
 * (incl. A) runs `startRealtimeTail`, which polls for events from OTHER workers
 * (`origin <> self`) and re-delivers them to that worker's local subscribers.
 * So a record written on any worker reaches subscribers on every worker.
 */
import type { Statement } from "bun:sqlite";
import { getRawClient } from "../db/client.ts";

const WORKER_ID = process.env.COGWORKS_WORKER_ID ?? null;

/** True when running as a cluster worker (multiple processes share the DB). */
export function isClusterWorker(): boolean {
  return WORKER_ID !== null;
}

let insertStmt: Statement | null = null;
/**
 * Append an event to the shared log and return its monotonic `seq`, or null on
 * failure. Runs in single-process too (was cluster-only): the log is now also
 * the SSE resume/replay buffer, so every broadcast is persisted — bounded by
 * `pruneRealtimeEvents`. The tail (`startRealtimeTail`) stays cluster-only.
 */
function persist(kind: "record" | "system", payload: string): number | null {
  try {
    if (!insertStmt) {
      insertStmt = getRawClient().prepare(
        `INSERT INTO cogworks_realtime_events (kind, payload, origin, created_at)
         VALUES (?, ?, ?, unixepoch())`,
      );
    }
    const res = insertStmt.run(kind, payload, WORKER_ID);
    return Number((res as unknown as { lastInsertRowid: number | bigint }).lastInsertRowid);
  } catch {
    // Best-effort: realtime is not durable. A dropped event just isn't replayable.
    insertStmt = null; // force re-prepare next time (e.g. after a DB reinit)
    return null;
  }
}

export function publishRecord(collection: string, event: unknown, opts: unknown): number | null {
  return persist("record", JSON.stringify({ collection, event, opts: opts ?? null }));
}

export function publishSystem(topic: string, message: unknown): number | null {
  return persist("system", JSON.stringify({ topic, message }));
}

/** Current max event seq (0 if none) — the replay upper bound captured pre-subscribe. */
export function maxEventSeq(): number {
  try {
    const row = getRawClient()
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM cogworks_realtime_events`)
      .get() as { m: number } | undefined;
    return row?.m ?? 0;
  } catch {
    return 0;
  }
}

/** Persisted events in `(since, upTo]` for replay, oldest first. Capped. */
export function readEventsSince(
  since: number,
  upTo: number,
  limit = 1000,
): Array<{ seq: number; kind: string; payload: string }> {
  try {
    return getRawClient()
      .prepare(
        `SELECT seq, kind, payload FROM cogworks_realtime_events
         WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
      )
      .all(since, upTo, limit) as Array<{ seq: number; kind: string; payload: string }>;
  } catch {
    return [];
  }
}

export interface TailHandlers {
  onRecord(collection: string, event: unknown, opts: unknown, seq: number): void;
  onSystem(topic: string, message: unknown, seq: number): void;
}

const POLL_MS = 200;
let tailTimer: ReturnType<typeof setInterval> | null = null;
let lastSeq = 0;

/**
 * Start the tail loop (idempotent, no-op in single-process mode). Polls for
 * events from other workers and hands each to the local delivery handlers.
 */
export function startRealtimeTail(handlers: TailHandlers): void {
  if (WORKER_ID === null || tailTimer) return;
  const db = getRawClient();
  // A respawned worker must not replay history — start after the current max.
  try {
    const row = db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM cogworks_realtime_events`)
      .get() as { m: number } | undefined;
    lastSeq = row?.m ?? 0;
  } catch {
    lastSeq = 0;
  }
  const sel = db.prepare(
    `SELECT seq, kind, payload FROM cogworks_realtime_events
     WHERE seq > ? AND origin <> ? ORDER BY seq LIMIT 500`,
  );
  tailTimer = setInterval(() => {
    try {
      const rows = sel.all(lastSeq, WORKER_ID) as Array<{
        seq: number;
        kind: string;
        payload: string;
      }>;
      for (const r of rows) {
        lastSeq = r.seq;
        try {
          const data = JSON.parse(r.payload) as Record<string, unknown>;
          if (r.kind === "record") {
            handlers.onRecord(data.collection as string, data.event, data.opts ?? undefined, r.seq);
          } else if (r.kind === "system") {
            handlers.onSystem(data.topic as string, data.message, r.seq);
          }
        } catch {
          /* skip a malformed row */
        }
      }
    } catch {
      /* transient DB error — retry next tick */
    }
  }, POLL_MS);
  tailTimer.unref?.();
}

export function stopRealtimeTail(): void {
  if (tailTimer) {
    clearInterval(tailTimer);
    tailTimer = null;
  }
}

/**
 * Drop the cached insert statement + tail cursor. Call after the DB is
 * re-initialized (e.g. a restore, or between tests) — a prepared statement
 * bound to a closed Database throws on first reuse, which would otherwise lose
 * one event before `persist` re-prepares against the new connection.
 */
export function resetRealtimeBus(): void {
  insertStmt = null;
  lastSeq = 0;
  stopRealtimeTail();
}

/** Delete events older than `retentionSec`. Runs in single-process too now that
 * the log doubles as the SSE replay buffer (bounds table growth). */
export function pruneRealtimeEvents(retentionSec = 30): number {
  try {
    const res = getRawClient()
      .prepare(`DELETE FROM cogworks_realtime_events WHERE created_at < unixepoch() - ?`)
      .run(retentionSec);
    return (res as unknown as { changes?: number }).changes ?? 0;
  } catch {
    return 0;
  }
}
