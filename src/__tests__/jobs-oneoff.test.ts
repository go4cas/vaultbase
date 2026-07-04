/**
 * F-8 one-off ("run at") cron jobs. A one-off is stored with an empty `cron`
 * and a future `next_run_at`; after it fires once, `runJob` leaves
 * `next_run_at = null` so the scheduler never picks it up again.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin, jobs } from "../db/schema.ts";
import { signAuthToken } from "../core/sec.ts";
import { makeJobsPlugin } from "../api/jobs.ts";
import { runJob } from "../core/jobs.ts";
import { eq } from "drizzle-orm";

const SECRET = "test-secret-f8";

describe("F-8 one-off jobs", () => {
  let tmpDir: string;
  let token: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "f8-"));
    initDb(join(tmpDir, "db.sqlite"));
    await runMigrations();
    setLogsDir(tmpDir);
    const id = crypto.randomUUID();
    await getDb()
      .insert(admin)
      .values({ id, email: "o@x.com", password_hash: "x", role: "owner", created_at: 0 });
    token = (
      await signAuthToken({
        payload: { id, email: "o@x.com" },
        audience: "admin",
        expiresInSeconds: 3600,
        jwtSecret: SECRET,
      })
    ).token;
  });

  afterEach(() => {
    closeDb();
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* swallow */
    }
  });

  const post = (body: unknown) =>
    makeJobsPlugin(SECRET).request("/admin/jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("creates a one-off with empty cron + future next_run_at", async () => {
    const runAt = Math.floor(Date.now() / 1000) + 3600;
    const res = await post({ name: "once", run_at: runAt, code: "" });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: typeof jobs.$inferSelect };
    expect(data.cron).toBe("");
    expect(data.next_run_at).toBe(runAt);
    expect(data.enabled).toBe(1);
  });

  it("rejects a past run_at", async () => {
    const res = await post({ name: "past", run_at: Math.floor(Date.now() / 1000) - 10 });
    expect(res.status).toBe(422);
  });

  it("fires once then never reschedules", async () => {
    const runAt = Math.floor(Date.now() / 1000) + 1;
    const res = await post({ name: "once", run_at: runAt, code: "// noop" });
    const { data } = (await res.json()) as { data: { id: string } };

    const r = await runJob(data.id);
    expect(r.ok).toBe(true);

    const [row] = await getDb().select().from(jobs).where(eq(jobs.id, data.id)).limit(1);
    expect(row!.last_run_at).not.toBeNull();
    expect(row!.next_run_at).toBeNull(); // empty cron ⇒ no next run
  });

  it("still creates recurring cron jobs (regression)", async () => {
    const res = await post({ name: "hourly", cron: "0 * * * *", code: "" });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: typeof jobs.$inferSelect };
    expect(data.cron).toBe("0 * * * *");
    expect(data.next_run_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
