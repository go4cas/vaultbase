/**
 * E-13 — rate-limit buckets keyed by bearer token (not just IP), so users
 * sharing an egress IP get independent budgets; guests stay keyed by IP.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setSetting } from "../api/settings.ts";
import { rateLimitMiddleware, invalidateRateLimitCache } from "../api/ratelimit.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cogworks-rl-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  setSetting("rate_limit.enabled", "1");
  setSetting(
    "rate_limit.rules",
    JSON.stringify([{ label: "/api/*", max: 2, windowMs: 60000, audience: "all" }]),
  );
  invalidateRateLimitCache();
});
afterEach(() => {
  invalidateRateLimitCache();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function app() {
  const a = new Hono();
  a.use("*", rateLimitMiddleware());
  a.all("*", (c) => c.text("ok"));
  return a;
}

const hit = (a: ReturnType<typeof app>, token?: string) =>
  a.request("http://localhost/api/v1/things", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe("per-token rate limiting (E-13)", () => {
  it("gives distinct tokens independent buckets", async () => {
    const a = app();
    // Token A: 2 allowed, 3rd limited.
    expect((await hit(a, "AAA")).status).toBe(200);
    expect((await hit(a, "AAA")).status).toBe(200);
    expect((await hit(a, "AAA")).status).toBe(429);
    // Token B is unaffected by A's exhausted bucket.
    expect((await hit(a, "BBB")).status).toBe(200);
    expect((await hit(a, "BBB")).status).toBe(200);
    expect((await hit(a, "BBB")).status).toBe(429);
  });

  it("still limits guests (no token) by IP", async () => {
    const a = app();
    expect((await hit(a)).status).toBe(200);
    expect((await hit(a)).status).toBe(200);
    expect((await hit(a)).status).toBe(429);
  });
});
