import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import { requireAdmin } from "../core/sec.ts";
import {
  CollectionValidationError,
  createCollection,
  deleteCollection,
  getCollection,
  inferViewColumns,
  inferViewFields,
  previewViewRows,
  listCollections,
  updateCollection,
  userTableName,
  validateViewQuery,
} from "../core/collections.ts";
import { getRawClient } from "../db/client.ts";

// Elysia's `t.Nullable(x)` → TypeBox `Union([x, Null])`.
const nullableString = () => t.Union([t.String(), t.Null()]);

// Admin gate via the centralized verifier (jti revocation + password_reset_at).
// Previously a local `jose.jwtVerify` that skipped revocation — a revoked admin
// token could still create/patch/delete collections (N-1 admin-token-bypass).
const isAdmin = requireAdmin;

export function makeCollectionsPlugin(jwtSecret: string) {
  return (
    new Hono()
      .get("/collections", async (c) => {
        const data = await listCollections();
        return c.json({ data });
      })
      .get("/collections/:id", async (c) => {
        const col = await getCollection(c.req.param("id"));
        if (!col) {
          return c.json({ error: "Not found", code: 404 }, 404);
        }
        return c.json({ data: col });
      })
      .post(
        "/collections",
        jsonBody(
          t.Object({
            name: t.String(),
            type: t.Optional(t.String()),
            fields: t.Optional(t.Array(t.Any())),
            view_query: t.Optional(t.String()),
            list_rule: t.Optional(nullableString()),
            view_rule: t.Optional(nullableString()),
            create_rule: t.Optional(nullableString()),
            update_rule: t.Optional(nullableString()),
            delete_rule: t.Optional(nullableString()),
            history_enabled: t.Optional(t.Boolean()),
          }),
        ),
        async (c) => {
          if (!(await isAdmin(c.req.raw, jwtSecret))) {
            return c.json({ error: "Forbidden", code: 403 }, 403);
          }
          const body = c.req.valid("json");
          const type = body.type ?? "base";
          if (type !== "base" && type !== "auth" && type !== "view") {
            return c.json({ error: "type must be 'base', 'auth', or 'view'", code: 422 }, 422);
          }
          if (type === "view" && !body.view_query) {
            return c.json({ error: "view collections require a view_query", code: 422 }, 422);
          }
          try {
            const init: Parameters<typeof createCollection>[0] = {
              name: body.name,
              type,
              fields: JSON.stringify(body.fields ?? []),
              create_rule: body.create_rule ?? null,
              update_rule: body.update_rule ?? null,
              delete_rule: body.delete_rule ?? null,
            };
            // Only forward list/view rules if explicitly provided so view-collection
            // safe defaults (admin-only) kick in when omitted.
            if (body.list_rule !== undefined) init.list_rule = body.list_rule;
            if (body.view_rule !== undefined) init.view_rule = body.view_rule;
            if (body.view_query !== undefined) init.view_query = body.view_query;
            if (body.history_enabled !== undefined)
              init.history_enabled = body.history_enabled ? 1 : 0;
            const col = await createCollection(init);
            return c.json({ data: col });
          } catch (e) {
            if (e instanceof CollectionValidationError) {
              return c.json({ error: e.message, code: 422, details: e.details }, 422);
            }
            if (e instanceof Error && /view query/i.test(e.message)) {
              return c.json({ error: e.message, code: 422 }, 422);
            }
            // SQLite UNIQUE on collection name → friendly 400 instead of crashing
            if (
              e instanceof Error &&
              /UNIQUE constraint failed.*collections\.name/i.test(e.message)
            ) {
              return c.json(
                { error: `A collection named '${body.name}' already exists`, code: 400 },
                400,
              );
            }
            throw e;
          }
        },
      )
      .patch(
        "/collections/:id",
        jsonBody(
          t.Object({
            name: t.Optional(t.String()),
            fields: t.Optional(t.Array(t.Any())),
            view_query: t.Optional(t.String()),
            list_rule: t.Optional(nullableString()),
            view_rule: t.Optional(nullableString()),
            create_rule: t.Optional(nullableString()),
            update_rule: t.Optional(nullableString()),
            delete_rule: t.Optional(nullableString()),
            history_enabled: t.Optional(t.Boolean()),
          }),
        ),
        async (c) => {
          if (!(await isAdmin(c.req.raw, jwtSecret))) {
            return c.json({ error: "Forbidden", code: 403 }, 403);
          }
          const body = c.req.valid("json");
          const update: Record<string, unknown> = {};
          if (body.name !== undefined) update.name = body.name;
          if (body.fields !== undefined) update.fields = JSON.stringify(body.fields);
          if (body.view_query !== undefined) update.view_query = body.view_query;
          if ("list_rule" in body) update.list_rule = body.list_rule;
          if ("view_rule" in body) update.view_rule = body.view_rule;
          if ("create_rule" in body) update.create_rule = body.create_rule;
          if ("update_rule" in body) update.update_rule = body.update_rule;
          if ("delete_rule" in body) update.delete_rule = body.delete_rule;
          if (body.history_enabled !== undefined)
            update.history_enabled = body.history_enabled ? 1 : 0;
          try {
            const col = await updateCollection(
              c.req.param("id"),
              update as Parameters<typeof updateCollection>[1],
            );
            return c.json({ data: col });
          } catch (e) {
            if (e instanceof CollectionValidationError) {
              return c.json({ error: e.message, code: 422, details: e.details }, 422);
            }
            if (e instanceof Error && /view query/i.test(e.message)) {
              return c.json({ error: e.message, code: 422 }, 422);
            }
            if (
              e instanceof Error &&
              /UNIQUE constraint failed.*collections\.name/i.test(e.message)
            ) {
              return c.json(
                { error: `A collection with that name already exists`, code: 400 },
                400,
              );
            }
            throw e;
          }
        },
      )
      // Dry-run a view query: validate syntax + infer columns. Lets the admin UI
      // surface errors and refresh the field list without actually creating a view.
      .post(
        "/admin/collections/preview-view",
        jsonBody(t.Object({ view_query: t.String() })),
        async (c) => {
          if (!(await isAdmin(c.req.raw, jwtSecret))) {
            return c.json({ error: "Forbidden", code: 403 }, 403);
          }
          const body = c.req.valid("json");
          try {
            validateViewQuery(body.view_query);
            const columns = inferViewColumns(body.view_query);
            const fields = inferViewFields(body.view_query);
            return c.json({ data: { columns, fields } });
          } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e), code: 422 }, 422);
          }
        },
      )
      // Preview the first N rows a view query would return. Lets the admin UI
      // sanity-check a query before saving the collection — no view is created.
      .post(
        "/admin/collections/preview-view-rows",
        jsonBody(t.Object({ view_query: t.String(), limit: t.Optional(t.Number()) })),
        async (c) => {
          if (!(await isAdmin(c.req.raw, jwtSecret))) {
            return c.json({ error: "Forbidden", code: 403 }, 403);
          }
          const body = c.req.valid("json");
          try {
            const limit = typeof body.limit === "number" ? body.limit : 5;
            const result = previewViewRows(body.view_query, limit);
            return c.json({ data: result });
          } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e), code: 422 }, 422);
          }
        },
      )
      .delete("/collections/:id", async (c) => {
        if (!(await isAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Forbidden", code: 403 }, 403);
        }
        await deleteCollection(c.req.param("id"));
        return c.json({ data: null });
      })

      // Per-collection counts + activity. Backs the Collections page so the
      // "records" + "activity" cells get real values. Admin-only — exposes
      // table-level cardinality.
      .get("/admin/collections/stats", async (c) => {
        if (!(await isAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Forbidden", code: 403 }, 403);
        }
        const cols = await listCollections();
        const client = getRawClient();
        const now = Math.floor(Date.now() / 1000);
        const recentWindowSec = 24 * 60 * 60; // last 24h
        const cutoff = now - recentWindowSec;
        // Hard cap on count(*) — large tables stay responsive ("50k+" in UI).
        const COUNT_CAP = 50_000;

        const stats = cols.map((col) => {
          const out = {
            name: col.name,
            type: col.type,
            recordCount: null as number | null,
            recordCountCapped: false,
            lastUpdated: null as number | null,
            recentWrites: 0,
          };
          // View collections — counts work via the underlying SELECT but
          // skipping for now (could be huge / expensive). Activity unknowable.
          if (col.type === "view") return out;
          const tname = `"${userTableName(col.name).replace(/"/g, '""')}"`;
          try {
            // Capped count: SELECT count over a LIMIT'd subquery.
            const r = client
              .prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${tname} LIMIT ?)`)
              .get(COUNT_CAP + 1) as { n: number } | undefined;
            if (r) {
              if (r.n > COUNT_CAP) {
                out.recordCount = COUNT_CAP;
                out.recordCountCapped = true;
              } else {
                out.recordCount = r.n;
              }
            }
          } catch {
            /* table missing — leave null */
          }
          try {
            const r = client.prepare(`SELECT max(updated_at) AS m FROM ${tname}`).get() as
              | { m: number | null }
              | undefined;
            if (r?.m != null) out.lastUpdated = r.m;
          } catch {
            /* skip */
          }
          try {
            const r = client
              .prepare(`SELECT count(*) AS n FROM ${tname} WHERE updated_at > ?`)
              .get(cutoff) as { n: number } | undefined;
            if (r) out.recentWrites = r.n;
          } catch {
            /* skip */
          }
          return out;
        });

        return c.json({
          data: stats,
          windowSec: recentWindowSec,
          cap: COUNT_CAP,
        });
      })
  );
}
