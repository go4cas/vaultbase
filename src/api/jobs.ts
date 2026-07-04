import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import { getDb } from "../db/client.ts";
import { jobs } from "../db/schema.ts";
import { invalidateJobsCache, nextRunFromCron, runJob, validateCron } from "../core/jobs.ts";
import { requireAdmin } from "../core/sec.ts";

function validateMode(mode: string): string | null {
  if (mode === "inline") return null;
  const m = /^worker:(.+)$/.exec(mode);
  if (!m || !m[1]!.trim()) return `Invalid mode "${mode}" — expected "inline" or "worker:<queue>"`;
  return null;
}

export function makeJobsPlugin(jwtSecret: string) {
  return new Hono()
    .get("/admin/jobs", async (c) => {
      if (!(await requireAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const rows = await getDb().select().from(jobs);
      return c.json({ data: rows });
    })

    .post(
      "/admin/jobs",
      jsonBody(
        t.Object({
          name: t.Optional(t.String()),
          // Recurring: supply `cron`. One-off: supply `run_at` (unix seconds,
          // future) and leave `cron` empty — the job fires once then disables.
          cron: t.Optional(t.String()),
          run_at: t.Optional(t.Number()),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
          mode: t.Optional(t.String()),
        }),
      ),
      async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const body = c.req.valid("json");
        const now = Math.floor(Date.now() / 1000);
        // One-off ("run at") jobs carry an empty cron + a future next_run_at;
        // runJob disables them after the single fire (see core/jobs.ts).
        const oneOff = body.run_at !== undefined;
        let cron = "";
        let next: number;
        if (oneOff) {
          const runAt = body.run_at as number;
          if (!Number.isFinite(runAt) || runAt <= now) {
            return c.json({ error: "run_at must be a future unix timestamp", code: 422 }, 422);
          }
          next = Math.floor(runAt);
        } else {
          cron = body.cron ?? "";
          const cronErr = validateCron(cron);
          if (cronErr) {
            return c.json({ error: `Invalid cron: ${cronErr}`, code: 422 }, 422);
          }
          next = nextRunFromCron(cron, now);
        }
        const mode = body.mode ?? "inline";
        const modeErr = validateMode(mode);
        if (modeErr) {
          return c.json({ error: modeErr, code: 422 }, 422);
        }
        const id = crypto.randomUUID();
        await getDb()
          .insert(jobs)
          .values({
            id,
            name: body.name ?? "",
            cron,
            code: body.code ?? "",
            enabled: body.enabled === false ? 0 : 1,
            mode,
            last_run_at: null,
            next_run_at: next,
            last_status: null,
            last_error: null,
            created_at: now,
            updated_at: now,
          });
        invalidateJobsCache();
        const row = await getDb().select().from(jobs).where(eq(jobs.id, id)).limit(1);
        return c.json({ data: row[0] });
      },
    )

    .patch(
      "/admin/jobs/:id",
      jsonBody(
        t.Object({
          name: t.Optional(t.String()),
          cron: t.Optional(t.String()),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
          mode: t.Optional(t.String()),
        }),
      ),
      async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const body = c.req.valid("json");
        const update: {
          name?: string;
          cron?: string;
          code?: string;
          enabled?: number;
          mode?: string;
          next_run_at?: number;
          updated_at: number;
        } = {
          updated_at: Math.floor(Date.now() / 1000),
        };
        if (body.name !== undefined) update.name = body.name;
        if (body.cron !== undefined) {
          const cronErr = validateCron(body.cron);
          if (cronErr) {
            return c.json({ error: `Invalid cron: ${cronErr}`, code: 422 }, 422);
          }
          update.cron = body.cron;
          update.next_run_at = nextRunFromCron(body.cron, update.updated_at);
        }
        if (body.code !== undefined) update.code = body.code;
        if (body.enabled !== undefined) update.enabled = body.enabled ? 1 : 0;
        if (body.mode !== undefined) {
          const modeErr = validateMode(body.mode);
          if (modeErr) {
            return c.json({ error: modeErr, code: 422 }, 422);
          }
          update.mode = body.mode;
        }
        await getDb()
          .update(jobs)
          .set(update)
          .where(eq(jobs.id, c.req.param("id")));
        invalidateJobsCache();
        const row = await getDb()
          .select()
          .from(jobs)
          .where(eq(jobs.id, c.req.param("id")))
          .limit(1);
        if (row.length === 0) {
          return c.json({ error: "Job not found", code: 404 }, 404);
        }
        return c.json({ data: row[0] });
      },
    )

    .delete("/admin/jobs/:id", async (c) => {
      if (!(await requireAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      await getDb()
        .delete(jobs)
        .where(eq(jobs.id, c.req.param("id")));
      invalidateJobsCache();
      return c.json({ data: null });
    })

    .post("/admin/jobs/:id/run", async (c) => {
      if (!(await requireAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const result = await runJob(c.req.param("id"));
      if (!result.ok) {
        return c.json({ error: result.error ?? "Run failed", code: 500 }, 500);
      }
      return c.json({ data: { ok: true } });
    });
}
