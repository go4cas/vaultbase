/**
 * F-7 readiness probe. `/_/ready` = DB reachable AND migrations stamped, distinct
 * from the liveness probe `/_/health`. Exercises the REAL server via
 * `createServer(config).fetch` so the full route/middleware chain runs.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../config.ts";
import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createServer } from "../server.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";

let tmpDir: string;
let fetch: (req: Request) => Response | Promise<Response>;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cogworks-ready-"));
  setLogsDir(tmpDir);
  initDb(join(tmpDir, "data.db"));
  await runMigrations();
  const config: Config = {
    port: 0,
    dataDir: tmpDir,
    dbPath: join(tmpDir, "data.db"),
    uploadDir: join(tmpDir, "uploads"),
    logsDir: tmpDir,
    jwtSecret: "test-secret-readiness",
    encryptionKey: undefined,
  };
  fetch = createServer(config).fetch;
});

afterEach(() => {
  stopScheduler();
  stopQueueScheduler();
  stopUpdateCheckScheduler();
  stopWebhookDispatcher();
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* swallow */
  }
});

const get = (path: string) => Promise.resolve(fetch(new Request(`http://localhost${path}`)));

describe("GET /_/ready", () => {
  it("reports ready with the schema version once migrated", async () => {
    const res = await get("/_/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ready: boolean; schema_version: string; readonly: boolean };
    };
    expect(body.data.ready).toBe(true);
    expect(typeof body.data.schema_version).toBe("string");
    expect(body.data.schema_version.length).toBeGreaterThan(0);
    expect(body.data.readonly).toBe(false);
  });

  it("returns 503 not-ready when migrations are absent", async () => {
    // Simulate a pre-migration DB by dropping the stamp table.
    getRawClient().exec("DROP TABLE cogworks_schema");
    const res = await get("/_/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { data: { ready: boolean; reason: string } };
    expect(body.data.ready).toBe(false);
    expect(body.data.reason).toBeTruthy();
  });

  it("liveness (/_/health) stays ok independently of readiness", async () => {
    getRawClient().exec("DROP TABLE cogworks_schema"); // not-ready…
    const health = await get("/_/health");
    expect(health.status).toBe(200); // …but still alive
    const body = (await health.json()) as { data: { status: string } };
    expect(body.data.status).toBe("ok");
  });
});
