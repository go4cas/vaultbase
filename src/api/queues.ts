import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import { getDb } from "../db/client.ts";
import { workers } from "../db/schema.ts";
import {
  invalidateWorkerCache,
  listJobsLog,
  retryJob,
  retryDeadJobs,
  discardJob,
  queueStats,
  type JobStatus,
} from "../core/queues.ts";
import { requireAdmin } from "../core/sec.ts";

const VALID_BACKOFF = new Set(["exponential", "fixed"]);
const VALID_STATUS = new Set<JobStatus>(["queued", "running", "succeeded", "failed", "dead"]);

function validateQueueName(q: string): string | null {
  if (!q?.trim()) return "queue is required";
  if (!/^[a-zA-Z0-9_:-]+$/.test(q)) return "queue must match [a-zA-Z0-9_:-]+";
  return null;
}

export function makeQueuesPlugin(jwtSecret: string) {
  return (
    new Hono()
      .get("/admin/workers", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const rows = await getDb().select().from(workers);
        return c.json({ data: rows });
      })

      .post(
        "/admin/workers",
        jsonBody(
          t.Object({
            name: t.Optional(t.String()),
            queue: t.String(),
            code: t.Optional(t.String()),
            enabled: t.Optional(t.Boolean()),
            concurrency: t.Optional(t.Number()),
            retry_max: t.Optional(t.Number()),
            retry_backoff: t.Optional(t.String()),
            retry_delay_ms: t.Optional(t.Number()),
          }),
        ),
        async (c) => {
          if (!(await requireAdmin(c.req.raw, jwtSecret))) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const body = c.req.valid("json");
          const qErr = validateQueueName(body.queue);
          if (qErr) {
            return c.json({ error: qErr, code: 422 }, 422);
          }
          const backoff = body.retry_backoff ?? "exponential";
          if (!VALID_BACKOFF.has(backoff)) {
            return c.json({ error: `retry_backoff must be exponential|fixed`, code: 422 }, 422);
          }
          const id = crypto.randomUUID();
          const now = Math.floor(Date.now() / 1000);
          await getDb()
            .insert(workers)
            .values({
              id,
              name: body.name ?? "",
              queue: body.queue,
              code: body.code ?? "",
              enabled: body.enabled === false ? 0 : 1,
              concurrency: Math.max(1, body.concurrency ?? 1),
              retry_max: Math.max(0, body.retry_max ?? 3),
              retry_backoff: backoff,
              retry_delay_ms: Math.max(50, body.retry_delay_ms ?? 1000),
              created_at: now,
              updated_at: now,
            });
          invalidateWorkerCache();
          const row = await getDb().select().from(workers).where(eq(workers.id, id)).limit(1);
          return c.json({ data: row[0] });
        },
      )

      .patch(
        "/admin/workers/:id",
        jsonBody(
          t.Object({
            name: t.Optional(t.String()),
            queue: t.Optional(t.String()),
            code: t.Optional(t.String()),
            enabled: t.Optional(t.Boolean()),
            concurrency: t.Optional(t.Number()),
            retry_max: t.Optional(t.Number()),
            retry_backoff: t.Optional(t.String()),
            retry_delay_ms: t.Optional(t.Number()),
          }),
        ),
        async (c) => {
          if (!(await requireAdmin(c.req.raw, jwtSecret))) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const body = c.req.valid("json");
          const update: Record<string, unknown> = { updated_at: Math.floor(Date.now() / 1000) };
          if (body.name !== undefined) update.name = body.name;
          if (body.queue !== undefined) {
            const qErr = validateQueueName(body.queue);
            if (qErr) {
              return c.json({ error: qErr, code: 422 }, 422);
            }
            update.queue = body.queue;
          }
          if (body.code !== undefined) update.code = body.code;
          if (body.enabled !== undefined) update.enabled = body.enabled ? 1 : 0;
          if (body.concurrency !== undefined) update.concurrency = Math.max(1, body.concurrency);
          if (body.retry_max !== undefined) update.retry_max = Math.max(0, body.retry_max);
          if (body.retry_backoff !== undefined) {
            if (!VALID_BACKOFF.has(body.retry_backoff)) {
              return c.json({ error: `retry_backoff must be exponential|fixed`, code: 422 }, 422);
            }
            update.retry_backoff = body.retry_backoff;
          }
          if (body.retry_delay_ms !== undefined)
            update.retry_delay_ms = Math.max(50, body.retry_delay_ms);
          await getDb()
            .update(workers)
            .set(update)
            .where(eq(workers.id, c.req.param("id")));
          invalidateWorkerCache();
          const row = await getDb()
            .select()
            .from(workers)
            .where(eq(workers.id, c.req.param("id")))
            .limit(1);
          if (row.length === 0) {
            return c.json({ error: "Worker not found", code: 404 }, 404);
          }
          return c.json({ data: row[0] });
        },
      )

      .delete("/admin/workers/:id", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        await getDb()
          .delete(workers)
          .where(eq(workers.id, c.req.param("id")));
        invalidateWorkerCache();
        return c.json({ data: null });
      })

      // ── Jobs log + admin actions ──────────────────────────────────────────
      .get("/admin/queues/jobs", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const opts: Parameters<typeof listJobsLog>[0] = {};
        const queue = c.req.query("queue");
        const status = c.req.query("status");
        const workerId = c.req.query("worker_id");
        const page = c.req.query("page");
        const perPage = c.req.query("perPage");
        if (queue) opts.queue = queue;
        if (status) {
          if (!VALID_STATUS.has(status as JobStatus)) {
            return c.json({ error: `Invalid status: ${status}`, code: 422 }, 422);
          }
          opts.status = status as JobStatus;
        }
        if (workerId) opts.worker_id = workerId;
        if (page) opts.page = Number(page);
        if (perPage) opts.perPage = Number(perPage);
        return c.json(await listJobsLog(opts));
      })

      .post("/admin/queues/jobs/:id/retry", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const ok = await retryJob(c.req.param("id"));
        if (!ok) {
          return c.json({ error: "Job not found or not retryable", code: 404 }, 404);
        }
        return c.json({ data: { ok: true } });
      })

      // Bulk dead-letter replay (E-12). Optional `?queue=` scopes it; omit to
      // replay every dead job.
      .post("/admin/queues/jobs/retry-dead", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const queue = c.req.query("queue") || undefined;
        const retried = await retryDeadJobs(queue);
        return c.json({ data: { retried } });
      })

      .delete("/admin/queues/jobs/:id", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const ok = await discardJob(c.req.param("id"));
        if (!ok) {
          return c.json({ error: "Job not found or running", code: 404 }, 404);
        }
        return c.json({ data: null });
      })

      .get("/admin/queues/stats", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const data = await queueStats();
        return c.json({ data });
      })
  );
}
