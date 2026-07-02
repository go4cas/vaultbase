import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import { getDb } from "../db/client.ts";
import { getCollection, parseFields, userTableName } from "../core/collections.ts";
import { verifyAuthToken } from "../core/sec.ts";

interface IndexInfo {
  name: string;
  field: string;
  unique: boolean;
}

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  // Centralized verifier — fixes N-1 admin-token-bypass.
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

function rawClient(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

function listIndexes(tableName: string): IndexInfo[] {
  const client = rawClient();
  // PRAGMA index_list returns: { seq, name, unique, origin, partial }
  const rows = client.prepare(`PRAGMA index_list(${JSON.stringify(tableName)})`).all() as Array<{
    seq: number;
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }>;
  // Skip auto-generated indexes (e.g. for PRIMARY KEY) — origin == 'pk' or 'u' from schema
  // Keep only indexes we created (origin === 'c' = created by user) AND named with our prefix
  const result: IndexInfo[] = [];
  for (const r of rows) {
    if (r.origin !== "c") continue;
    if (!r.name.startsWith("idx_") && !r.name.startsWith("uniq_")) continue;
    // Get the column(s) the index covers
    const cols = client.prepare(`PRAGMA index_info(${JSON.stringify(r.name)})`).all() as Array<{
      seqno: number;
      cid: number;
      name: string;
    }>;
    if (cols.length === 0) continue;
    result.push({
      name: r.name,
      field: cols.map((c) => c.name).join(","),
      unique: r.unique === 1,
    });
  }
  return result;
}

function indexName(collectionName: string, field: string, unique: boolean): string {
  const prefix = unique ? "uniq" : "idx";
  return `${prefix}_${collectionName}_${field}`;
}

export function makeIndexesPlugin(jwtSecret: string) {
  return (
    new Hono()
      .get("/admin/collections/:name/indexes", async (c) => {
        if (!(await isAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const col = await getCollection(c.req.param("name"));
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        try {
          const indexes = listIndexes(userTableName(col.name));
          return c.json({ data: indexes });
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : String(e), code: 500 }, 500);
        }
      })

      // Create index
      .post(
        "/admin/collections/:name/indexes",
        jsonBody(t.Object({ field: t.String(), unique: t.Optional(t.Boolean()) })),
        async (c) => {
          if (!(await isAdmin(c.req.raw, jwtSecret))) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const col = await getCollection(c.req.param("name"));
          if (!col) {
            return c.json({ error: "Collection not found", code: 404 }, 404);
          }

          const body = c.req.valid("json");
          const fields = parseFields(col.fields);
          const fieldName = body.field;
          if (!/^[a-z0-9_]+$/.test(fieldName)) {
            return c.json({ error: "Field name must match [a-z0-9_]+", code: 422 }, 422);
          }
          const builtIn = ["id", "created_at", "updated_at"];
          const existsInSchema =
            builtIn.includes(fieldName) ||
            fields.some((f) => f.name === fieldName && !f.system && f.type !== "autodate");
          if (!existsInSchema) {
            return c.json(
              { error: `Field '${fieldName}' not found on '${col.name}'`, code: 422 },
              422,
            );
          }

          const isUnique = !!body.unique;
          const name = indexName(col.name, fieldName, isUnique);
          const tableRef = `"${userTableName(col.name)}"`;
          const sql = `CREATE ${isUnique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${name}" ON ${tableRef} ("${fieldName}")`;
          try {
            rawClient().exec(sql);
            return c.json({ data: { name, field: fieldName, unique: isUnique } });
          } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e), code: 422 }, 422);
          }
        },
      )

      // Drop index
      .delete("/admin/collections/:name/indexes/:indexName", async (c) => {
        if (!(await isAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const idxName = c.req.param("indexName");
        // Sanity check: only allow our prefixes
        if (!idxName.startsWith("idx_") && !idxName.startsWith("uniq_")) {
          return c.json(
            { error: "Refusing to drop index outside vaultbase prefix", code: 422 },
            422,
          );
        }
        try {
          rawClient().exec(`DROP INDEX IF EXISTS "${idxName}"`);
          return c.json({ data: null });
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : String(e), code: 500 }, 500);
        }
      })
  );
}
