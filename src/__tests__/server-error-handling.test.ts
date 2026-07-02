/**
 * Root-pipeline error handling — guards the Hono `app.onError` regression the
 * Elysia→Hono migration introduced (and the review caught): a thrown
 * HTTPException (e.g. the body validator's 400 on malformed JSON) must render
 * at its real status, NOT be downgraded to 500.
 *
 * Exercises the REAL server via `createServer(config).fetch` — no Bun.serve —
 * so the full root middleware chain + onError run exactly as in production.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../config.ts";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createServer } from "../server.ts";

let tmpDir: string;
let fetch: (req: Request) => Response | Promise<Response>;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-srv-err-"));
  setLogsDir(tmpDir);
  initDb(join(tmpDir, "data.db"));
  await runMigrations();
  const config: Config = {
    port: 0,
    dataDir: tmpDir,
    dbPath: join(tmpDir, "data.db"),
    uploadDir: join(tmpDir, "uploads"),
    logsDir: tmpDir,
    jwtSecret: "test-secret-server-err",
    encryptionKey: undefined,
  };
  fetch = createServer(config).fetch;
});

afterEach(() => {
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* leave for OS tmp cleanup */
  }
});

// `/api/v1/flags/evaluate` is a public jsonBody route (no auth) — the validator
// runs before any handler logic, so it isolates the parse/onError path.
function post(body: string): Promise<Response> {
  return Promise.resolve(
    fetch(
      new Request("http://localhost/api/v1/flags/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    ),
  );
}

describe("root app.onError", () => {
  it("renders malformed-JSON HTTPException as 400, not 500", async () => {
    const res = await post("{bad");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code?: number };
    expect(json.code).toBe(400);
  });

  it("does not downgrade the parse error to a 500", async () => {
    const res = await post('{"context":');
    expect(res.status).not.toBe(500);
  });

  it("still serves a well-formed body (onError doesn't over-catch)", async () => {
    const res = await post('{"context":{}}');
    expect(res.status).toBe(200);
  });
});
