import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import { listCollections, parseFields } from "../core/collections.ts";
import {
  applySnapshot,
  computeSnapshotDiff,
  describeCollectionChanges,
  SnapshotShapeError,
  type ApplyMode,
  type CollectionSnapshot,
  type Snapshot,
} from "../core/migrations.ts";
import { requireAdmin } from "../core/sec.ts";

/**
 * Re-exported for tests / older imports — the canonical home is now
 * `src/core/migrations.ts`.
 */
export const _describeCollectionChanges = describeCollectionChanges;
export { computeSnapshotDiff };

export function makeMigrationsPlugin(jwtSecret: string) {
  return new Hono()
    .get("/admin/migrations/snapshot", async (c) => {
      if (!(await requireAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const cols = await listCollections();
      const snapshot: Snapshot = {
        generated_at: new Date().toISOString(),
        version: 1,
        collections: cols.map((col): CollectionSnapshot => {
          const out: CollectionSnapshot = {
            name: col.name,
            type: (col.type ?? "base") as "base" | "auth" | "view",
            fields: parseFields(col.fields),
          };
          if (col.view_query !== null && col.view_query !== undefined)
            out.view_query = col.view_query;
          if (col.list_rule !== null && col.list_rule !== undefined) out.list_rule = col.list_rule;
          if (col.view_rule !== null && col.view_rule !== undefined) out.view_rule = col.view_rule;
          if (col.create_rule !== null && col.create_rule !== undefined)
            out.create_rule = col.create_rule;
          if (col.update_rule !== null && col.update_rule !== undefined)
            out.update_rule = col.update_rule;
          if (col.delete_rule !== null && col.delete_rule !== undefined)
            out.delete_rule = col.delete_rule;
          return out;
        }),
      };
      c.header(
        "Content-Disposition",
        `attachment; filename="vaultbase-snapshot-${snapshot.generated_at.slice(0, 10)}.json"`,
      );
      return c.json(snapshot);
    })

    .post("/admin/migrations/diff", jsonBody(t.Object({ snapshot: t.Any() })), async (c) => {
      if (!(await requireAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const body = c.req.valid("json");
      if (!body.snapshot || typeof body.snapshot !== "object") {
        return c.json({ error: "snapshot object required", code: 422 }, 422);
      }
      const snap = body.snapshot as Snapshot;
      if (snap.version !== 1) {
        return c.json({ error: `Unsupported snapshot version: ${snap.version}`, code: 422 }, 422);
      }
      if (!Array.isArray(snap.collections)) {
        return c.json({ error: "snapshot.collections must be an array", code: 422 }, 422);
      }
      const data = await computeSnapshotDiff(snap);
      return c.json({ data });
    })

    .post(
      "/admin/migrations/apply",
      jsonBody(t.Object({ snapshot: t.Any(), mode: t.Optional(t.String()) })),
      async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const body = c.req.valid("json");
        if (!body.snapshot || typeof body.snapshot !== "object") {
          return c.json({ error: "snapshot object required", code: 422 }, 422);
        }

        const mode = (body.mode ?? "additive") as ApplyMode;
        if (mode !== "additive" && mode !== "sync") {
          return c.json({ error: "mode must be 'additive' or 'sync'", code: 422 }, 422);
        }

        let result;
        try {
          result = await applySnapshot(body.snapshot, { mode });
        } catch (e) {
          if (e instanceof SnapshotShapeError) {
            return c.json({ error: e.message, code: 422 }, 422);
          }
          throw e;
        }

        // Preserve the existing HTTP response shape: callers expect
        // `{ created, updated, skipped, errors }` where `skipped` is the union
        // of "skipped because additive" + "unchanged because already in sync".
        return c.json({
          data: {
            created: result.created,
            updated: result.updated,
            skipped: [...result.skipped, ...result.unchanged],
            errors: result.errors,
          },
        });
      },
    );
}
