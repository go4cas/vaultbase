/**
 * P1-1 queue reaper / visibility timeout. A worker that crashes mid-job leaves
 * its row stuck in `status='running'` forever — nothing reclaims it, and its
 * `unique_key` keeps blocking re-enqueues (dedup counts running as occupied).
 * The reaper sweeps rows stuck past the visibility timeout back to `queued`,
 * or dead-letters them once retries are exhausted.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { jobsLog } from "../db/schema.ts";
import { setSetting } from "../api/settings.ts";
import { enqueue, runReaperOnce, retryDeadJobs } from "../core/queues.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cogworks-reaper-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
});
afterEach(() => {
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* swallow */
  }
});

/** Seed a `running` job with a chosen age + attempt, mimicking a crashed worker. */
async function stuckJob(opts: { startedSecondsAgo: number; attempt?: number; uniqueKey?: string }) {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(jobsLog)
    .values({
      id,
      queue: "emails",
      payload: "{}",
      unique_key: opts.uniqueKey ?? null,
      attempt: opts.attempt ?? 1,
      status: "running",
      worker_id: "w1",
      scheduled_at: now - opts.startedSecondsAgo,
      enqueued_at: now - opts.startedSecondsAgo,
      started_at: now - opts.startedSecondsAgo,
    });
  return id;
}

const row = async (id: string) =>
  (await getDb().select().from(jobsLog).where(eq(jobsLog.id, id)).limit(1))[0];

describe("queue reaper", () => {
  it("re-queues a job stuck in 'running' past the visibility timeout", async () => {
    setSetting("queues.visibility_timeout_sec", "60");
    const id = await stuckJob({ startedSecondsAgo: 120, attempt: 1 });
    await runReaperOnce();
    const r = await row(id);
    expect(r?.status).toBe("queued");
    expect(r?.attempt).toBe(2); // reclaim counts as an attempt
    expect(r?.worker_id).toBeNull();
    expect(r?.started_at).toBeNull();
  });

  it("leaves a freshly-running job alone (within the timeout)", async () => {
    setSetting("queues.visibility_timeout_sec", "300");
    const id = await stuckJob({ startedSecondsAgo: 5 });
    await runReaperOnce();
    expect((await row(id))?.status).toBe("running");
  });

  it("dead-letters a stuck job that has exhausted retries", async () => {
    setSetting("queues.visibility_timeout_sec", "60");
    // Default retry_max for a queue with no worker is 3; attempt 3 is exhausted.
    const id = await stuckJob({ startedSecondsAgo: 120, attempt: 3 });
    await runReaperOnce();
    expect((await row(id))?.status).toBe("dead");
  });

  it("unblocks a unique_key held by a dead job", async () => {
    setSetting("queues.visibility_timeout_sec", "60");
    // A stuck running job holds unique_key "welcome-42": a fresh enqueue dedupes to it.
    const stuck = await stuckJob({ startedSecondsAgo: 120, uniqueKey: "welcome-42" });
    const before = await enqueue("emails", { x: 1 }, { uniqueKey: "welcome-42" });
    expect(before.deduped).toBe(true);
    expect(before.jobId).toBe(stuck);

    // After reaping it returns to 'queued' — still the same job, but now it will
    // actually be processed (and its key frees when it finishes) instead of being
    // wedged in 'running' forever.
    await runReaperOnce();
    expect((await row(stuck))?.status).toBe("queued");
  });
});

/** Seed a `dead` job on a queue. */
async function deadJob(queue: string) {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(jobsLog).values({
    id,
    queue,
    payload: "{}",
    attempt: 3,
    status: "dead",
    error: "boom",
    scheduled_at: now,
    enqueued_at: now,
    finished_at: now,
  });
  return id;
}

describe("retryDeadJobs (E-12 bulk dead-letter replay)", () => {
  it("re-queues all dead jobs, or just one queue's when scoped", async () => {
    const a = await deadJob("emails");
    const b = await deadJob("emails");
    const c = await deadJob("other");

    const scoped = await retryDeadJobs("emails");
    expect(scoped).toBe(2);
    expect((await row(a))?.status).toBe("queued");
    expect((await row(a))?.attempt).toBe(1); // fresh retry budget
    expect((await row(c))?.status).toBe("dead"); // other queue untouched

    const all = await retryDeadJobs();
    expect(all).toBe(1); // only `c` was still dead
    expect((await row(c))?.status).toBe("queued");
    expect((await row(b))?.status).toBe("queued");
  });
});
