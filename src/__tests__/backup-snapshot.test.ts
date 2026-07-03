/**
 * E-7 consistent backup snapshot. `snapshotDb` (VACUUM INTO) captures all
 * committed state — including un-checkpointed WAL pages — into a standalone
 * `.db`, and the HTTP `GET /admin/backup` streams that snapshot (not the live
 * file) and cleans up its temp afterward.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import * as jose from "jose";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin as adminTable } from "../db/schema.ts";
import { snapshotDb } from "../core/backup-snapshot.ts";
import { makeBackupPlugin } from "../api/backup.ts";

const SECRET = "test-secret-backup";
const SQLITE_MAGIC = "SQLite format 3\0";
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cogworks-backup-"));
  setLogsDir(tmpDir);
});
afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* swallow */
  }
});

describe("snapshotDb (VACUUM INTO)", () => {
  it("captures committed rows that are still only in the WAL (not checkpointed)", async () => {
    const dbPath = join(tmpDir, "src.db");
    const writer = new Database(dbPath);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("CREATE TABLE t (x INTEGER)");
    writer.exec("INSERT INTO t VALUES (1), (2), (3)");
    // A WAL sidecar now holds the committed rows (no checkpoint issued). The
    // live .db main file alone would NOT contain them — a naive file copy loses
    // them; VACUUM INTO must not. Writer stays OPEN (simulates the live server).
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const snap = await snapshotDb(dbPath);
    try {
      // The snapshot is a self-contained DB with all three rows and no sidecars.
      expect(existsSync(`${snap}-wal`)).toBe(false);
      const sdb = new Database(snap, { readonly: true });
      const n = sdb.query("SELECT count(*) AS c FROM t").get() as { c: number };
      expect(n.c).toBe(3);
      sdb.close();
    } finally {
      rmSync(snap, { force: true });
      writer.close();
    }
  });

  it("throws when the source DB is missing", async () => {
    await expect(snapshotDb(join(tmpDir, "nope.db"))).rejects.toThrow(/source DB not found/);
  });
});

describe("GET /admin/backup", () => {
  const dbPath = () => join(tmpDir, "data.db");

  async function signAdmin(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(adminTable).values({
      id: "admin-1",
      email: "a@b.com",
      password_hash: "x",
      password_reset_at: 0,
      created_at: now,
    });
    return new jose.SignJWT({ id: "admin-1", email: "a@b.com", jti: crypto.randomUUID() })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("cogworks")
      .setAudience("admin")
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
  }

  it("streams a valid SQLite snapshot and cleans up the temp file", async () => {
    initDb(dbPath());
    await runMigrations();
    const token = await signAdmin();
    const app = makeBackupPlugin(SECRET, dbPath());

    const res = await app.request(
      new Request("http://localhost/admin/backup", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("cogworks-backup-");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(buf.slice(0, SQLITE_MAGIC.length))).toBe(SQLITE_MAGIC);

    // The streamed bytes are a real, openable SQLite DB with the schema.
    const out = join(tmpDir, "downloaded.db");
    await Bun.write(out, buf);
    const dl = new Database(out, { readonly: true });
    const row = dl
      .query("SELECT count(*) AS c FROM sqlite_master WHERE name = 'cogworks_collections'")
      .get() as { c: number };
    expect(row.c).toBe(1);
    dl.close();

    // Temp snapshot is cleaned up — no `.cogworks-snap-*` left in the data dir.
    await new Promise((r) => setTimeout(r, 30));
    const leftovers = readdirSync(tmpDir).filter((f) => f.startsWith(".cogworks-snap-"));
    expect(leftovers).toEqual([]);
    closeDb();
  });

  it("401s without an admin token", async () => {
    initDb(dbPath());
    await runMigrations();
    const app = makeBackupPlugin(SECRET, dbPath());
    const res = await app.request(new Request("http://localhost/admin/backup"));
    expect(res.status).toBe(401);
    closeDb();
  });
});
