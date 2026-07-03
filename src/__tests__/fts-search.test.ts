/**
 * F-1 full-text search (SQLite FTS5). Drives the real collection + record core:
 * a `searchable` field flag builds a companion FTS5 table kept in sync by
 * triggers, and `listRecords({ search })` MATCHes it. Covers write-sync
 * (insert/update/delete), enable/disable backfill, MATCH-syntax safety,
 * filter composition, multi-field, and the view / no-index guards.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createCollection, updateCollection, deleteCollection } from "../core/collections.ts";
import { createRecord, updateRecord, deleteRecord, listRecords } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cogworks-fts-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* swallow */
  }
});

/** Field def helper. */
function field(name: string, opts: Record<string, unknown> = {}) {
  return { name, type: "text", options: opts };
}

/** Make a base collection with the given field defs. */
async function coll(name: string, fields: object[]) {
  return createCollection({ name, type: "base", fields: JSON.stringify(fields) } as never);
}

/** Search → set of matched record ids. */
async function searchIds(collection: string, q: string): Promise<Set<string>> {
  const res = await listRecords(collection, { search: q });
  return new Set(res.data.map((r) => r.id as string));
}

describe("FTS5 full-text search", () => {
  it("matches a searchable field and ignores non-matching rows", async () => {
    await coll("docs", [field("body", { searchable: true })]);
    const a = await createRecord("docs", { body: "the quick brown fox" });
    const b = await createRecord("docs", { body: "lazy dog sleeps" });

    const hits = await searchIds("docs", "quick");
    expect(hits).toEqual(new Set([a.id]));
    expect(await searchIds("docs", "dog")).toEqual(new Set([b.id]));
    // total count reflects the FTS filter, not the whole table
    const res = await listRecords("docs", { search: "quick" });
    expect(res.totalItems).toBe(1);
  });

  it("AND-combines multiple terms", async () => {
    await coll("docs", [field("body", { searchable: true })]);
    const both = await createRecord("docs", { body: "quick brown fox" });
    await createRecord("docs", { body: "quick dog" });
    expect(await searchIds("docs", "quick fox")).toEqual(new Set([both.id]));
  });

  it("keeps the index in sync on update (trigger)", async () => {
    await coll("docs", [field("body", { searchable: true })]);
    const r = await createRecord("docs", { body: "apple pie" });
    expect(await searchIds("docs", "apple")).toEqual(new Set([r.id]));

    await updateRecord("docs", r.id as string, { body: "banana bread" });
    expect(await searchIds("docs", "apple")).toEqual(new Set()); // old term gone
    expect(await searchIds("docs", "banana")).toEqual(new Set([r.id])); // new term indexed
  });

  it("keeps the index in sync on delete (trigger)", async () => {
    await coll("docs", [field("body", { searchable: true })]);
    const r = await createRecord("docs", { body: "ephemeral note" });
    expect(await searchIds("docs", "ephemeral")).toEqual(new Set([r.id]));
    await deleteRecord("docs", r.id as string);
    expect(await searchIds("docs", "ephemeral")).toEqual(new Set());
  });

  it("backfills existing rows when a field is newly marked searchable", async () => {
    const c = await coll("docs", [field("body")]); // NOT searchable yet
    const r = await createRecord("docs", { body: "retroactive content" });
    // Not searchable → search yields nothing (empty, not everything).
    expect((await listRecords("docs", { search: "retroactive" })).data).toHaveLength(0);

    await updateCollection(c.id, {
      fields: JSON.stringify([field("body", { searchable: true })]),
    });
    // Existing row is now indexed via the FTS 'rebuild' backfill.
    expect(await searchIds("docs", "retroactive")).toEqual(new Set([r.id]));
  });

  it("drops the index when searchable is turned off", async () => {
    const c = await coll("docs", [field("body", { searchable: true })]);
    await createRecord("docs", { body: "was searchable" });
    expect((await searchIds("docs", "searchable")).size).toBe(1);

    await updateCollection(c.id, { fields: JSON.stringify([field("body")]) });
    // No searchable fields → a search returns empty rather than all rows.
    expect((await listRecords("docs", { search: "searchable" })).data).toHaveLength(0);
    // FTS companion table is gone.
    const fts = getRawClient()
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='cw_docs_fts'`)
      .get();
    expect(fts).toBeNull();
  });

  it("returns empty for a search on a collection with no searchable fields", async () => {
    await coll("plain", [field("body")]);
    await createRecord("plain", { body: "hello world" });
    expect((await listRecords("plain", { search: "hello" })).data).toHaveLength(0);
    // …but a plain (no-search) list still returns everything.
    expect((await listRecords("plain", {})).data).toHaveLength(1);
  });

  it("treats FTS operator syntax as literal terms (no MATCH syntax error)", async () => {
    await coll("docs", [field("body", { searchable: true })]);
    const r = await createRecord("docs", { body: "status published now" });
    // Each of these would be an FTS5 syntax error or a column-filter/negation
    // injection if passed raw; sanitizer must neutralize them.
    for (const q of ['body:"', "published AND", "-published", "pub*", '")) OR 1=1 --']) {
      await expect(listRecords("docs", { search: q })).resolves.toBeDefined();
    }
    // A benign multi-term query still works over the sanitized phrases.
    expect(await searchIds("docs", "status published")).toEqual(new Set([r.id]));
  });

  it("composes with filter — never matches rows outside the filter", async () => {
    await coll("docs", [field("body", { searchable: true }), field("kind")]);
    const keep = await createRecord("docs", { body: "shared term", kind: "a" });
    await createRecord("docs", { body: "shared term", kind: "b" });
    const res = await listRecords("docs", { search: "shared", filter: "kind = 'a'" });
    expect(new Set(res.data.map((r) => r.id))).toEqual(new Set([keep.id]));
    expect(res.totalItems).toBe(1);
  });

  it("indexes multiple searchable fields", async () => {
    await coll("docs", [
      field("title", { searchable: true }),
      field("body", { searchable: true }),
      field("note"), // not searchable
    ]);
    const r = await createRecord("docs", { title: "aardvark", body: "zebra", note: "quokka" });
    expect(await searchIds("docs", "aardvark")).toEqual(new Set([r.id])); // title
    expect(await searchIds("docs", "zebra")).toEqual(new Set([r.id])); // body
    expect((await listRecords("docs", { search: "quokka" })).data).toHaveLength(0); // note excluded
  });

  it("folds diacritics (accent-insensitive)", async () => {
    await coll("docs", [field("body", { searchable: true })]);
    const r = await createRecord("docs", { body: "café résumé" });
    expect(await searchIds("docs", "cafe")).toEqual(new Set([r.id]));
    expect(await searchIds("docs", "resume")).toEqual(new Set([r.id]));
  });

  it("dropping a searchable column via schema edit does not error", async () => {
    const c = await coll("docs", [
      field("title", { searchable: true }),
      field("body", { searchable: true }),
    ]);
    await createRecord("docs", { title: "keep", body: "remove-me" });
    // Remove the `body` searchable column — dropFts must run before the DROP
    // COLUMN or SQLite refuses (trigger references the column).
    await expect(
      updateCollection(c.id, { fields: JSON.stringify([field("title", { searchable: true })]) }),
    ).resolves.toBeDefined();
    // title search still works; body is gone.
    expect((await searchIds("docs", "keep")).size).toBe(1);
  });

  it("ignores search on view collections without erroring", async () => {
    await coll("src", [field("body", { searchable: true })]);
    await createRecord("src", { body: "viewable row" });
    await createCollection({
      name: "src_view",
      type: "view",
      view_query: "SELECT id, body FROM cw_src",
    } as never);
    // Views have no FTS; a search param is simply ignored (returns rows, no throw).
    await expect(listRecords("src_view", { search: "viewable" })).resolves.toBeDefined();
  });

  it("exposes ?search= over the HTTP list endpoint", async () => {
    await coll("docs", [field("body", { searchable: true })]);
    const a = await createRecord("docs", { body: "the quick brown fox" });
    await createRecord("docs", { body: "lazy dog" });
    // Default base collection has a null list_rule → public list, no auth needed.
    const app = makeRecordsPlugin("test-secret-fts-api");
    const res = await app.request(new Request("http://localhost/docs?search=quick"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[]; totalItems: number };
    expect(body.data.map((r) => r.id)).toEqual([a.id]);
    expect(body.totalItems).toBe(1);
  });

  it("tears down the FTS companion when the collection is deleted", async () => {
    const c = await coll("docs", [field("body", { searchable: true })]);
    await createRecord("docs", { body: "content" });
    expect(
      getRawClient().prepare(`SELECT 1 FROM sqlite_master WHERE name='cw_docs_fts'`).get(),
    ).toBeDefined();
    await deleteCollection(c.id);
    expect(
      getRawClient().prepare(`SELECT 1 FROM sqlite_master WHERE name='cw_docs_fts'`).get(),
    ).toBeNull();
  });
});
