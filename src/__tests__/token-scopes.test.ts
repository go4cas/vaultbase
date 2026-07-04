/**
 * F-10 per-collection API-token scopes. Two layers:
 *   1. `hasScope` / `isValidScope` — pure scope grammar + wildcard + global fallback.
 *   2. End-to-end enforcement on the REST records surface: a token scoped to one
 *      collection/action can't touch others; direct sessions are unrestricted.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createCollection } from "../core/collections.ts";
import { admin } from "../db/schema.ts";
import { signAuthToken } from "../core/sec.ts";
import { mintApiToken, hasScope, isValidScope, type Scope } from "../core/api-tokens.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "test-secret-f10";

describe("hasScope — per-collection grammar", () => {
  it("exact + wildcard collection scopes", () => {
    expect(hasScope(["collection:posts:read"], "collection:posts:read")).toBe(true);
    expect(hasScope(["collection:posts:read"], "collection:posts:write")).toBe(false);
    expect(hasScope(["collection:posts:read"], "collection:comments:read")).toBe(false);
    expect(hasScope(["collection:posts:*"], "collection:posts:write")).toBe(true);
    expect(hasScope(["collection:*:read"], "collection:anything:read")).toBe(true);
    expect(hasScope(["collection:*:read"], "collection:anything:write")).toBe(false);
    expect(hasScope(["collection:*:*"], "collection:x:write")).toBe(true);
  });

  it("global read/write are a superset of per-collection; admin implies all", () => {
    expect(hasScope(["read"], "collection:posts:read")).toBe(true);
    expect(hasScope(["read"], "collection:posts:write")).toBe(false);
    expect(hasScope(["write"], "collection:posts:write")).toBe(true);
    expect(hasScope(["admin"], "collection:posts:write")).toBe(true);
    // per-collection scope does NOT grant global
    expect(hasScope(["collection:posts:read"], "read")).toBe(false);
  });

  it("isValidScope accepts known + well-formed collection scopes, rejects junk", () => {
    expect(isValidScope("read")).toBe(true);
    expect(isValidScope("mcp:sql")).toBe(true);
    expect(isValidScope("collection:posts:read")).toBe(true);
    expect(isValidScope("collection:*:*")).toBe(true);
    expect(isValidScope("collection:posts:delete")).toBe(false); // no such action
    expect(isValidScope("reads")).toBe(false);
    expect(isValidScope("collection:posts")).toBe(false);
  });
});

describe("mintApiToken — scope validation", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogworks-f10m-"));
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

  it("rejects an invalid scope string", async () => {
    await expect(
      mintApiToken(
        { name: "bad", scopes: ["collection:posts:delete"], createdBy: "a", createdByEmail: "a@x" },
        SECRET,
      ),
    ).rejects.toThrow(/invalid scope/);
  });

  it("accepts a per-collection scope", async () => {
    const r = await mintApiToken(
      { name: "ok", scopes: ["collection:posts:read"], createdBy: "a", createdByEmail: "a@x" },
      SECRET,
    );
    expect(r.token.startsWith("cwat_")).toBe(true);
  });
});

describe("REST records — scope enforcement (end-to-end)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogworks-f10-"));
    setLogsDir(tmpDir);
    initDb(":memory:");
    await runMigrations();
    await getDb()
      .insert(admin)
      .values({ id: "a1", email: "a@x.com", password_hash: "x", role: "owner", created_at: 0 });
    await createCollection({
      name: "posts",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
    });
    await createCollection({
      name: "comments",
      fields: JSON.stringify([{ name: "body", type: "text" }]),
    });
  });
  afterEach(() => {
    closeDb();
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* swallow */
    }
  });

  const app = () => makeRecordsPlugin(SECRET);

  async function apiToken(scopes: Scope[]): Promise<string> {
    const { token } = await mintApiToken(
      { name: "t", scopes, createdBy: "a1", createdByEmail: "a@x.com" },
      SECRET,
    );
    return token;
  }

  const get = (a: ReturnType<typeof app>, path: string, token: string) =>
    a.request(path, { headers: { authorization: `Bearer ${token}` } });
  const post = (a: ReturnType<typeof app>, path: string, token: string, body: unknown) =>
    a.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("global read token: can read any collection, cannot write", async () => {
    const a = app();
    const t = await apiToken(["read"]);
    expect((await get(a, "/posts", t)).status).toBe(200);
    expect((await get(a, "/comments", t)).status).toBe(200);
    expect((await post(a, "/posts", t, { title: "x" })).status).toBe(403);
  });

  it("global write token: can write, cannot read", async () => {
    const a = app();
    const t = await apiToken(["write"]);
    expect((await post(a, "/posts", t, { title: "x" })).status).toBe(200);
    expect((await get(a, "/posts", t)).status).toBe(403);
  });

  it("collection:posts:read token: reads posts only, no writes, no other collections", async () => {
    const a = app();
    const t = await apiToken(["collection:posts:read"]);
    expect((await get(a, "/posts", t)).status).toBe(200);
    expect((await get(a, "/comments", t)).status).toBe(403);
    expect((await post(a, "/posts", t, { title: "x" })).status).toBe(403);
  });

  it("collection:posts:* token: full CRUD on posts, nothing on comments", async () => {
    const a = app();
    const t = await apiToken(["collection:posts:*"]);
    expect((await post(a, "/posts", t, { title: "x" })).status).toBe(200);
    expect((await get(a, "/posts", t)).status).toBe(200);
    expect((await get(a, "/comments", t)).status).toBe(403);
  });

  it("admin-scope token: everything", async () => {
    const a = app();
    const t = await apiToken(["admin"]);
    expect((await get(a, "/comments", t)).status).toBe(200);
    expect((await post(a, "/posts", t, { title: "x" })).status).toBe(200);
  });

  it("direct admin session (not an API token) is unrestricted by scopes", async () => {
    const a = app();
    const { token } = await signAuthToken({
      payload: { id: "a1", email: "a@x.com" },
      audience: "admin",
      expiresInSeconds: 3600,
      jwtSecret: SECRET,
    });
    expect((await post(a, "/posts", token, { title: "x" })).status).toBe(200);
    expect((await get(a, "/comments", token)).status).toBe(200);
  });
});
