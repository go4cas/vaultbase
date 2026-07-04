/**
 * P1-4 MCP write-tool safety: per-tool rate limiting at the dispatcher, and a
 * `dry_run` on `cogworks.run_sql` that returns the plan without executing.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { ToolRegistry, type ToolContext, _resetMcpRateLimit } from "../mcp/tools.ts";
import { registerAdminWriteTools } from "../mcp/admin-write-tools.ts";

const ctx: ToolContext = {
  tokenId: "t1",
  tokenName: "test",
  scopes: ["mcp:admin"], // implies every mcp:* incl. mcp:sql
  adminId: "a1",
  adminEmail: "a@x.com",
};

let tmpDir: string;
let reg: ToolRegistry;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cogworks-mcpsafe-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  _resetMcpRateLimit();
  reg = new ToolRegistry();
  registerAdminWriteTools(reg);
  getRawClient().exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)");
  getRawClient().exec("INSERT INTO t (id, n) VALUES (1, 10)");
});
afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("");

describe("run_sql dry_run", () => {
  it("returns the plan and changes nothing", async () => {
    const res = await reg.call(
      "cogworks.run_sql",
      { query: "UPDATE t SET n = 999 WHERE id = 1", allow_write: true, dry_run: true },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as { dryRun: boolean; executed: boolean };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.executed).toBe(false);
    // The row is untouched.
    const row = getRawClient().query("SELECT n FROM t WHERE id = 1").get() as { n: number };
    expect(row.n).toBe(10);
  });
});

describe("per-tool rate limiting", () => {
  it("blocks a write tool past its per-minute budget", async () => {
    // mcp:sql is write-class (30/min). Fire 30 reads, then the 31st is limited.
    let lastOk = true;
    for (let i = 0; i < 30; i++) {
      const r = await reg.call("cogworks.run_sql", { query: "SELECT 1" }, ctx);
      lastOk = !r.isError;
    }
    expect(lastOk).toBe(true);
    const limited = await reg.call("cogworks.run_sql", { query: "SELECT 1" }, ctx);
    expect(limited.isError).toBe(true);
    expect(textOf(limited)).toMatch(/Rate limit/);
  });
});
