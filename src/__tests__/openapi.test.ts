/**
 * F-2 OpenAPI generation. The spec is derived from collection field defs (JSON
 * Schema per collection + record CRUD paths); views are read-only. Plus the
 * `/openapi.json` + `/docs` endpoints and the `docs.enabled` gate.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createCollection, listCollections } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { setSetting } from "./../api/settings.ts";
import { buildOpenApiSpec, fieldToSchema } from "../core/openapi.ts";
import { makeOpenApiPlugin } from "../api/openapi.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cogworks-openapi-"));
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

async function seed() {
  await createCollection({
    name: "posts",
    fields: JSON.stringify([
      { name: "title", type: "text", required: true, options: { min: 1, max: 100 } },
      { name: "views", type: "number", options: { min: 0, max: 10 } },
      { name: "published", type: "bool" },
      { name: "tags", type: "select", options: { multiple: true, values: ["a", "b"] } },
      { name: "author", type: "relation", collection: "posts" },
      { name: "secret", type: "password" },
    ]),
  });
  await createRecord("posts", { title: "seed" });
  await createCollection({
    name: "pview",
    type: "view",
    view_query: "SELECT id, title FROM cw_posts",
  } as never);
}

const build = async () =>
  buildOpenApiSpec(await listCollections(), { serverUrl: "/api/v1", version: "1.2.3" }) as Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: test-only deep access
    any
  >;

describe("fieldToSchema", () => {
  it("maps types + constraints", () => {
    expect(
      fieldToSchema({ name: "a", type: "text", options: { min: 2, max: 5, pattern: "^x" } }),
    ).toEqual({
      type: "string",
      minLength: 2,
      maxLength: 5,
      pattern: "^x",
    });
    expect(fieldToSchema({ name: "n", type: "number", options: { min: 0, max: 9 } })).toEqual({
      type: "number",
      minimum: 0,
      maximum: 9,
    });
    expect(fieldToSchema({ name: "e", type: "email" })).toEqual({
      type: "string",
      format: "email",
    });
    expect(fieldToSchema({ name: "v", type: "vector" })).toEqual({
      type: "array",
      items: { type: "number" },
    });
    expect(
      fieldToSchema({ name: "s", type: "select", options: { multiple: true, values: ["a", "b"] } }),
    ).toEqual({ type: "array", items: { type: "string", enum: ["a", "b"] } });
    expect(fieldToSchema({ name: "p", type: "password" })).toEqual({
      type: "string",
      writeOnly: true,
    });
  });
});

describe("buildOpenApiSpec", () => {
  it("has the document envelope", async () => {
    await seed();
    const spec = await build();
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.info.title).toBe("Cogworks API");
    expect(spec.info.version).toBe("1.2.3");
    expect(spec.servers[0].url).toBe("/api/v1");
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });

  it("emits read + write schemas; excludes password from read; marks required", async () => {
    await seed();
    const spec = await build();
    const read = spec.components.schemas.posts;
    expect(Object.keys(read.properties)).toContain("title");
    expect(read.properties.id).toEqual({ type: "string" });
    expect(read.properties.secret).toBeUndefined(); // password not readable
    expect(read.properties.views).toEqual({ type: "number", minimum: 0, maximum: 10 });

    const create = spec.components.schemas.postsCreate;
    expect(create.required).toEqual(["title"]);
    expect(create.properties.secret).toEqual({ type: "string", writeOnly: true });
    // Update schema has no required list.
    expect(spec.components.schemas.postsUpdate.required).toBeUndefined();
  });

  it("emits full CRUD paths for base collections", async () => {
    await seed();
    const spec = await build();
    expect(Object.keys(spec.paths["/posts"])).toEqual(expect.arrayContaining(["get", "post"]));
    expect(Object.keys(spec.paths["/posts/{id}"])).toEqual(
      expect.arrayContaining(["get", "patch", "delete"]),
    );
  });

  it("makes view collections read-only", async () => {
    await seed();
    const spec = await build();
    expect(spec.components.schemas.pview).toBeDefined();
    expect(spec.components.schemas.pviewCreate).toBeUndefined();
    expect(Object.keys(spec.paths["/pview"])).toEqual(["get"]); // no post
    expect(Object.keys(spec.paths["/pview/{id}"])).toEqual(["get"]); // no patch/delete
  });
});

describe("openapi endpoints", () => {
  it("serves the spec and the docs page", async () => {
    await seed();
    const app = makeOpenApiPlugin();
    const spec = await app.request(new Request("http://localhost/openapi.json"));
    expect(spec.status).toBe(200);
    expect(spec.headers.get("content-type")).toContain("application/json");
    const body = (await spec.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toBe("3.0.3");
    expect(body.paths["/posts"]).toBeDefined();

    const docs = await app.request(new Request("http://localhost/docs"));
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/html");
    expect(await docs.text()).toContain("openapi.json");
  });

  it("404s both when docs.enabled is off", async () => {
    await seed();
    setSetting("docs.enabled", "0");
    const app = makeOpenApiPlugin();
    expect((await app.request(new Request("http://localhost/openapi.json"))).status).toBe(404);
    expect((await app.request(new Request("http://localhost/docs"))).status).toBe(404);
  });
});
