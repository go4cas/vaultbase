import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthContext } from "../core/rules.ts";
import { verifyAuthToken } from "../core/sec.ts";
import { hasScope, stripApiTokenPrefix } from "../core/api-tokens.ts";
import { getCollection } from "../core/collections.ts";
import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  KeysetError,
  ReadOnlyCollectionError,
  RestrictError,
  updateRecord,
  vectorSearch,
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
import { parseVectorParam, VectorParseError } from "../core/vector.ts";
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

/**
 * Auth for a records request: the rule-engine {@link AuthContext} (null when
 * anonymous) plus the API-token scope info needed to enforce per-collection
 * token scopes (F-10). Direct user/admin sessions carry no scopes and are never
 * scope-restricted — only API-token principals (`viaApiToken`) are.
 */
interface RecordAuth {
  auth: AuthContext | null;
  viaApiToken: boolean;
  scopes: string[];
}

async function getRecordAuth(request: Request, jwtSecret: string): Promise<RecordAuth> {
  return await timeFor(request, "auth_verify", async () => {
    const raw = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!raw) return { auth: null, viaApiToken: false, scopes: [] };
    // Strip the `cwat_`/`vbat_` API-token prefix so API tokens authenticate on
    // the REST records surface (they carry per-collection scopes enforced below).
    const token = stripApiTokenPrefix(raw);
    // Centralized verifier — fixes N-1 admin-token-bypass. Accepts user or
    // admin (records API serves both); checks signature, audience, expiry,
    // issuer, jti revocation, and password_reset_at.
    const ctx = await verifyAuthToken(token, jwtSecret);
    if (!ctx || (ctx.type !== "user" && ctx.type !== "admin"))
      return { auth: null, viaApiToken: false, scopes: [] };
    const out: AuthContext = { id: ctx.id, type: ctx.type };
    if (ctx.email) out.email = ctx.email;
    return { auth: out, viaApiToken: !!ctx.viaApiToken, scopes: ctx.scopes ?? [] };
  });
}

/**
 * Enforce per-collection API-token scopes (F-10). Direct sessions (not via an
 * API token) are unrestricted here — their access is governed by collection
 * rules / admin bypass as before. An API-token principal must carry a scope
 * satisfying `collection:<name>:<action>` (global `read`/`write` still count).
 */
function tokenScopeAllows(a: RecordAuth, collection: string, method: string): boolean {
  if (!a.viaApiToken) return true;
  const action = method === "GET" || method === "HEAD" ? "read" : "write";
  return hasScope(a.scopes, `collection:${collection}:${action}`);
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
        const authz = await getRecordAuth(request, jwtSecret);
        if (!tokenScopeAllows(authz, collection, c.req.method))
          return c.json({ error: "Insufficient token scope", code: 403 }, 403);
        const auth = authz.auth;

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
        const search = c.req.query("search");
        const cursor = c.req.query("cursor");
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
        if (search) opts.search = search;
        if (cursor !== undefined) opts.cursor = cursor; // "" = first keyset page
        if (sort) opts.sort = sort;
        if (expand) opts.expand = expand;
        if (fields) opts.fields = fields;
        if (skipTotal === "1" || skipTotal === "true") opts.skipTotal = true;
        // Apply expression rule as access filter (admins bypass)
        if (col.list_rule && col.list_rule !== "" && auth?.type !== "admin") {
          opts.accessRule = col.list_rule;
        }

        // ── Vector similarity search ───────────────────────────────────────
        // `nearVector` + `nearVectorField` → cosine KNN, ranked in-process under
        // the same filter / list_rule scope (never ranks rows the caller can't
        // see). See core `vectorSearch`: a lean id+vector scan with a cached
        // parse, no silent candidate cap, and full records built only for top-K.
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

          // Lean two-phase KNN (see core `vectorSearch`): scans id+vector under
          // the same filter/access scope with a cached parse (no silent 10K cap
          // — bounded by `vector.max_candidates`, `truncated` signals when hit),
          // then materializes only the top-K.
          const limit = nearLimit ? Math.max(1, Math.min(1000, parseInt(nearLimit, 10))) : 10;
          const { data, scanned, truncated } = await vectorSearch(
            collection,
            nearVectorField,
            queryVec,
            {
              ...opts,
              limit,
              ...(nearMinScore ? { minScore: parseFloat(nearMinScore) } : {}),
            },
          );
          return c.json({
            data,
            page: 1,
            perPage: data.length,
            totalItems: data.length,
            totalPages: 1,
            _vector: { scanned, truncated },
          });
        }

        try {
          const result = await timeFor(request, "db_exec", () => listRecords(collection, opts));
          // Keyset mode returns a cursor instead of page/total (no COUNT run).
          if (opts.cursor !== undefined) {
            return c.json({
              data: result.data,
              perPage: result.perPage,
              nextCursor: result.nextCursor ?? null,
            });
          }
          return c.json(result);
        } catch (e) {
          if (e instanceof KeysetError) return c.json({ error: e.message, code: 400 }, 400);
          throw e;
        }
      })
      .get("/:collection/:id", async (c) => {
        const request = c.req.raw;
        const collection = c.req.param("collection");
        const id = c.req.param("id");
        const col = await timeFor(request, "collection_load", () => getCollection(collection));
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        const authz = await getRecordAuth(request, jwtSecret);
        if (!tokenScopeAllows(authz, collection, c.req.method))
          return c.json({ error: "Insufficient token scope", code: 403 }, 403);
        const auth = authz.auth;
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
        const authz = await getRecordAuth(request, jwtSecret);
        if (!tokenScopeAllows(authz, collection, c.req.method))
          return c.json({ error: "Insufficient token scope", code: 403 }, 403);
        const auth = authz.auth;
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
        const authz = await getRecordAuth(request, jwtSecret);
        if (!tokenScopeAllows(authz, collection, c.req.method))
          return c.json({ error: "Insufficient token scope", code: 403 }, 403);
        const auth = authz.auth;
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
        const authz = await getRecordAuth(request, jwtSecret);
        if (!tokenScopeAllows(authz, collection, c.req.method))
          return c.json({ error: "Insufficient token scope", code: 403 }, 403);
        const auth = authz.auth;
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
        const authz = await getRecordAuth(request, jwtSecret);
        if (!tokenScopeAllows(authz, collection, c.req.method))
          return c.json({ error: "Insufficient token scope", code: 403 }, 403);
        const auth = authz.auth;
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
        const authz = await getRecordAuth(request, jwtSecret);
        if (!tokenScopeAllows(authz, collection, c.req.method))
          return c.json({ error: "Insufficient token scope", code: 403 }, 403);
        const auth = authz.auth;
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
