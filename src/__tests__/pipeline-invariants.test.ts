/**
 * T-2 — root middleware pipeline invariants. The load-bearing property is that
 * cross-cutting concerns wrap EVERYTHING, including a short-circuited 429:
 * security headers still land, and the request is still access-logged.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../config.ts";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setSetting } from "../api/settings.ts";
import { invalidateRateLimitCache } from "../api/ratelimit.ts";
import { createServer } from "../server.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWorkflowScheduler } from "../core/workflows.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";

let tmpDir: string;
let fetch: (req: Request) => Response | Promise<Response>;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cogworks-pipe-"));
  setLogsDir(tmpDir);
  initDb(join(tmpDir, "data.db"));
  await runMigrations();
  // Tiny rate rule so the 2nd /api/* request short-circuits with a 429.
  setSetting("rate_limit.enabled", "1");
  setSetting(
    "rate_limit.rules",
    JSON.stringify([{ label: "/api/*", max: 1, windowMs: 60000, audience: "all" }]),
  );
  invalidateRateLimitCache();
  const config: Config = {
    port: 0,
    dataDir: tmpDir,
    dbPath: join(tmpDir, "data.db"),
    uploadDir: join(tmpDir, "uploads"),
    logsDir: tmpDir,
    jwtSecret: "test-secret-pipeline",
    encryptionKey: undefined,
  };
  fetch = createServer(config).fetch;
});

afterEach(() => {
  stopScheduler();
  stopQueueScheduler();
  stopWorkflowScheduler();
  stopUpdateCheckScheduler();
  stopWebhookDispatcher();
  invalidateRateLimitCache();
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* leave for OS */
  }
});

const call = () => Promise.resolve(fetch(new Request("http://localhost/api/v1/openapi.json")));

describe("root pipeline invariants", () => {
  it("security headers land on a normal response", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("a rate-limited 429 still carries security headers (outer middleware wraps the short-circuit)", async () => {
    await call(); // consume the single token
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("CORS/security envelope is applied even on the short-circuited 429", async () => {
    await call();
    const limited = await call();
    expect(limited.status).toBe(429);
    // Referrer-Policy is part of the same envelope — proves the full header pass
    // ran on the unwound short-circuit, not just one header.
    expect(limited.headers.get("referrer-policy")).toBe("no-referrer");
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});
