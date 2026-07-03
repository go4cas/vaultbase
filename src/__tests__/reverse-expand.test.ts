/**
 * E-9 reverse-relation expand: `posts?expand=comments_via_post` attaches, to each
 * post, the comments whose `post` relation points back at it. Unlike forward
 * expand, reverse enforces the referencing collection's list_rule so it can't
 * leak rows the caller can't list. Single relations only.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import type { AuthContext } from "../core/rules.ts";

let tmpDir: string;
const ADMIN: AuthContext = { id: "admin-1", type: "admin" };

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cogworks-revexp-"));
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

/** posts + comments(post→posts, author→users, score) + users. */
async function schema(commentsListRule: string | null = null) {
  await createCollection({
    name: "users",
    fields: JSON.stringify([{ name: "email", type: "text" }]),
  });
  await createCollection({
    name: "posts",
    fields: JSON.stringify([{ name: "title", type: "text" }]),
  });
  await createCollection({
    name: "comments",
    list_rule: commentsListRule,
    fields: JSON.stringify([
      { name: "body", type: "text" },
      { name: "post", type: "relation", collection: "posts" },
      { name: "author", type: "relation", collection: "users" },
      { name: "score", type: "number" },
    ]),
  } as never);
}

/** The reverse-expanded comments on the single post in the list. */
async function expandComments(auth: AuthContext | null) {
  const res = await listRecords("posts", { expand: "comments_via_post", auth });
  const post = res.data[0] as Record<string, unknown>;
  return ((post.expand as Record<string, unknown>)?.comments_via_post ?? []) as Array<
    Record<string, unknown>
  >;
}

describe("reverse-relation expand", () => {
  it("attaches referencing records grouped by host id", async () => {
    await schema();
    const p = await createRecord("posts", { title: "hello" });
    await createRecord("comments", { body: "c1", post: p.id, score: 1 });
    await createRecord("comments", { body: "c2", post: p.id, score: 2 });

    const comments = await expandComments(null);
    expect(comments.map((c) => c.body).sort()).toEqual(["c1", "c2"]);
  });

  it("returns an empty array for a host with no referencing records", async () => {
    await schema();
    await createRecord("posts", { title: "lonely" });
    expect(await expandComments(null)).toEqual([]);
  });

  it("ignores an invalid reverse path (no such incoming relation)", async () => {
    await schema();
    await createRecord("posts", { title: "x" });
    const res = await listRecords("posts", { expand: "widgets_via_post", auth: null });
    const post = res.data[0] as Record<string, unknown>;
    // Not a real relation → no expand key attached.
    expect((post.expand as Record<string, unknown> | undefined)?.widgets_via_post).toBeUndefined();
  });

  it('enforces an admin-only ("") list_rule — hides everything from non-admins', async () => {
    await schema(""); // comments = admin-only
    const p = await createRecord("posts", { title: "p" });
    await createRecord("comments", { body: "secret", post: p.id, score: 1 });

    expect(await expandComments(null)).toEqual([]); // non-admin sees none
    expect((await expandComments(ADMIN)).map((c) => c.body)).toEqual(["secret"]); // admin sees all
  });

  it("enforces an expression list_rule on reverse-expanded rows", async () => {
    await schema("score >= 5");
    const p = await createRecord("posts", { title: "p" });
    await createRecord("comments", { body: "low", post: p.id, score: 3 });
    await createRecord("comments", { body: "high", post: p.id, score: 7 });

    expect((await expandComments(null)).map((c) => c.body)).toEqual(["high"]); // rule applied
    expect((await expandComments(ADMIN)).map((c) => c.body).sort()).toEqual(["high", "low"]); // admin bypass
  });

  it("recurses into a forward relation on the reverse-expanded rows", async () => {
    await schema();
    const u = await createRecord("users", { email: "a@b.com" });
    const p = await createRecord("posts", { title: "p" });
    await createRecord("comments", { body: "c1", post: p.id, author: u.id, score: 1 });

    const res = await listRecords("posts", {
      expand: "comments_via_post.author",
      auth: null,
    });
    const post = res.data[0] as Record<string, unknown>;
    const comments = (post.expand as Record<string, unknown>).comments_via_post as Array<
      Record<string, unknown>
    >;
    const author = (comments[0]!.expand as Record<string, unknown>).author as Record<
      string,
      unknown
    >;
    expect(author.email).toBe("a@b.com");
  });

  it("forward expand still works (regression)", async () => {
    await schema();
    const p = await createRecord("posts", { title: "p" });
    const c = await createRecord("comments", { body: "c1", post: p.id, score: 1 });
    const res = await listRecords("comments", {
      filter: `id = '${c.id}'`,
      expand: "post",
      auth: null,
    });
    const comment = res.data[0] as Record<string, unknown>;
    expect((comment.expand as Record<string, unknown>).post).toMatchObject({ title: "p" });
  });
});
