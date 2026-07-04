import { and, asc, count, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { log } from "./log.ts";
import { jobsLog, workers } from "../db/schema.ts";
import { ValidationError } from "./validate.ts";
import { makeHookHelpers, type HookHelpers } from "./hooks.ts";
import { runWithTimeout, userCodeTimeoutMs } from "./user-code.ts";
import { getSetting } from "../api/settings.ts";

/**
 * In-process job queue + worker engine. Phase 1 of the Redis brainstorm —
 * works without any external dependency. Same `helpers.enqueue(...)` API
 * exposed inside hooks, custom routes, and cron jobs.
 *
 *   - Queues are virtual (just a `queue` string on a job log row).
 *   - Workers are user-supplied JS compiled via AsyncFunction (same shape
 *     as record hooks / custom routes / cron jobs).
 *   - Retry policy: per-worker `retry_max` + `retry_backoff` ("exponential"
 *     uses 2^attempt × delay_ms; "fixed" uses delay_ms each time).
 *   - Dead-letter: jobs that exhaust retries land in status="dead". They
 *     stay in the log table and can be retried via the admin UI.
 *   - Unique-key dedup: `enqueue(queue, payload, { uniqueKey })` skips if
 *     a non-finished (queued|running) job with the same key exists.
 *
 * Phase 2 will swap the in-memory parts for Redis lists + sorted sets,
 * keeping this same API.
 */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "dead";
export type RetryBackoff = "exponential" | "fixed";

export interface EnqueueOpts {
  /** Earliest run time, in seconds from now. */
  delay?: number;
  /** Skip if a non-finished job with this key already exists. */
  uniqueKey?: string;
  /** Override per-worker default retry_max for this enqueue. */
  retries?: number;
  /** Override per-worker default retry_backoff. */
  backoff?: RetryBackoff;
  /** Override per-worker default retry_delay_ms. */
  retryDelayMs?: number;
}

export interface JobContext {
  /** The enqueued payload, JSON-decoded. */
  payload: unknown;
  /** 1-indexed attempt counter (incremented on each retry). */
  attempt: number;
  /** Queue name this job came from. */
  queue: string;
  /** Job id (matches the row in cogworks_jobs_log). */
  jobId: string;
  /** Helpers shared with hooks / routes / cron. */
  helpers: HookHelpers;
}

interface CompiledWorker {
  id: string;
  name: string;
  queue: string;
  concurrency: number;
  retry_max: number;
  retry_backoff: RetryBackoff;
  retry_delay_ms: number;
  fn: (ctx: JobContext) => Promise<unknown>;
}

const compiledCache = new Map<string, CompiledWorker>(); // worker id → compiled
let cacheLoaded = false;

/**
 * Built-in workers — registered in-source rather than via an admin-edited
 * `cogworks_workers` row. Used by core features (e.g. notifications) that
 * need the queue's retry/backoff/dead-letter machinery without making the
 * operator paste boilerplate JS into the admin UI on every install.
 *
 * Precedence: any user-defined worker for the same queue wins (so an admin
 * can override a built-in by creating their own row), which is intentional
 * — built-ins are the default, not a constraint.
 */
export interface BuiltinWorkerSpec {
  queue: string;
  /** Display label used in job-log "worker" column. Default `_builtin:<queue>`. */
  name?: string;
  concurrency?: number;
  retry_max?: number;
  retry_backoff?: RetryBackoff;
  retry_delay_ms?: number;
  fn: (ctx: JobContext) => Promise<unknown>;
}

const builtinWorkers = new Map<string, CompiledWorker>(); // queue → compiled

export function registerBuiltinWorker(spec: BuiltinWorkerSpec): void {
  const id = `_builtin:${spec.queue}`;
  builtinWorkers.set(spec.queue, {
    id,
    name: spec.name ?? id,
    queue: spec.queue,
    concurrency: Math.max(1, spec.concurrency ?? 1),
    retry_max: Math.max(0, spec.retry_max ?? 5),
    retry_backoff: spec.retry_backoff === "fixed" ? "fixed" : "exponential",
    retry_delay_ms: Math.max(50, spec.retry_delay_ms ?? 2000),
    fn: spec.fn,
  });
}

/** Test-only: drop all built-in worker registrations. */
export function _resetBuiltinWorkers(): void {
  builtinWorkers.clear();
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (ctx: JobContext) => Promise<unknown>;

export function invalidateWorkerCache(): void {
  compiledCache.clear();
  cacheLoaded = false;
}

interface WorkerRow {
  id: string;
  name: string;
  queue: string;
  code: string;
  enabled: number;
  concurrency: number;
  retry_max: number;
  retry_backoff: string;
  retry_delay_ms: number;
}

function compile(row: WorkerRow): CompiledWorker | null {
  try {
    const fn = new AsyncFunction("ctx", row.code);
    return {
      id: row.id,
      name: row.name ?? "",
      queue: row.queue,
      concurrency: Math.max(1, row.concurrency),
      retry_max: Math.max(0, row.retry_max),
      retry_backoff: row.retry_backoff === "fixed" ? "fixed" : "exponential",
      retry_delay_ms: Math.max(50, row.retry_delay_ms),
      fn,
    };
  } catch (e) {
    log.error("failed to compile worker", { scope: "queues", id: row.id, err: e });
    return null;
  }
}

async function loadWorkers(): Promise<CompiledWorker[]> {
  if (cacheLoaded) return [...compiledCache.values()];
  const rows = await getDb().select().from(workers).where(eq(workers.enabled, 1));
  compiledCache.clear();
  for (const r of rows) {
    const c = compile(r as WorkerRow);
    if (c) compiledCache.set(r.id, c);
  }
  cacheLoaded = true;
  return [...compiledCache.values()];
}

/** Enqueue a job onto a named queue. Available via `helpers.enqueue(...)`. */
export async function enqueue(
  queue: string,
  payload: unknown,
  opts: EnqueueOpts = {},
): Promise<{ jobId: string; deduped: boolean }> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const scheduled_at = now + Math.max(0, opts.delay ?? 0);

  // Unique-key dedup: skip if a non-finished job with the same key exists.
  if (opts.uniqueKey) {
    const existing = await db
      .select({ id: jobsLog.id })
      .from(jobsLog)
      .where(
        and(
          eq(jobsLog.unique_key, opts.uniqueKey),
          or(eq(jobsLog.status, "queued"), eq(jobsLog.status, "running"))!,
        ),
      )
      .limit(1);
    if (existing.length > 0) return { jobId: existing[0]!.id, deduped: true };
  }

  const id = crypto.randomUUID();
  await db.insert(jobsLog).values({
    id,
    queue,
    payload: JSON.stringify(payload ?? null),
    unique_key: opts.uniqueKey ?? null,
    attempt: 1,
    status: "queued",
    scheduled_at,
    enqueued_at: now,
  });
  return { jobId: id, deduped: false };
}

// ── Worker loop ──────────────────────────────────────────────────────────────

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 500;

/**
 * Count jobs currently `running` on a queue (P1-2). Concurrency is accounted
 * from the DB, not an in-memory per-process counter, so a worker's
 * `concurrency` cap holds *globally* across cluster processes (and correctly
 * excludes jobs the reaper has reclaimed). Caveat: two processes ticking at the
 * exact same instant can each claim up to `concurrency` before either's writes
 * are visible, so the aggregate can transiently overshoot; it converges on the
 * next tick. A hard global cap would need row locking — deliberately not paid for.
 */
async function countRunning(queue: string): Promise<number> {
  const r = await getDb()
    .select({ c: count() })
    .from(jobsLog)
    .where(and(eq(jobsLog.queue, queue), eq(jobsLog.status, "running")));
  return r[0]?.c ?? 0;
}

// ── Reaper / visibility timeout (P1-1) ───────────────────────────────────────
// A worker process that crashes mid-job leaves its row in `status='running'`
// forever — nothing reclaims it, and (worse) its `unique_key` keeps blocking
// re-enqueues because dedup counts `running` as occupied. The reaper sweeps
// rows stuck `running` past a visibility timeout back to `queued` (or dead-
// letters them once retries are exhausted).
const REAP_INTERVAL_SEC = 30;
let lastReapAt = 0;

/** Visibility timeout in seconds. Keep it well above `execution.timeout_ms`. */
function visibilityTimeoutSec(): number {
  const n = parseInt(getSetting("queues.visibility_timeout_sec", "300"), 10);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

/**
 * Reclaim jobs stuck in `running` past the visibility timeout (crashed/killed
 * worker). Each reclaim re-queues for another attempt, or dead-letters once the
 * job has reached its worker's `retry_max`. The `WHERE status='running'` guard
 * makes the reclaim atomic, so concurrent cluster workers can't double-process.
 *
 * At-least-once: a job that legitimately runs longer than the visibility
 * timeout could be reclaimed and run twice — keep the timeout generously above
 * `execution.timeout_ms` (default 300s vs 5s).
 */
async function reapStuckJobs(byQueue: Map<string, CompiledWorker>): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - visibilityTimeoutSec();
  const stuck = await db
    .select()
    .from(jobsLog)
    .where(and(eq(jobsLog.status, "running"), lt(jobsLog.started_at, cutoff)));
  for (const job of stuck) {
    const retryMax = byQueue.get(job.queue)?.retry_max ?? 3;
    const guard = and(eq(jobsLog.id, job.id), eq(jobsLog.status, "running"));
    if (job.attempt >= retryMax) {
      await db
        .update(jobsLog)
        .set({
          status: "dead",
          finished_at: now,
          error: `reclaimed: stuck in 'running' past visibility timeout, retries exhausted (attempt ${job.attempt})`,
        })
        .where(guard);
      log.error("job reclaimed → dead", { scope: "queues", jobId: job.id, attempts: job.attempt });
    } else {
      await db
        .update(jobsLog)
        .set({
          status: "queued",
          attempt: job.attempt + 1,
          worker_id: null,
          started_at: null,
          scheduled_at: now,
          error: `reclaimed: stuck in 'running' past visibility timeout (attempt ${job.attempt})`,
        })
        .where(guard);
      log.warn("job reclaimed → requeued", {
        scope: "queues",
        jobId: job.id,
        attempts: job.attempt,
      });
    }
  }
}

/**
 * Start the in-process worker scheduler. Polls the jobs_log table every
 * 500ms looking for queued jobs whose scheduled_at <= now and whose queue
 * has at least one enabled worker with capacity.
 */
export function startQueueScheduler(): void {
  if (schedulerInterval) return;
  // `.catch` so a tick firing while the DB is briefly unavailable (graceful
  // shutdown / restart, or a test closing the DB) is a no-op rather than an
  // unhandled rejection that crashes the process.
  schedulerInterval = setInterval(() => {
    void tick().catch(() => {});
  }, POLL_INTERVAL_MS);
  void tick().catch(() => {});
}

export function stopQueueScheduler(): void {
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = null;
}

/**
 * One worker per queue (user-defined take precedence over builtins) — a single
 * worker per queue per tick avoids two workers grabbing the same job.
 */
async function buildQueueWorkerMap(): Promise<Map<string, CompiledWorker>> {
  const compiled = await loadWorkers();
  const byQueue = new Map<string, CompiledWorker>();
  for (const w of compiled) if (!byQueue.has(w.queue)) byQueue.set(w.queue, w);
  for (const [queue, w] of builtinWorkers) if (!byQueue.has(queue)) byQueue.set(queue, w);
  return byQueue;
}

/** Run the stuck-job reaper once, on demand (tests + a future admin action). */
export async function runReaperOnce(): Promise<void> {
  await reapStuckJobs(await buildQueueWorkerMap());
}

async function tick(): Promise<void> {
  const byQueue = await buildQueueWorkerMap();
  if (byQueue.size === 0) return;

  // Reclaim stuck jobs before claiming new ones (throttled — the sweep is a
  // rare-hit query, no need to run it every 500ms tick).
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - lastReapAt >= REAP_INTERVAL_SEC) {
    lastReapAt = nowSec;
    await reapStuckJobs(byQueue);
  }

  for (const [queue, worker] of byQueue) {
    const slots = worker.concurrency - (await countRunning(queue));
    if (slots <= 0) continue;
    await claimAndRun(queue, worker, slots);
  }
}

async function claimAndRun(queue: string, worker: CompiledWorker, slots: number): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Pull up to `slots` queued jobs whose scheduled_at has arrived.
  const pending = await db
    .select()
    .from(jobsLog)
    .where(
      and(
        eq(jobsLog.queue, queue),
        eq(jobsLog.status, "queued"),
        lt(jobsLog.scheduled_at, now + 1),
      ),
    )
    .orderBy(asc(jobsLog.scheduled_at))
    .limit(slots);

  for (const job of pending) {
    // Optimistic claim: flip status to "running" with a worker stamp. If the
    // row already changed (some other tick beat us), the WHERE clause filters
    // and we move on.
    const claim = await db
      .update(jobsLog)
      .set({ status: "running", worker_id: worker.id, started_at: now })
      .where(and(eq(jobsLog.id, job.id), eq(jobsLog.status, "queued")))
      .returning({ id: jobsLog.id });
    if (claim.length === 0) continue;

    // Fire-and-forget: runJob owns the row's terminal state (succeeded / retry /
    // dead). The DB `running` count (countRunning) is the concurrency ledger, so
    // there's no in-memory counter to maintain. `.catch` guards against an
    // unexpected throw escaping the async task as an unhandled rejection.
    void runJob(worker, job).catch(() => {});
  }
}

async function runJob(worker: CompiledWorker, job: typeof jobsLog.$inferSelect): Promise<void> {
  const db = getDb();
  const helpers = makeHookHelpers({ name: worker.name });
  let payload: unknown = null;
  try {
    payload = JSON.parse(job.payload);
  } catch {
    payload = null;
  }

  const ctx: JobContext = {
    payload,
    attempt: job.attempt,
    queue: job.queue,
    jobId: job.id,
    helpers,
  };

  const finishedAt = (): number => Math.floor(Date.now() / 1000);
  try {
    await runWithTimeout(
      () => worker.fn(ctx),
      userCodeTimeoutMs(),
      `worker '${worker.name || worker.queue}' (job ${job.id})`,
    );
    await db
      .update(jobsLog)
      .set({
        status: "succeeded",
        finished_at: finishedAt(),
        error: null,
      })
      .where(eq(jobsLog.id, job.id));
  } catch (e) {
    const msg =
      e instanceof ValidationError
        ? `ValidationError: ${e.message}`
        : e instanceof Error
          ? (e.stack ?? e.message)
          : String(e);
    const willRetry = job.attempt < worker.retry_max;
    if (willRetry) {
      const delayMs =
        worker.retry_backoff === "exponential"
          ? worker.retry_delay_ms * 2 ** (job.attempt - 1)
          : worker.retry_delay_ms;
      const next = Math.floor((Date.now() + delayMs) / 1000);
      // Re-queue: bump attempt, set status back to queued with a fresh
      // schedule. Keeping the same row preserves the audit trail; a fresh
      // row would lose the retry chain.
      await db
        .update(jobsLog)
        .set({
          status: "queued",
          attempt: job.attempt + 1,
          worker_id: null,
          started_at: null,
          scheduled_at: next,
          error: msg,
        })
        .where(eq(jobsLog.id, job.id));
    } else {
      await db
        .update(jobsLog)
        .set({
          status: "dead",
          finished_at: finishedAt(),
          error: msg,
        })
        .where(eq(jobsLog.id, job.id));
      log.error("job dead", { scope: "queues", jobId: job.id, attempts: job.attempt, reason: msg });
    }
  }
}

// ── Admin operations ────────────────────────────────────────────────────────

/** Manually retry a previously-failed/dead job. Resets attempt counter to 1. */
export async function retryJob(id: string): Promise<boolean> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const r = await db
    .update(jobsLog)
    .set({
      status: "queued",
      attempt: 1,
      scheduled_at: now,
      started_at: null,
      finished_at: null,
      error: null,
      worker_id: null,
    })
    .where(and(eq(jobsLog.id, id), inArray(jobsLog.status, ["failed", "dead", "succeeded"])))
    .returning({ id: jobsLog.id });
  return r.length > 0;
}

/**
 * Bulk dead-letter replay (E-12): re-queue every `dead` job, optionally scoped
 * to one queue. Resets the attempt counter so each gets a fresh retry budget.
 * Returns the number re-queued.
 */
export async function retryDeadJobs(queue?: string): Promise<number> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const where = queue
    ? and(eq(jobsLog.status, "dead"), eq(jobsLog.queue, queue))
    : eq(jobsLog.status, "dead");
  const r = await db
    .update(jobsLog)
    .set({
      status: "queued",
      attempt: 1,
      scheduled_at: now,
      started_at: null,
      finished_at: null,
      error: null,
      worker_id: null,
    })
    .where(where)
    .returning({ id: jobsLog.id });
  return r.length;
}

/** Drop a job (typically a stuck "queued" or noisy "dead"). */
export async function discardJob(id: string): Promise<boolean> {
  const db = getDb();
  const r = await db
    .delete(jobsLog)
    .where(
      and(
        eq(jobsLog.id, id),
        or(eq(jobsLog.status, "queued"), eq(jobsLog.status, "dead"), eq(jobsLog.status, "failed"))!,
      ),
    )
    .returning({ id: jobsLog.id });
  return r.length > 0;
}

export interface JobsLogQuery {
  queue?: string;
  status?: JobStatus;
  worker_id?: string;
  page?: number;
  perPage?: number;
}

export async function listJobsLog(opts: JobsLogQuery = {}) {
  const db = getDb();
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.min(200, Math.max(1, opts.perPage ?? 50));

  const conds = [];
  if (opts.queue) conds.push(eq(jobsLog.queue, opts.queue));
  if (opts.status) conds.push(eq(jobsLog.status, opts.status));
  if (opts.worker_id) conds.push(eq(jobsLog.worker_id, opts.worker_id));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const rows = await db
    .select()
    .from(jobsLog)
    .where(where)
    .orderBy(desc(jobsLog.enqueued_at))
    .limit(perPage)
    .offset((page - 1) * perPage);
  return { data: rows, page, perPage };
}

/**
 * Dashboard counts per queue. Single SELECT with COUNT(... CASE ...) so the
 * jobs page can render cards without a roundtrip per status.
 */
export async function queueStats(): Promise<
  Array<{
    queue: string;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    dead: number;
  }>
> {
  const db = getDb();
  const all = await db.select().from(jobsLog);
  const map = new Map<
    string,
    {
      queue: string;
      queued: number;
      running: number;
      succeeded: number;
      failed: number;
      dead: number;
    }
  >();
  for (const j of all) {
    const k = j.queue;
    if (!map.has(k))
      map.set(k, { queue: k, queued: 0, running: 0, succeeded: 0, failed: 0, dead: 0 });
    const e = map.get(k)!;
    if (j.status === "queued") e.queued++;
    if (j.status === "running") e.running++;
    if (j.status === "succeeded") e.succeeded++;
    if (j.status === "failed") e.failed++;
    if (j.status === "dead") e.dead++;
  }
  // Workers may exist with zero jobs yet — surface their queues so admins see them.
  const all_workers = await db.select({ queue: workers.queue }).from(workers);
  for (const w of all_workers) {
    if (!map.has(w.queue))
      map.set(w.queue, { queue: w.queue, queued: 0, running: 0, succeeded: 0, failed: 0, dead: 0 });
  }
  return [...map.values()].sort((a, b) => a.queue.localeCompare(b.queue));
}

// Avoid unused-import warning when no scheduled-job logic uses `isNull`.
void isNull;
