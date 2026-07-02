/**
 * Admin SQL runner — REST surface for `/_/sql`.
 *
 *   POST   /admin/sql/run                 — execute a SQL string
 *   POST   /admin/sql/sandbox/reset       — rebuild the admin's sandbox
 *   DELETE /admin/sql/sandbox             — drop the sandbox
 *   GET    /admin/sql/sandbox             — describe current sandbox state
 *
 *   GET    /admin/sql/queries             — list saved queries (per-admin)
 *   POST   /admin/sql/queries             — save
 *   GET    /admin/sql/queries/:id         — get one
 *   PATCH  /admin/sql/queries/:id         — update
 *   DELETE /admin/sql/queries/:id         — delete
 *   POST   /admin/sql/queries/:id/run     — run + bookkeep last_run_*
 *
 * Admin-only (audience: "admin"). API tokens — even with `admin` scope —
 * cannot drive these endpoints; we explicitly require an interactive
 * admin session because raw SQL bypasses every safety net (rules,
 * validation, hooks, audit trigger semantics) the rest of the system
 * depends on. Saved-query rows are owner-scoped.
 */

import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import { Database } from "bun:sqlite";
import { extractBearer, verifyAuthToken } from "../core/sec.ts";
import { runSql, MAX_SQL_RESULT_ROWS } from "../core/sql-runner.ts";
import { describeSandbox, dropSandbox, resetSandbox, sandboxExists } from "../core/sql-sandbox.ts";
import {
  createSavedQuery,
  deleteSavedQuery,
  getSavedQuery,
  listSavedQueries,
  recordSavedQueryRun,
  updateSavedQuery,
} from "../core/sql-queries.ts";

interface AdminCtx {
  id: string;
  email: string;
}

async function getAdmin(request: Request, jwtSecret: string): Promise<AdminCtx | null> {
  const token = extractBearer(request);
  if (!token) return null;
  const ctx = await verifyAuthToken(token, jwtSecret, { audience: "admin" });
  if (!ctx) return null;
  // Reject when the auth came from an API token (admin-acting). Raw SQL
  // is interactive-only; tokens get the MCP `run_sql` tool instead.
  if (ctx.viaApiToken) return null;
  return { id: ctx.id, email: ctx.email ?? "" };
}

export function makeSqlPlugin(jwtSecret: string, dbPath: string) {
  return (
    new Hono()
      // ── Run ────────────────────────────────────────────────────────────
      .post(
        "/admin/sql/run",
        jsonBody(
          t.Object({
            sql: t.String({ maxLength: 100_000 }),
            mode: t.Union([t.Literal("readonly"), t.Literal("sandbox")]),
            params: t.Optional(t.Array(t.Union([t.String(), t.Number(), t.Boolean(), t.Null()]))),
            timeoutMs: t.Optional(t.Number({ minimum: 100, maximum: 30_000 })),
          }),
        ),
        async (c) => {
          const me = await getAdmin(c.req.raw, jwtSecret);
          if (!me) {
            return c.json(
              { error: "Unauthorized — interactive admin session required", code: 401 },
              401,
            );
          }
          const body = c.req.valid("json");

          if (body.mode === "sandbox" && !sandboxExists(me.id)) {
            // Auto-create on first sandbox run for a friendlier UX. Caller can
            // also explicitly POST /sandbox/reset to rebuild on demand.
            resetSandbox(me.id, dbPath);
          }

          const result = await runSql({
            sql: body.sql,
            dbPath,
            adminId: me.id,
            mode: body.mode,
            ...(body.params ? { params: body.params } : {}),
            ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
          });
          return c.json({ data: result });
        },
      )

      // ── Sandbox lifecycle ──────────────────────────────────────────────
      .get("/admin/sql/sandbox", async (c) => {
        const me = await getAdmin(c.req.raw, jwtSecret);
        if (!me) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        return c.json({ data: describeSandbox(me.id) });
      })
      .post("/admin/sql/sandbox/reset", async (c) => {
        const me = await getAdmin(c.req.raw, jwtSecret);
        if (!me) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        try {
          const info = resetSandbox(me.id, dbPath);
          return c.json({ data: info });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return c.json({ error: `Sandbox reset failed: ${msg}`, code: 500 }, 500);
        }
      })
      .delete("/admin/sql/sandbox", async (c) => {
        const me = await getAdmin(c.req.raw, jwtSecret);
        if (!me) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const removed = dropSandbox(me.id);
        return c.json({ data: { removed } });
      })

      // ── Saved queries ──────────────────────────────────────────────────
      .get("/admin/sql/queries", async (c) => {
        const me = await getAdmin(c.req.raw, jwtSecret);
        if (!me) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        return c.json({ data: await listSavedQueries(me.id) });
      })
      .post(
        "/admin/sql/queries",
        jsonBody(
          t.Object({
            name: t.String({ minLength: 1, maxLength: 100 }),
            sql: t.String({ minLength: 1, maxLength: 100_000 }),
            description: t.Optional(t.String({ maxLength: 500 })),
          }),
        ),
        async (c) => {
          const me = await getAdmin(c.req.raw, jwtSecret);
          if (!me) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const body = c.req.valid("json");
          try {
            const q = await createSavedQuery({
              name: body.name,
              sql: body.sql,
              ...(body.description !== undefined ? { description: body.description } : {}),
              ownerAdminId: me.id,
              ownerAdminEmail: me.email,
            });
            return c.json({ data: q });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return c.json({ error: msg, code: 400 }, 400);
          }
        },
      )
      .get("/admin/sql/queries/:id", async (c) => {
        const me = await getAdmin(c.req.raw, jwtSecret);
        if (!me) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const q = await getSavedQuery(c.req.param("id"), me.id);
        if (!q) {
          return c.json({ error: "Not found", code: 404 }, 404);
        }
        return c.json({ data: q });
      })
      .patch(
        "/admin/sql/queries/:id",
        jsonBody(
          t.Object({
            name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
            sql: t.Optional(t.String({ minLength: 1, maxLength: 100_000 })),
            description: t.Optional(t.Union([t.String({ maxLength: 500 }), t.Null()])),
          }),
        ),
        async (c) => {
          const me = await getAdmin(c.req.raw, jwtSecret);
          if (!me) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const body = c.req.valid("json");
          try {
            const patch: { name?: string; sql?: string; description?: string | null } = {};
            if (body.name !== undefined) patch.name = body.name;
            if (body.sql !== undefined) patch.sql = body.sql;
            if (body.description !== undefined) patch.description = body.description;
            const q = await updateSavedQuery(c.req.param("id"), me.id, patch);
            if (!q) {
              return c.json({ error: "Not found", code: 404 }, 404);
            }
            return c.json({ data: q });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return c.json({ error: msg, code: 400 }, 400);
          }
        },
      )
      .delete("/admin/sql/queries/:id", async (c) => {
        const me = await getAdmin(c.req.raw, jwtSecret);
        if (!me) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const ok = await deleteSavedQuery(c.req.param("id"), me.id);
        if (!ok) {
          return c.json({ error: "Not found", code: 404 }, 404);
        }
        return c.json({ data: { deleted: true } });
      })
      .post(
        "/admin/sql/queries/:id/run",
        jsonBody(
          t.Object({
            mode: t.Union([t.Literal("readonly"), t.Literal("sandbox")]),
          }),
        ),
        async (c) => {
          const me = await getAdmin(c.req.raw, jwtSecret);
          if (!me) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const id = c.req.param("id");
          const q = await getSavedQuery(id, me.id);
          if (!q) {
            return c.json({ error: "Not found", code: 404 }, 404);
          }
          const body = c.req.valid("json");

          if (body.mode === "sandbox" && !sandboxExists(me.id)) resetSandbox(me.id, dbPath);

          const result = await runSql({
            sql: q.sql,
            dbPath,
            adminId: me.id,
            mode: body.mode,
          });
          await recordSavedQueryRun(id, me.id, {
            ok: result.ok,
            durationMs: result.durationMs,
            rowCount: result.rowCount,
            error: result.error ?? null,
          });
          return c.json({ data: result });
        },
      )

      // ── Constants the UI may want to know ──────────────────────────────
      .get("/admin/sql/meta", async (c) => {
        const me = await getAdmin(c.req.raw, jwtSecret);
        if (!me) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        return c.json({ data: { maxRows: MAX_SQL_RESULT_ROWS } });
      })

      // ── Rich schema for IDE intellisense ───────────────────────────────
      // Pulls PRAGMA table_info + index_list + foreign_key_list for every
      // table + view in the live DB. Powers the editor's autocomplete +
      // hover providers. Read-only — no schema mutation here.
      .get("/admin/sql/schema", async (c) => {
        const me = await getAdmin(c.req.raw, jwtSecret);
        if (!me) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        try {
          return c.json({ data: introspectSchema(dbPath) });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return c.json({ error: `Schema introspection failed: ${msg}`, code: 500 }, 500);
        }
      })
  );
}

// ── Schema introspection ─────────────────────────────────────────────────

interface SchemaColumn {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  dflt: string | null;
  /** True when at least one index covers this column. */
  indexed: boolean;
}
interface SchemaIndex {
  name: string;
  cols: string[];
  unique: boolean;
  partial: boolean;
}
interface SchemaForeignKey {
  col: string;
  refTable: string;
  refCol: string;
}
interface SchemaTable {
  name: string;
  type: "table" | "view";
  /** Convention-flag: vb_ tables back vaultbase collections; vaultbase_ tables are system; sqlite_ tables are SQLite internal. */
  kind: "collection" | "system" | "user" | "sqlite";
  collectionName?: string;
  columns: SchemaColumn[];
  indexes: SchemaIndex[];
  foreignKeys: SchemaForeignKey[];
  /** Approximate row count (PRAGMA stat / count) — only for small tables. */
  rowCount?: number;
}
interface SchemaResponse {
  tables: SchemaTable[];
  /** Total table + view count (independent of whether returned in `tables`). */
  totals: { tables: number; views: number };
}

const ROW_COUNT_CAP = 100_000;

function tableKind(name: string): SchemaTable["kind"] {
  if (name.startsWith("sqlite_")) return "sqlite";
  if (name.startsWith("vb_")) return "collection";
  if (name.startsWith("vaultbase_")) return "system";
  return "user";
}

function introspectSchema(dbPath: string): SchemaResponse {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    db.exec("PRAGMA query_only = ON");
  } catch {
    /* noop */
  }

  try {
    const objs = db
      .prepare(
        `SELECT name, type FROM sqlite_master
       WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_stat%'
       ORDER BY name`,
      )
      .all() as Array<{ name: string; type: "table" | "view" }>;

    const tables: SchemaTable[] = [];
    let tCount = 0,
      vCount = 0;
    for (const o of objs) {
      if (o.type === "table") tCount++;
      else vCount++;

      // Column metadata.
      const cols = db.prepare(`PRAGMA table_info("${o.name.replace(/"/g, '""')}")`).all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      // Index metadata.
      const idxList = db
        .prepare(`PRAGMA index_list("${o.name.replace(/"/g, '""')}")`)
        .all() as Array<{
        seq: number;
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>;
      const indexes: SchemaIndex[] = [];
      const indexedCols = new Set<string>();
      for (const i of idxList) {
        const cols = (
          db.prepare(`PRAGMA index_info("${i.name.replace(/"/g, '""')}")`).all() as Array<{
            seqno: number;
            cid: number;
            name: string;
          }>
        ).map((c) => c.name);
        indexes.push({ name: i.name, cols, unique: i.unique === 1, partial: i.partial === 1 });
        for (const c of cols) indexedCols.add(c);
      }

      // Foreign keys.
      const fkRows = db
        .prepare(`PRAGMA foreign_key_list("${o.name.replace(/"/g, '""')}")`)
        .all() as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
      }>;
      const foreignKeys: SchemaForeignKey[] = fkRows.map((f) => ({
        col: f.from,
        refTable: f.table,
        refCol: f.to,
      }));

      // PK columns are also "indexed" (auto-index).
      for (const c of cols) {
        if (c.pk) indexedCols.add(c.name);
      }

      // Best-effort row count — cheap on SQLite for tables with rowid + small cardinality.
      let rowCount: number | undefined;
      if (o.type === "table") {
        try {
          const r = db
            .prepare(`SELECT count(*) AS n FROM "${o.name.replace(/"/g, '""')}"`)
            .get() as { n: number };
          if (typeof r?.n === "number" && r.n <= ROW_COUNT_CAP) rowCount = r.n;
          else if (typeof r?.n === "number") rowCount = ROW_COUNT_CAP; // saturate at cap
        } catch {
          /* maybe a strict table that fails count; skip */
        }
      }

      const kind = tableKind(o.name);
      const collectionName = kind === "collection" ? o.name.slice(3) : undefined;

      const table: SchemaTable = {
        name: o.name,
        type: o.type,
        kind,
        ...(collectionName ? { collectionName } : {}),
        columns: cols.map((c) => ({
          name: c.name,
          type: c.type || "BLOB",
          notnull: c.notnull === 1,
          pk: c.pk > 0,
          dflt: c.dflt_value,
          indexed: indexedCols.has(c.name),
        })),
        indexes,
        foreignKeys,
        ...(rowCount !== undefined ? { rowCount } : {}),
      };
      tables.push(table);
    }

    return { tables, totals: { tables: tCount, views: vCount } };
  } finally {
    db.close();
  }
}
