import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthContext } from "../core/rules.ts";
import { verifyAuthToken } from "../core/sec.ts";
import { getCollection } from "../core/collections.ts";
import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  ReadOnlyCollectionError,
  RestrictError,
  updateRecord,
} from "../core/records.ts";
import { ValidationError } from "../core/validate.ts";
import { runWithHookRequest } from "../core/hooks.ts";
import { checkRule, recordListRule } from "./_rules.ts";
import {
  getHistoryAt,
  listRecordHistory,
  type HistoryListResponse,
} from "../core/record-history.ts";
import { parseFields } from "../core/collections.ts";
import { parseVectorParam, topK, VectorParseError } from "../core/vector.ts";
import { timeFor } from "../core/perf-metrics.ts";

function readOnlyResponse(c: Context, err: ReadOnlyCollectionError) {
  return c.json({ error: err.message, code: 405 }, 405);
}

/**
 * Compute a record's ETag from its `updated_at` (unix-seconds). Wrapped in
 * weak-ETag form (`W/`) because we don't byte-hash the response — two
 * representations of the same record (different field projections, expand,
 * etc.) get the same tag, which weak ETags allow.
 */
function recordEtag(record: Record<string, unknown> | null | undefined): string | null {
  if (!record) return null;
  // The API surface exposes `updated` (records-core's `rowToMetaAsync`); the
  // raw row uses `updated_at`. Accept either so we can call this with both.
  const u = record.updated ?? record.updated_at;
  if (typeof u !== "number" && typeof u !== "string") return null;
  return `W/"${u}"`;
}

/**
 * Parse an `If-Match` / `If-None-Match` header into its individual tags.
 * Accepts the wildcard `*` and quoted strong/weak ETags. Tokens are returned
 * verbatim (with their `W/` prefix preserved); compare via string equality.
 */
function parseIfMatch(header: string): string[] {
  const out: string[] = [];
  // Handle commas, ws, quotes, optional W/ prefix.
  const re = /\s*(?:(W\/)?("(?:[^"\\]|\\.)*")|\*)\s*(?:,|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    if (m[2]) out.push(`${m[1] ? "W/" : ""}${m[2]}`);
    else out.push("*");
  }
  return out;
}

/**
 * Returns `null` when the request's `If-Match` is satisfied (or absent), or a
 * `{ currentEtag }` envelope when the precondition failed and the caller
 * should respond 412. `*` matches any existing record.
 */
function ifMatchFails(
  request: Request,
  existing: Record<string, unknown>,
): { currentEtag: string } | null {
  const header = request.headers.get("if-match");
  if (!header) return null;
  const requested = parseIfMatch(header);
  if (requested.length === 0) return null;
  const current = recordEtag(existing) ?? `W/""`;
  for (const tag of requested) {
    if (tag === "*") return null;
    if (tag === current) return null;
    // Allow a strong-form quoted updated_at (`"123"`) to match the server's
    // weak form (`W/"123"`) — RFC 7232 says weak compare is safe for
    // PATCH/DELETE in this scenario, so we accept either.
    if (`W/${tag}` === current) return null;
    if (tag === current.replace(/^W\//, "")) return null;
  }
  return { currentEtag: current };
}

function validationResponse(c: Context, err: ValidationError) {
  return c.json({ error: "Validation failed", code: 422, details: err.details }, 422);
}

async function getAuthContext(request: Request, jwtSecret: string): Promise<AuthContext | null> {
  return await timeFor(request, "auth_verify", async () => {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return null;
    // Centralized verifier — fixes N-1 admin-token-bypass. Accepts user or
    // admin (records API serves both); checks signature, audience, expiry,
    // issuer, jti revocation, and password_reset_at.
    const ctx = await verifyAuthToken(token, jwtSecret);
    if (!ctx || (ctx.type !== "user" && ctx.type !== "admin")) return null;
    const out: AuthContext = { id: ctx.id, type: ctx.type };
    if (ctx.email) out.email = ctx.email;
    return out;
  });
}

export function makeRecordsPlugin(jwtSecret: string) {
  return (
    new Hono()
      .get("/:collection", async (c) => {
        const request = c.req.raw;
        const collection = c.req.param("collection");
        const col = await timeFor(request, "collection_load", () => getCollection(collection));
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        const auth = await getAuthContext(request, jwtSecret);

        // null = public; "" = admin only; expression rule → applied as filter
        recordListRule(request, col.name, col.list_rule, auth);
        if (col.list_rule === "") {
          if (auth?.type !== "admin") {
            return c.json({ error: "Forbidden", code: 403 }, 403);
          }
        }

        const page = c.req.query("page");
        const perPage = c.req.query("perPage");
        const filter = c.req.query("filter");
        const sort = c.req.query("sort");
        const expand = c.req.query("expand");
        const fields = c.req.query("fields");
        const skipTotal = c.req.query("skipTotal");
        const nearVector = c.req.query("nearVector");
        const nearVectorField = c.req.query("nearVectorField");
        const nearLimit = c.req.query("nearLimit");
        const nearMinScore = c.req.query("nearMinScore");

        const opts: import("../core/records.ts").ListOptions = {
          page: page ? parseInt(page, 10) : 1,
          perPage: perPage ? parseInt(perPage, 10) : 30,
          auth,
        };
        if (filter) opts.filter = filter;
        if (sort) opts.sort = sort;
        if (expand) opts.expand = expand;
        if (fields) opts.fields = fields;
        if (skipTotal === "1" || skipTotal === "true") opts.skipTotal = true;
        // Apply expression rule as access filter (admins bypass)
        if (col.list_rule && col.list_rule !== "" && auth?.type !== "admin") {
          opts.accessRule = col.list_rule;
        }

        // ── Vector similarity search ───────────────────────────────────────
        // When `nearVector` + `nearVectorField` are present, fetch a filtered
        // candidate set (with `filter` / list_rule still applied so we never
        // rank rows the caller can't see) and re-order by cosine similarity.
        // The caller paginates the *ranked* page in-process, so we pull a
        // larger working set and slice — this is fine up to ~50K candidates;
        // beyond that, switch to sqlite-vec.
        if (nearVector && nearVectorField) {
          const fieldDefs = parseFields(col.fields);
          const vecField = fieldDefs.find((f) => f.name === nearVectorField && f.type === "vector");
          if (!vecField) {
            return c.json(
              {
                error: `nearVectorField '${nearVectorField}' is not a vector field on '${col.name}'`,
                code: 422,
              },
              422,
            );
          }
          let queryVec: number[];
          try {
            queryVec = parseVectorParam(nearVector);
          } catch (e) {
            if (e instanceof VectorParseError) {
              return c.json({ error: e.message, code: 422 }, 422);
            }
            throw e;
          }
          const dims = vecField.options?.dimensions ?? queryVec.length;
          if (queryVec.length !== dims) {
            return c.json(
              {
                error: `nearVector length ${queryVec.length} does not match field dimensions ${dims}`,
                code: 422,
              },
              422,
            );
          }

          // Pull a working window. We can't ORDER BY similarity in SQL (yet),
          // so the safe approach is to fetch up to MAX_CANDIDATES rows under
          // the existing access scope and rank in-process.
          const MAX_CANDIDATES = 10_000;
          const candidatePage = await listRecords(collection, {
            ...opts,
            page: 1,
            perPage: MAX_CANDIDATES,
            skipTotal: true,
          });

          const candidates = candidatePage.data
            .map((r) => {
              const v = r[nearVectorField];
              return Array.isArray(v)
                ? { id: r.id as string, vector: v as number[], record: r }
                : null;
            })
            .filter(
              (
                x,
              ): x is {
                id: string;
                vector: number[];
                record: (typeof candidatePage.data)[number];
              } => x !== null,
            );

          const limit = nearLimit ? Math.max(1, Math.min(1000, parseInt(nearLimit, 10))) : 10;
          const ranked = topK({
            query: queryVec,
            candidates: candidates.map((cand) => ({ id: cand.id, vector: cand.vector })),
            limit,
            ...(nearMinScore ? { minScore: parseFloat(nearMinScore) } : {}),
          });
          const byId = new Map(candidates.map((cand) => [cand.id, cand.record]));
          const data = ranked
            .map((mtch) => {
              const rec = byId.get(mtch.id);
              if (!rec) return null;
              return { ...rec, _score: mtch.score };
            })
            .filter(Boolean);
          return c.json({
            data,
            page: 1,
            perPage: data.length,
            totalItems: data.length,
            totalPages: 1,
          });
        }

        return c.json(await timeFor(request, "db_exec", () => listRecords(collection, opts)));
      })
      .get("/:collection/:id", async (c) => {
        const request = c.req.raw;
        const collection = c.req.param("collection");
        const id = c.req.param("id");
        const col = await timeFor(request, "collection_load", () => getCollection(collection));
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        const auth = await getAuthContext(request, jwtSecret);
        const record = await timeFor(request, "db_exec", () => getRecord(collection, id));
        if (!record) {
          return c.json({ error: "Record not found", code: 404 }, 404);
        }
        if (
          !checkRule(
            request,
            "view_rule",
            col.name,
            col.view_rule,
            auth,
            record as unknown as Record<string, unknown>,
          )
        ) {
          return c.json({ error: "Forbidden", code: 403 }, 403);
        }
        const etag = recordEtag(record as unknown as Record<string, unknown>);
        if (etag) c.header("ETag", etag);
        // Honor If-None-Match for cheap conditional GETs.
        const inm = request.headers.get("if-none-match");
        if (etag && inm && parseIfMatch(inm).some((tag) => tag === etag || tag === "*")) {
          return c.body(null, 304);
        }
        return c.json({ data: record });
      })
      .post("/:collection", async (c) => {
        const request = c.req.raw;
        const collection = c.req.param("collection");
        const col = await getCollection(collection);
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        const body = await c.req.json().catch(() => undefined);
        const auth = await getAuthContext(request, jwtSecret);
        // For create, rule evaluates against the incoming body
        if (
          !checkRule(
            request,
            "create_rule",
            col.name,
            col.create_rule,
            auth,
            (body ?? {}) as Record<string, unknown>,
          )
        ) {
          return c.json({ error: "Forbidden", code: 403 }, 403);
        }
        try {
          const record = await runWithHookRequest(request, () =>
            createRecord(collection, body as Record<string, unknown>, auth),
          );
          return c.json({ data: record });
        } catch (e) {
          if (e instanceof ValidationError) return validationResponse(c, e);
          if (e instanceof ReadOnlyCollectionError) return readOnlyResponse(c, e);
          throw e;
        }
      })
      .patch("/:collection/:id", async (c) => {
        const request = c.req.raw;
        const collection = c.req.param("collection");
        const id = c.req.param("id");
        const col = await getCollection(collection);
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        const body = await c.req.json().catch(() => undefined);
        const auth = await getAuthContext(request, jwtSecret);
        const existing = await getRecord(collection, id);
        if (!existing) {
          return c.json({ error: "Record not found", code: 404 }, 404);
        }
        if (
          !checkRule(
            request,
            "update_rule",
            col.name,
            col.update_rule,
            auth,
            existing as unknown as Record<string, unknown>,
          )
        ) {
          return c.json({ error: "Forbidden", code: 403 }, 403);
        }
        const ifMatch = ifMatchFails(request, existing as unknown as Record<string, unknown>);
        if (ifMatch) {
          c.header("ETag", ifMatch.currentEtag);
          return c.json({ error: "Precondition Failed: record was modified", code: 412 }, 412);
        }
        try {
          const record = await runWithHookRequest(request, () =>
            updateRecord(collection, id, body as Record<string, unknown>, auth),
          );
          const etag = recordEtag(record as unknown as Record<string, unknown>);
          if (etag) c.header("ETag", etag);
          return c.json({ data: record });
        } catch (e) {
          if (e instanceof ValidationError) return validationResponse(c, e);
          if (e instanceof ReadOnlyCollectionError) return readOnlyResponse(c, e);
          throw e;
        }
      })
      .delete("/:collection/:id", async (c) => {
        const request = c.req.raw;
        const collection = c.req.param("collection");
        const id = c.req.param("id");
        const col = await getCollection(collection);
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        const auth = await getAuthContext(request, jwtSecret);
        const existing = await getRecord(collection, id);
        if (!existing) {
          return c.json({ error: "Record not found", code: 404 }, 404);
        }
        if (
          !checkRule(
            request,
            "delete_rule",
            col.name,
            col.delete_rule,
            auth,
            existing as unknown as Record<string, unknown>,
          )
        ) {
          return c.json({ error: "Forbidden", code: 403 }, 403);
        }
        const ifMatch = ifMatchFails(request, existing as unknown as Record<string, unknown>);
        if (ifMatch) {
          c.header("ETag", ifMatch.currentEtag);
          return c.json({ error: "Precondition Failed: record was modified", code: 412 }, 412);
        }
        try {
          await runWithHookRequest(request, () => deleteRecord(collection, id, auth));
        } catch (e) {
          if (e instanceof ValidationError) return validationResponse(c, e);
          if (e instanceof ReadOnlyCollectionError) return readOnlyResponse(c, e);
          if (e instanceof RestrictError) {
            return c.json({ error: e.message, code: 409, details: e.details }, 409);
          }
          throw e;
        }
        return c.json({ data: null });
      })

      // ── Record history ──────────────────────────────────────────────────────
      //
      // Both endpoints inherit the parent record's `view_rule` for read access:
      // if you can view the live record, you can read its history. Restore is
      // admin-only — restoring overwrites someone else's edit.

      .get("/:collection/:id/history", async (c) => {
        const request = c.req.raw;
        const collection = c.req.param("collection");
        const id = c.req.param("id");
        const col = await getCollection(collection);
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        if (col.history_enabled !== 1) {
          return c.json({ error: "history is not enabled for this collection", code: 404 }, 404);
        }
        const auth = await getAuthContext(request, jwtSecret);
        const existing = await getRecord(collection, id);
        // Allow listing history rows even after a delete — gate purely on view_rule
        // against the most recent snapshot.
        const recordForRule = (existing ??
          (await getHistoryAt(collection, id, Math.floor(Date.now() / 1000)))?.snapshot) as
          | Record<string, unknown>
          | undefined;
        if (!recordForRule) {
          return c.json({ error: "Record not found", code: 404 }, 404);
        }
        if (!checkRule(request, "view_rule", col.name, col.view_rule, auth, recordForRule)) {
          return c.json({ error: "Forbidden", code: 403 }, 403);
        }
        const perPageRaw = c.req.query("perPage");
        const pageRaw = c.req.query("page");
        const perPage = perPageRaw ? parseInt(perPageRaw, 10) : 50;
        const page = pageRaw ? parseInt(pageRaw, 10) : 1;
        const out: HistoryListResponse = await listRecordHistory(collection, id, {
          perPage,
          page,
        });
        return c.json({ data: out });
      })

      .post("/:collection/:id/restore", async (c) => {
        const request = c.req.raw;
        const collection = c.req.param("collection");
        const id = c.req.param("id");
        const col = await getCollection(collection);
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        if (col.history_enabled !== 1) {
          return c.json({ error: "history is not enabled for this collection", code: 404 }, 404);
        }
        const auth = await getAuthContext(request, jwtSecret);
        if (auth?.type !== "admin") {
          return c.json({ error: "restore is admin-only", code: 403 }, 403);
        }
        const atRaw = c.req.query("at");
        if (!atRaw) {
          return c.json({ error: "?at=<unix-seconds> is required", code: 422 }, 422);
        }
        const at = parseInt(String(atRaw), 10);
        if (!Number.isFinite(at) || at <= 0) {
          return c.json({ error: "?at must be a positive unix-seconds integer", code: 422 }, 422);
        }
        const entry = await getHistoryAt(collection, id, at);
        if (!entry) {
          return c.json({ error: "no history entry at-or-before that timestamp", code: 404 }, 404);
        }

        // Filter out fields managed by records-core (id / created_at / updated_at /
        // file metadata) before passing to update — these are either immutable or
        // get re-set on write.
        const snap = { ...entry.snapshot };
        delete snap.id;
        delete snap.created_at;
        delete snap.updated_at;

        const live = await getRecord(collection, id);
        if (!live) {
          // V1: restoring a deleted record is not supported because `createRecord`
          // mints its own id. Callers can `POST /api/:collection` with the
          // snapshot body to recreate, accepting that they'll get a new id.
          return c.json(
            {
              error: "record was deleted; restore-from-deleted is not supported in v1",
              code: 409,
            },
            409,
          );
        }

        try {
          const result = await runWithHookRequest(request, () =>
            updateRecord(collection, id, snap, auth),
          );
          return c.json({ data: result });
        } catch (e) {
          if (e instanceof ValidationError) return validationResponse(c, e);
          if (e instanceof ReadOnlyCollectionError) return readOnlyResponse(c, e);
          throw e;
        }
      })
  );
}
