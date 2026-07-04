/**
 * E-4b — when `storage.redirect_downloads` is on and the driver is S3, a raw
 * file download 302-redirects to a signed/CDN URL instead of proxying the bytes
 * through the server. Skipped for one-time / IP-bound fields (a URL can't honor
 * per-fetch enforcement) and when the toggle is off.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setUploadDir, invalidateStorageCache, _setS3ClientForTests } from "../core/storage.ts";
import { setSetting } from "../api/settings.ts";
import { createCollection, type FieldDef } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { files } from "../db/schema.ts";
import { makeFilesPlugin } from "../api/files.ts";

const SECRET = "test-secret-file-redirect";
let tmpDir: string;

// Minimal S3 stand-in: enough for exists()/presign()/stream() on the read path.
const mockS3 = {
  write: async () => ({}),
  delete: async () => ({}),
  exists: async () => true,
  file: () => ({
    arrayBuffer: async () => new ArrayBuffer(0),
    exists: async () => true,
    stream: () => new ReadableStream(),
  }),
  presign: (key: string, opts?: { expiresIn?: number }) =>
    `https://signed.example.com/${key}?exp=${opts?.expiresIn ?? 0}`,
};

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cogworks-file-redirect-"));
  setLogsDir(tmpDir);
  setUploadDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  setSetting("storage.driver", "s3");
  setSetting("s3.bucket", "test-bucket");
  invalidateStorageCache();
  _setS3ClientForTests(mockS3 as never);
});
afterEach(() => {
  _setS3ClientForTests(null);
  invalidateStorageCache();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function seedFile(opts: FieldDef["options"] = {}) {
  const fields: FieldDef[] = [{ name: "attachment", type: "file", options: opts }];
  const col = await createCollection({
    name: "notes",
    type: "base",
    fields: JSON.stringify(fields),
    view_rule: null, // public
  } as never);
  const rec = await createRecord("notes", {}, null);
  const filename = `${crypto.randomUUID()}.bin`;
  await getDb().insert(files).values({
    id: crypto.randomUUID(),
    collection_id: col.id,
    record_id: rec.id,
    field_name: "attachment",
    filename,
    original_name: "x.bin",
    mime_type: "application/octet-stream",
    size: 4,
    created_at: 0,
  });
  return filename;
}

const get = (filename: string) =>
  makeFilesPlugin(tmpDir, SECRET).request(`http://localhost/files/${filename}`);

describe("E-4b S3 download redirect", () => {
  it("302-redirects to a signed URL when enabled", async () => {
    setSetting("storage.redirect_downloads", "1");
    invalidateStorageCache();
    const filename = await seedFile();
    const res = await get(filename);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://signed.example.com/${filename}?exp=120`);
  });

  it("does not redirect when the toggle is off (proxies instead)", async () => {
    // redirect_downloads unset → default off
    invalidateStorageCache();
    const filename = await seedFile();
    const res = await get(filename);
    expect(res.status).not.toBe(302);
  });

  it("does not redirect a one-time-token field (per-fetch control)", async () => {
    setSetting("storage.redirect_downloads", "1");
    invalidateStorageCache();
    const filename = await seedFile({ oneTimeToken: true });
    const res = await get(filename);
    expect(res.status).not.toBe(302);
  });
});
