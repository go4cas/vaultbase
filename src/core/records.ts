import type { Database } from "bun:sqlite";
import { getDb } from "../db/client.ts";
import type { Collection } from "../db/schema.ts";
import {
  getCollection,
  getCollectionCached,
  listCollections,
  parseFields,
  userTableName,
  type CascadeMode,
  type FieldDef,
} from "./collections.ts";
import { parseFilter, type CollectionLookup } from "./filter.ts";
import { ftsMatchPredicate } from "./fts.ts";
import { topK, parseVectorCached, setVectorCacheCap } from "./vector.ts";
import { getSetting } from "../api/settings.ts";
import { maybeRecordHistory } from "./record-history.ts";

/**
 * Build a lookup the rule SQL compiler uses for joined-collection view_rule
 * inheritance + back-relation ref-field validation. Synchronous interface
 * (the compiler runs in a hot path), so we hit the in-process collection
 * cache. Cold-cache → returns null and the compiler conservatively denies
 * for non-admin callers.
 */
/**
 * Prepared-statement cache — bun:sqlite re-parses SQL on every `.prepare()`
 * call which dominates list-endpoint latency under load. We keep one cached
 * statement per unique SQL string. Evicted only on schema changes (collection
 * rename / field add/drop).
 */
const STMT_CACHE = new Map<string, { stmt: ReturnType<Database["prepare"]> }>();
const STMT_CACHE_MAX = 256;

function getCachedStmt(client: Database, sql: string): ReturnType<Database["prepare"]> {
  const hit = STMT_CACHE.get(sql);
  if (hit) return hit.stmt;
  if (STMT_CACHE.size >= STMT_CACHE_MAX) {
    const oldest = STMT_CACHE.keys().next().value;
    if (oldest !== undefined) STMT_CACHE.delete(oldest);
  }
  const stmt = client.prepare(sql);
  STMT_CACHE.set(sql, { stmt });
  return stmt;
}

function preparedAll(client: Database, sql: string, params: unknown[]): unknown[] {
  return (
    getCachedStmt(client, sql) as unknown as {
      all: (...args: unknown[]) => unknown[];
    }
  ).all(...params);
}

function preparedGet(client: Database, sql: string, params: unknown[]): unknown {
  return (
    getCachedStmt(client, sql) as unknown as {
      get: (...args: unknown[]) => unknown;
    }
  ).get(...params);
}

/** Drop the cache when collection schema changes. */
export function invalidatePreparedStatements(): void {
  STMT_CACHE.clear();
}

function makeCollectionLookup(): CollectionLookup {
  return (name: string) => {
    const col = getCollectionCached(name);
    if (!col) return null;
    let fieldNames: Set<string>;
    try {
      const parsed = parseFields(col.fields);
      fieldNames = new Set(parsed.map((f) => f.name));
    } catch {
      fieldNames = new Set();
    }
    return {
      viewRule: col.view_rule,
      hasField: (n) => fieldNames.has(n) || n === "id" || n === "created_at" || n === "updated_at",
    };
  };
}
import type { AuthContext } from "./rules.ts";
import { broadcast } from "../realtime/manager.ts";
import { dispatchEvent } from "./webhooks.ts";
import { validateRecord } from "./validate.ts";
import { makeHookHelpers, runAfterHook, runBeforeHook } from "./hooks.ts";
import { encryptValue, decryptValue, isEncrypted } from "./encryption.ts";

const ENCRYPTABLE_TYPES = new Set(["text", "email", "url", "json"]);

async function encodeForStorage(val: unknown, field: FieldDef): Promise<unknown> {
  // Password: bcrypt-hash via Bun. Empty/null leaves column null.
  if (field.type === "password") {
    if (val === null || val === undefined || val === "") return null;
    if (typeof val !== "string") return null;
    // Skip if already a hash (idempotent re-save). Bun emits $argon2 by default.
    if (val.startsWith("$argon2") || val.startsWith("$2a$") || val.startsWith("$2b$")) return val;
    return await Bun.password.hash(val);
  }
  const encoded = encodeValue(val, field);
  if (
    field.options?.encrypted &&
    ENCRYPTABLE_TYPES.has(field.type) &&
    typeof encoded === "string" &&
    encoded.length > 0
  ) {
    return await encryptValue(encoded);
  }
  return encoded;
}

async function decodeAfterStorage(val: unknown, field: FieldDef): Promise<unknown> {
  if (field.options?.encrypted && typeof val === "string" && isEncrypted(val)) {
    const plain = await decryptValue(val);
    return decodeValue(plain, field);
  }
  return decodeValue(val, field);
}

/**
 * Auth-system columns on `cw_<auth-col>` that must never appear in API
 * responses. Stripped on every row projection regardless of caller.
 * Mirrors the contract enforced by /admin/users/:col in v0.10.
 */
const AUTH_PRIVATE_COLUMNS = new Set(["password_hash", "totp_secret", "password_reset_at"]);

async function rowToMetaAsync(
  row: Record<string, unknown>,
  col: Collection,
  fields: FieldDef[],
): Promise<RecordWithMeta> {
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const out: RecordWithMeta = {
    id: String(row.id),
    collectionId: col.id,
    collectionName: col.name,
    created: Number(row.created_at ?? 0),
    updated: Number(row.updated_at ?? 0),
  };
  for (const [k, v] of Object.entries(row)) {
    if (k === "id" || k === "created_at" || k === "updated_at") continue;
    // Auth-system columns are private — never emit on the wire.
    if (col.type === "auth" && AUTH_PRIVATE_COLUMNS.has(k)) continue;
    const def = fieldByName.get(k);
    // Never expose password hashes via the API
    if (def?.type === "password") continue;
    out[k] = def ? await decodeAfterStorage(v, def) : v;
  }
  return out;
}

export interface ListOptions {
  page?: number;
  perPage?: number;
  filter?: string;
  sort?: string;
  expand?: string;
  fields?: string;
  skipTotal?: boolean;
  accessRule?: string;
  auth?: AuthContext | null;
  /** Full-text query (FTS5 MATCH) — applied when the collection has searchable fields. */
  search?: string;
  /**
   * Keyset (cursor) pagination. When defined, switches off OFFSET + COUNT and
   * seeks by (sort-key, id): `""` = first page, else an opaque cursor from a
   * prior `nextCursor`. Requires a single sort column (default `created_at`).
   */
  cursor?: string;
}

export interface ListResult {
  data: RecordWithMeta[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  /** Keyset mode only: cursor for the next page, or null when exhausted. */
  nextCursor?: string | null;
}

/** Thrown when a keyset (`cursor`) request is malformed — surfaced as HTTP 400. */
export class KeysetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeysetError";
  }
}

/** Opaque cursor = base64url(JSON of the last row's sort value + id). */
function encodeCursor(v: unknown, id: string): string {
  return Buffer.from(JSON.stringify({ v, id })).toString("base64url");
}
function decodeCursor(s: string): { v: unknown; id: string } | null {
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as {
      v: unknown;
      id: unknown;
    };
    if (o && typeof o.id === "string") return { v: o.v, id: o.id };
  } catch {
    /* malformed */
  }
  return null;
}

export interface RecordWithMeta {
  id: string;
  collectionId: string;
  collectionName: string;
  created: number;
  updated: number;
  expand?: Record<string, unknown>;
  [key: string]: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rawClient(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

/**
 * SQLite identifier quoting — doubles up embedded `"` per spec. Mirrors
 * `core/collections.ts::quoteIdent`. All identifier inputs at this layer
 * already pass `assertSqlIdent` upstream (no quote chars possible), but the
 * defense-in-depth match prevents future bypasses if a path skips that
 * upstream check.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function isJsonField(field: FieldDef): boolean {
  return (
    field.type === "json" ||
    field.type === "geoPoint" ||
    field.type === "vector" ||
    (field.type === "select" && field.options?.multiple === true) ||
    (field.type === "file" && field.options?.multiple === true)
  );
}

/** Coerce a JS value to its DB-safe representation based on field type. */
function encodeValue(val: unknown, field: FieldDef): unknown {
  if (val === undefined || val === null) return null;
  if (field.type === "bool") {
    if (typeof val === "boolean") return val ? 1 : 0;
    if (val === 1 || val === 0) return val;
    return val ? 1 : 0;
  }
  if (field.type === "number") {
    if (typeof val === "number") return val;
    const n = Number(val);
    return Number.isNaN(n) ? null : n;
  }
  if (field.type === "autodate" || field.type === "date") {
    if (typeof val === "number") return val;
    if (typeof val === "string") {
      const t = Date.parse(val);
      return Number.isNaN(t) ? null : Math.floor(t / 1000);
    }
    return null;
  }
  if (isJsonField(field)) {
    return typeof val === "string" ? val : JSON.stringify(val);
  }
  return val;
}

/** Decode a DB value back to the JS shape the API returns. */
function decodeValue(val: unknown, field: FieldDef): unknown {
  if (val === null || val === undefined) return null;
  if (field.type === "bool") return val === 1 || val === true || val === "1" || val === "true";
  if (isJsonField(field)) {
    if (typeof val === "string") {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
  }
  return val;
}

function _rowToMeta(
  row: Record<string, unknown>,
  col: Collection,
  fields: FieldDef[],
): RecordWithMeta {
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const out: RecordWithMeta = {
    id: String(row.id),
    collectionId: col.id,
    collectionName: col.name,
    created: Number(row.created_at ?? 0),
    updated: Number(row.updated_at ?? 0),
  };
  for (const [k, v] of Object.entries(row)) {
    if (k === "id" || k === "created_at" || k === "updated_at") continue;
    if (col.type === "auth" && AUTH_PRIVATE_COLUMNS.has(k)) continue;
    const def = fieldByName.get(k);
    out[k] = def ? decodeValue(v, def) : v;
  }
  return out;
}

// ── List ─────────────────────────────────────────────────────────────────────

export async function listRecords(
  collectionName: string,
  opts: ListOptions = {},
): Promise<ListResult> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);

  const fields = parseFields(col.fields);
  const tname = userTableName(col.name);
  const tableRef = quoteIdent(tname);
  const client = rawClient();

  const page = opts.page ?? 1;
  const perPage = opts.perPage ?? 30;
  const offset = (page - 1) * perPage;

  // Build WHERE
  type Binding = string | number | bigint | boolean | null | Uint8Array;
  const whereParts: string[] = [];
  const whereParams: Binding[] = [];

  // Lookup callback so the SQL compiler can inherit joined-collection rules
  // and validate back-relation ref fields.
  const lookup = makeCollectionLookup();
  const filterOpts = { auth: opts.auth ?? null, lookup, hostIdField: "id" } as const;

  if (opts.filter) {
    let compiled;
    try {
      compiled = parseFilter(opts.filter, tname, filterOpts);
    } catch {
      compiled = null;
    }
    if (compiled) {
      whereParts.push(compiled.sql);
      whereParams.push(...(compiled.params as Binding[]));
    }
  }
  if (opts.accessRule) {
    let compiled;
    try {
      compiled = parseFilter(opts.accessRule, tname, filterOpts);
    } catch {
      compiled = null;
    }
    if (compiled) {
      whereParts.push(compiled.sql);
      whereParams.push(...(compiled.params as Binding[]));
    }
  }
  // Full-text search (FTS5). Composes with filter + access-rule via AND, so we
  // never match rows the caller can't see. If `search` is set but the
  // collection has no searchable fields, force an empty result rather than
  // silently returning everything (which would misrepresent a search).
  if (opts.search?.trim() && col.type !== "view") {
    const pred = ftsMatchPredicate(col.name, fields, tableRef, opts.search);
    if (pred) {
      whereParts.push(pred.sql);
      whereParams.push(pred.param);
    } else {
      whereParts.push("1 = 0");
    }
  }

  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

  // Build ORDER BY. View collections don't necessarily expose created_at /
  // updated_at, so skip the default sort there — caller can opt in by passing
  // a `sort` they know is valid for their query.
  //
  // Whitelist sort columns against the actual collection schema to refuse any
  // attacker-supplied identifier from reaching the SQL string. Without this
  // gate, a value like `sort=name";<sql>;--` would land inside the prepared
  // statement string. SQLite's prepare_v2 only compiles the first statement
  // (so multi-statement injection is blocked today), but error-based oracles
  // and any future API change to multi-statement exec would turn this into
  // RCE — fail fast instead of relying on the prepare contract.
  const sortableCols = new Set<string>([
    "id",
    "created_at",
    "updated_at",
    ...fields.filter((f) => !f.system).map((f) => f.name),
  ]);
  const sortSpec = opts.sort ?? (col.type === "view" ? "" : "-created_at");
  const sortClauses: Array<{ col: string; desc: boolean }> = [];
  for (const s of sortSpec
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)) {
    const desc = s.startsWith("-");
    const field = desc ? s.slice(1) : s;
    const colName = field === "created" ? "created_at" : field === "updated" ? "updated_at" : field;
    // View collections accept any column name (the schema is inferred from
    // the SELECT and may not be fully reflected in `fields`); base + auth
    // collections strictly whitelist.
    if (col.type !== "view" && !sortableCols.has(colName)) continue;
    // Defense-in-depth even after whitelist: reject any value that doesn't
    // match a SQL identifier regex. Whitelist covers it for non-view, this
    // is the view-collection-fallback safety net.
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(colName)) continue;
    sortClauses.push({ col: colName, desc });
  }
  const orderby = (clauses: Array<{ col: string; desc: boolean }>) =>
    clauses.length > 0
      ? `ORDER BY ${clauses.map((k) => `${tableRef}.${quoteIdent(k.col)} ${k.desc ? "DESC" : "ASC"}`).join(", ")}`
      : "";

  let items: RecordWithMeta[];
  let totalItems = -1;
  let totalPages = -1;
  let nextCursor: string | null | undefined;

  if (opts.cursor !== undefined) {
    // ── Keyset (cursor) pagination — O(log n) seek, no OFFSET / COUNT ────────
    if (sortClauses.length === 0) throw new KeysetError("keyset pagination requires a sort column");
    if (sortClauses.length > 1)
      throw new KeysetError("keyset pagination supports a single sort column");
    const primary = sortClauses[0]!;
    // Append id as a unique tiebreaker so the order is total (stable paging).
    const keyClauses =
      primary.col === "id" ? [primary] : [primary, { col: "id", desc: primary.desc }];

    const ksParts = [...whereParts];
    const ksParams = [...whereParams];
    if (opts.cursor !== "") {
      const cur = decodeCursor(opts.cursor);
      if (!cur) throw new KeysetError("invalid cursor");
      const cmp = primary.desc ? "<" : ">";
      const idRef = `${tableRef}."id"`;
      if (primary.col === "id") {
        ksParts.push(`${idRef} ${cmp} ?`);
        ksParams.push(cur.id as Binding);
      } else {
        const pcol = `${tableRef}.${quoteIdent(primary.col)}`;
        // Row-value seek: strictly past (v, id) in the sort direction.
        ksParts.push(`(${pcol} ${cmp} ? OR (${pcol} = ? AND ${idRef} ${cmp} ?))`);
        ksParams.push(cur.v as Binding, cur.v as Binding, cur.id as Binding);
      }
    }
    const ksWhere = ksParts.length > 0 ? `WHERE ${ksParts.join(" AND ")}` : "";
    // Fetch one extra to know whether a next page exists.
    const rows = preparedAll(
      client,
      `SELECT * FROM ${tableRef} ${ksWhere} ${orderby(keyClauses)} LIMIT ?`,
      [...ksParams, perPage + 1],
    ) as Record<string, unknown>[];
    const hasMore = rows.length > perPage;
    const pageRows = hasMore ? rows.slice(0, perPage) : rows;
    items = await Promise.all(pageRows.map((r) => rowToMetaAsync(r, col, fields)));
    if (hasMore) {
      const last = pageRows[pageRows.length - 1]!;
      nextCursor = encodeCursor(last[primary.col], String(last.id));
    } else {
      nextCursor = null;
    }
  } else {
    // ── Offset pagination (default; unchanged) ──────────────────────────────
    const rows = preparedAll(
      client,
      `SELECT * FROM ${tableRef} ${whereSql} ${orderby(sortClauses)} LIMIT ? OFFSET ?`,
      [...whereParams, perPage, offset],
    ) as Record<string, unknown>[];
    if (!opts.skipTotal) {
      const countSql = `SELECT COUNT(*) AS c FROM ${tableRef} ${whereSql}`;
      const cnt = preparedGet(client, countSql, whereParams) as { c: number } | undefined;
      totalItems = cnt?.c ?? 0;
      totalPages = Math.ceil(totalItems / perPage);
    }
    items = await Promise.all(rows.map((r) => rowToMetaAsync(r, col, fields)));
  }

  // Expand
  if (opts.expand) {
    const expandPaths = opts.expand
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await expandRelations(items, expandPaths, fields, opts.auth ?? null);
  }

  // Field projection
  if (opts.fields) {
    const keep = opts.fields
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    items = items.map((it) => projectFields(it, keep));
  }

  return {
    data: items,
    page,
    perPage,
    totalItems,
    totalPages,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

/** Safety bound on the vector candidate scan (settable via `vector.max_candidates`). */
function vectorMaxCandidates(): number {
  const n = parseInt(getSetting("vector.max_candidates", "100000"), 10);
  return Number.isFinite(n) && n > 0 ? n : 100_000;
}

/**
 * K-nearest-neighbour search over a collection's vector field (cosine).
 *
 * Two-phase to avoid materializing full records for the whole candidate set:
 *   1. Lean scan — select only `id + updated_at + <vector col>` under the same
 *      filter/access scope as `listRecords`, parse via the vector cache (so
 *      unchanged rows aren't re-parsed each query), and rank in-process.
 *   2. Materialize only the top-K via `getRecord` (decryption/meta reuse),
 *      attach `_score`, then apply expand/projection.
 *
 * `truncated` is true when the candidate set hit `vector.max_candidates` — the
 * caller can surface it instead of silently under-returning (the old behavior).
 */
export async function vectorSearch(
  collectionName: string,
  fieldName: string,
  queryVec: number[],
  opts: ListOptions & { limit?: number; minScore?: number } = {},
): Promise<{ data: RecordWithMeta[]; scanned: number; truncated: boolean }> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);
  const fields = parseFields(col.fields);
  const tname = userTableName(col.name);
  const tableRef = quoteIdent(tname);
  const client = rawClient();

  // Same access scope as listRecords (filter + rule) — never rank hidden rows.
  type Binding = string | number | bigint | boolean | null | Uint8Array;
  const whereParts: string[] = [];
  const whereParams: Binding[] = [];
  const lookup = makeCollectionLookup();
  const filterOpts = { auth: opts.auth ?? null, lookup, hostIdField: "id" } as const;
  for (const expr of [opts.filter, opts.accessRule]) {
    if (!expr) continue;
    let compiled;
    try {
      compiled = parseFilter(expr, tname, filterOpts);
    } catch {
      compiled = null;
    }
    if (compiled) {
      whereParts.push(compiled.sql);
      whereParams.push(...(compiled.params as Binding[]));
    }
  }
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

  const cap = vectorMaxCandidates();
  setVectorCacheCap(cap);
  const cacheKey = `${col.name}:${fieldName}`;
  // Fetch cap+1 to detect truncation. Only id + the vector column — never
  // materialize full records for the whole candidate set.
  const scanRows = preparedAll(
    client,
    `SELECT id, ${quoteIdent(fieldName)} AS __vec FROM ${tableRef} ${whereSql} LIMIT ?`,
    [...whereParams, cap + 1],
  ) as Array<{ id: string; __vec: unknown }>;
  const truncated = scanRows.length > cap;
  if (truncated) scanRows.length = cap;

  const candidates: Array<{ id: string; vector: Float32Array }> = [];
  for (const r of scanRows) {
    if (typeof r.__vec !== "string") continue;
    const vec = parseVectorCached(cacheKey, r.id, r.__vec);
    if (vec) candidates.push({ id: r.id, vector: vec });
  }

  const ranked = topK({
    query: Float32Array.from(queryVec),
    candidates,
    limit: opts.limit ?? 10,
    ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
  });

  // Materialize only the winners, in ranked order.
  const recs = await Promise.all(ranked.map((m) => getRecord(col.name, m.id)));
  let items: RecordWithMeta[] = [];
  const scores: number[] = [];
  recs.forEach((rec, i) => {
    if (rec) {
      items.push(rec);
      scores.push(ranked[i]!.score);
    }
  });

  if (opts.expand) {
    const paths = opts.expand
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await expandRelations(items, paths, fields, opts.auth ?? null);
  }
  if (opts.fields) {
    const keep = opts.fields
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    items = items.map((it) => projectFields(it, keep));
  }
  // Attach _score after projection so it survives a `fields` whitelist.
  items.forEach((it, i) => {
    (it as Record<string, unknown>)._score = scores[i];
  });

  return { data: items, scanned: scanRows.length, truncated };
}

function projectFields(item: RecordWithMeta, keep: string[]): RecordWithMeta {
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    if (k in item) out[k] = item[k as keyof RecordWithMeta];
  }
  if (!("id" in out) && "id" in item) out.id = item.id;
  return out as RecordWithMeta;
}

// ── Get one ─────────────────────────────────────────────────────────────────

export async function getRecord(
  collectionName: string,
  id: string,
): Promise<RecordWithMeta | null> {
  const col = await getCollection(collectionName);
  if (!col) return null;
  const fields = parseFields(col.fields);
  const tableRef = quoteIdent(userTableName(col.name));
  const client = rawClient();
  const row = client.prepare(`SELECT * FROM ${tableRef} WHERE "id" = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? await rowToMetaAsync(row, col, fields) : null;
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function createRecord(
  collectionName: string,
  data: Record<string, unknown> | null | undefined,
  auth: AuthContext | null = null,
): Promise<RecordWithMeta> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);
  if (col.type === "view") throw new ReadOnlyCollectionError(col.name);
  if (col.type === "auth") {
    // Auth collections require credential hashing + verification-email
    // semantics + uniqueness checks that records.ts createRecord doesn't
    // run. Route callers to the auth signup flow instead.
    throw new Error(
      `'${col.name}' is an auth collection. Create users via POST /api/v1/auth/${col.name}/register ` +
        `(or /anonymous) — direct record-create bypasses password hashing + email verification.`,
    );
  }
  data = data ?? {};

  // beforeCreate hook (can mutate data, throw to abort)
  const helpers = makeHookHelpers();
  await runBeforeHook(col, "beforeCreate", { record: data, existing: null, auth, helpers });

  await validateRecord(col, data, "create");

  const fields = parseFields(col.fields);
  const userFields = fields.filter((f) => !f.system && !f.implicit);
  const _fieldByName = new Map(userFields.map((f) => [f.name, f]));
  const now = Math.floor(Date.now() / 1000);

  // Apply autodate onCreate
  for (const f of userFields) {
    if (f.type === "autodate" && f.onCreate) (data as Record<string, unknown>)[f.name] = now;
  }

  type Binding = string | number | bigint | boolean | null | Uint8Array;
  const id = crypto.randomUUID();
  const insertCols: string[] = ["id"];
  const insertVals: Binding[] = [id];

  for (const f of userFields) {
    if (f.type === "autodate") continue; // not stored as user column
    if (Object.hasOwn(data, f.name)) {
      insertCols.push(f.name);
      insertVals.push(
        (await encodeForStorage((data as Record<string, unknown>)[f.name], f)) as Binding,
      );
    }
  }

  insertCols.push("created_at", "updated_at");
  insertVals.push(now, now);

  const tableRef = quoteIdent(userTableName(col.name));
  const colsSql = insertCols.map(quoteIdent).join(", ");
  const placeholders = insertCols.map(() => "?").join(", ");

  const client = rawClient();
  client
    .prepare(`INSERT INTO ${tableRef} (${colsSql}) VALUES (${placeholders})`)
    .run(...insertVals);

  const row = client.prepare(`SELECT * FROM ${tableRef} WHERE "id" = ?`).get(id) as Record<
    string,
    unknown
  >;
  const result = await rowToMetaAsync(row, col, fields);
  await maybeRecordHistory(col, id, {
    op: "create",
    snapshot: result as unknown as Record<string, unknown>,
    auth,
  });
  broadcast(
    col.name,
    { type: "create", collection: col.name, record: result },
    {
      viewRule: col.view_rule,
      record: result as unknown as Record<string, unknown>,
    },
  );
  void dispatchEvent({ event: `${col.name}.create`, data: { record: result } }).catch(() => {
    /* swallow */
  });
  runAfterHook(col, "afterCreate", {
    record: result as unknown as Record<string, unknown>,
    existing: null,
    auth,
    helpers,
  });
  return result;
}

// ── Update ──────────────────────────────────────────────────────────────────

export async function updateRecord(
  collectionName: string,
  id: string,
  data: Record<string, unknown> | null | undefined,
  auth: AuthContext | null = null,
): Promise<RecordWithMeta> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);
  if (col.type === "view") throw new ReadOnlyCollectionError(col.name);
  data = data ?? {};
  if (col.type === "auth") {
    // Strip auth-system columns from the incoming patch — those go through
    // the dedicated auth flows (`/totp/...`, `/verify-email`, …) that
    // handle hashing + email-verification + recovery-code lifecycle.
    // Allowing them here would let callers set raw `password_hash` (or
    // `email_verified`) bypassing the contract.
    const stripped: Record<string, unknown> = { ...(data as Record<string, unknown>) };
    for (const k of [
      "password",
      "password_hash",
      "totp_secret",
      "totp_enabled",
      "email_verified",
      "is_anonymous",
      "password_reset_at",
    ]) {
      delete stripped[k];
    }
    data = stripped;
  }

  const existing = await getRecord(collectionName, id);
  if (!existing) throw new Error("Record not found");

  // beforeUpdate hook
  const helpers = makeHookHelpers();
  await runBeforeHook(col, "beforeUpdate", {
    record: data,
    existing: existing as unknown as Record<string, unknown>,
    auth,
    helpers,
  });

  await validateRecord(col, data, "update", id);

  const fields = parseFields(col.fields);
  const userFields = fields.filter((f) => !f.system && !f.implicit);
  // Strictly-monotonic `updated_at`: guarantees a fresh weak-ETag on every write
  // so the optimistic-concurrency (If-Match) guard has no same-second blind spot
  // (two PATCHes within one wall-clock second used to share an ETag → lost
  // update). ponytail: bumps at most +1s per write, so a record hammered with
  // sustained sub-second writes can drift slightly ahead of wall-clock (it
  // self-corrects the moment writes slow). A dedicated `version` column would
  // remove the drift entirely — the upgrade path if hot-record timestamps matter.
  const nowSec = Math.floor(Date.now() / 1000);
  const prevUpdated = Number((existing as { updated?: number }).updated ?? 0);
  const now = nowSec > prevUpdated ? nowSec : prevUpdated + 1;

  // Apply autodate onUpdate
  for (const f of userFields) {
    if (f.type === "autodate" && f.onUpdate) (data as Record<string, unknown>)[f.name] = now;
  }

  type Binding = string | number | bigint | boolean | null | Uint8Array;
  const setCols: string[] = [];
  const setVals: Binding[] = [];
  for (const f of userFields) {
    if (f.type === "autodate") continue;
    if (Object.hasOwn(data, f.name)) {
      setCols.push(`${quoteIdent(f.name)} = ?`);
      setVals.push(
        (await encodeForStorage((data as Record<string, unknown>)[f.name], f)) as Binding,
      );
    }
  }
  setCols.push(`"updated_at" = ?`);
  setVals.push(now);

  const tableRef = quoteIdent(userTableName(col.name));
  const client = rawClient();

  if (setCols.length > 1) {
    client
      .prepare(`UPDATE ${tableRef} SET ${setCols.join(", ")} WHERE "id" = ?`)
      .run(...setVals, id);
  }

  const row = client.prepare(`SELECT * FROM ${tableRef} WHERE "id" = ?`).get(id) as Record<
    string,
    unknown
  >;
  const result = await rowToMetaAsync(row, col, fields);
  await maybeRecordHistory(col, id, {
    op: "update",
    snapshot: result as unknown as Record<string, unknown>,
    auth,
  });
  broadcast(
    col.name,
    { type: "update", collection: col.name, record: result },
    {
      viewRule: col.view_rule,
      record: result as unknown as Record<string, unknown>,
    },
  );
  void dispatchEvent({ event: `${col.name}.update`, data: { record: result } }).catch(() => {
    /* swallow */
  });
  runAfterHook(col, "afterUpdate", {
    record: result as unknown as Record<string, unknown>,
    existing: existing as unknown as Record<string, unknown>,
    auth,
    helpers,
  });
  return result;
}

// ── Delete ──────────────────────────────────────────────────────────────────

export class RestrictError extends Error {
  details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("Cannot delete: record is referenced by other records");
    this.details = details;
  }
}

export class ReadOnlyCollectionError extends Error {
  constructor(collectionName: string) {
    super(`Collection '${collectionName}' is read-only (view collection)`);
  }
}

interface IncomingRef {
  collection: { id: string; name: string; view_rule: string | null };
  fieldName: string;
  cascade: CascadeMode;
}

/** Find every (collection, field) pair that has a relation pointing at `targetCollectionName`. */
async function findIncomingRefs(targetCollectionName: string): Promise<IncomingRef[]> {
  const all = await listCollections();
  const refs: IncomingRef[] = [];
  for (const c of all) {
    const fields = parseFields(c.fields);
    for (const f of fields) {
      if (f.type === "relation" && f.collection === targetCollectionName) {
        refs.push({
          collection: { id: c.id, name: c.name, view_rule: c.view_rule },
          fieldName: f.name,
          cascade: f.options?.cascade ?? "setNull",
        });
      }
    }
  }
  return refs;
}

/**
 * Apply cascade behavior to all incoming references before deleting `id`.
 * `visited` prevents infinite loops on circular cascades.
 */
async function applyCascades(
  targetColName: string,
  id: string,
  auth: AuthContext | null,
  visited: Set<string>,
): Promise<void> {
  const key = `${targetColName}:${id}`;
  if (visited.has(key)) return;
  visited.add(key);

  const refs = await findIncomingRefs(targetColName);
  if (refs.length === 0) return;
  const client = rawClient();

  for (const ref of refs) {
    const refTable = quoteIdent(userTableName(ref.collection.name));
    const fieldQ = quoteIdent(ref.fieldName);

    if (ref.cascade === "restrict") {
      const row = client
        .prepare(`SELECT "id" FROM ${refTable} WHERE ${fieldQ} = ? LIMIT 1`)
        .get(id);
      if (row) {
        throw new RestrictError({
          [ref.collection.name]:
            `${ref.collection.name}.${ref.fieldName} still references this record`,
        });
      }
      continue;
    }

    if (ref.cascade === "setNull") {
      const affected = client
        .prepare(`SELECT "id" FROM ${refTable} WHERE ${fieldQ} = ?`)
        .all(id) as Array<{ id: string }>;
      if (affected.length === 0) continue;
      const now = Math.floor(Date.now() / 1000);
      client
        .prepare(`UPDATE ${refTable} SET ${fieldQ} = NULL, "updated_at" = ? WHERE ${fieldQ} = ?`)
        .run(now, id);
      // Notify realtime listeners with full record payloads. Hooks are skipped
      // on purpose — cascade is a bulk operation and per-row hook execution
      // would be surprisingly expensive.
      for (const r of affected) {
        const rec = await getRecord(ref.collection.name, r.id);
        if (rec)
          broadcast(
            ref.collection.name,
            { type: "update", collection: ref.collection.name, record: rec },
            {
              viewRule: ref.collection.view_rule,
              record: rec as unknown as Record<string, unknown>,
            },
          );
      }
      continue;
    }

    if (ref.cascade === "cascade") {
      const affected = client
        .prepare(`SELECT "id" FROM ${refTable} WHERE ${fieldQ} = ?`)
        .all(id) as Array<{ id: string }>;
      for (const r of affected) {
        await deleteRecordInternal(ref.collection.name, r.id, auth, visited);
      }
    }
  }
}

export async function deleteRecord(
  collectionName: string,
  id: string,
  auth: AuthContext | null = null,
): Promise<void> {
  return deleteRecordInternal(collectionName, id, auth, new Set<string>());
}

async function deleteRecordInternal(
  collectionName: string,
  id: string,
  auth: AuthContext | null,
  visited: Set<string>,
): Promise<void> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);
  if (col.type === "view") throw new ReadOnlyCollectionError(col.name);

  const existing = await getRecord(collectionName, id);
  if (!existing) return;

  // Resolve incoming refs first — restrict throws here, before any hook runs.
  await applyCascades(col.name, id, auth, visited);

  const helpers = makeHookHelpers();
  await runBeforeHook(col, "beforeDelete", {
    record: {},
    existing: existing as unknown as Record<string, unknown>,
    auth,
    helpers,
  });

  const tableRef = quoteIdent(userTableName(col.name));
  rawClient().prepare(`DELETE FROM ${tableRef} WHERE "id" = ?`).run(id);
  await maybeRecordHistory(col, id, {
    op: "delete",
    snapshot: existing as unknown as Record<string, unknown>,
    auth,
  });
  // Pass the just-deleted record snapshot so per-subscriber view_rule eval still has fields.
  broadcast(
    col.name,
    { type: "delete", collection: col.name, id },
    {
      viewRule: col.view_rule,
      record: existing as unknown as Record<string, unknown>,
    },
  );
  void dispatchEvent({ event: `${col.name}.delete`, data: { id, record: existing } }).catch(() => {
    /* swallow */
  });

  runAfterHook(col, "afterDelete", {
    record: {},
    existing: existing as unknown as Record<string, unknown>,
    auth,
    helpers,
  });
}

// ── Relation expand ─────────────────────────────────────────────────────────

/**
 * Parse expand paths into a head→remaining-paths map.
 * Example: ["author", "author.profile", "comments.user.team"]
 *   → { "author": ["profile"], "comments": ["user.team"] }
 */
function parseExpandTree(paths: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const p of paths) {
    const idx = p.indexOf(".");
    const head = idx === -1 ? p : p.slice(0, idx);
    const rest = idx === -1 ? null : p.slice(idx + 1);
    if (!map.has(head)) map.set(head, []);
    if (rest) map.get(head)!.push(rest);
  }
  return map;
}

async function expandRelations(
  items: RecordWithMeta[],
  expandPaths: string[],
  schema: FieldDef[],
  auth: AuthContext | null = null,
): Promise<void> {
  if (items.length === 0 || expandPaths.length === 0) return;
  const client = rawClient();
  const tree = parseExpandTree(expandPaths);

  for (const [fieldName, restPaths] of tree) {
    const fieldDef = schema.find((f) => f.name === fieldName && f.type === "relation");
    if (fieldDef?.collection) {
      // ── Forward relation: this record points at one target ──────────────
      const targetCol = await getCollection(fieldDef.collection);
      if (!targetCol) continue;
      const targetFields = parseFields(targetCol.fields);
      const targetTable = quoteIdent(userTableName(targetCol.name));

      const ids = [
        ...new Set(
          items
            .map((it) => it[fieldName])
            .filter((v): v is string => typeof v === "string" && v.length > 0),
        ),
      ];
      if (ids.length === 0) continue;

      const placeholders = ids.map(() => "?").join(", ");
      const rows = client
        .prepare(`SELECT * FROM ${targetTable} WHERE "id" IN (${placeholders})`)
        .all(...ids) as Record<string, unknown>[];

      const expanded = await Promise.all(
        rows.map((r) => rowToMetaAsync(r, targetCol, targetFields)),
      );
      const byId = new Map(expanded.map((rec) => [rec.id, rec]));

      for (const item of items) {
        const refId = item[fieldName];
        if (typeof refId === "string" && byId.has(refId)) {
          if (!item.expand) item.expand = {};
          item.expand[fieldName] = byId.get(refId);
        }
      }
      if (restPaths.length > 0) await expandRelations(expanded, restPaths, targetFields, auth);
    } else {
      // ── Reverse relation: `<collection>_via_<field>` ────────────────────
      await expandReverse(items, fieldName, restPaths, auth);
    }
  }
}

/**
 * Reverse-relation expand: `posts?expand=comments_via_post` attaches, to each
 * post, the array of comments whose `post` relation points back at it.
 *
 * Security: the (collection, field) pair must be a REAL incoming relation to the
 * host collection (validated via `findIncomingRefs`), and — unlike forward
 * expand, which surfaces a single explicitly-referenced record — the referencing
 * collection's `list_rule` is enforced, so a reverse expand can't leak rows the
 * caller isn't allowed to list. Single (non-`multiple`) relations only.
 */
async function expandReverse(
  items: RecordWithMeta[],
  path: string,
  restPaths: string[],
  auth: AuthContext | null,
): Promise<void> {
  const hostCollection = items[0]?.collectionName;
  if (!hostCollection) return;

  // Resolve `<refCol>_via_<field>` (try every `_via_` split; names may contain it).
  const incoming = await findIncomingRefs(hostCollection);
  let refColName: string | undefined;
  let refFieldName: string | undefined;
  let idx = path.indexOf("_via_");
  while (idx !== -1 && refColName === undefined) {
    const c = path.slice(0, idx);
    const f = path.slice(idx + 5);
    if (incoming.some((r) => r.collection.name === c && r.fieldName === f)) {
      refColName = c;
      refFieldName = f;
    }
    idx = path.indexOf("_via_", idx + 1);
  }
  if (!refColName || !refFieldName) return; // not a valid reverse relation

  const refCol = await getCollection(refColName);
  if (!refCol) return;
  const refFields = parseFields(refCol.fields);
  const refFieldDef = refFields.find((f) => f.name === refFieldName);
  if (refFieldDef?.options?.multiple) return; // multi-relations not supported (see forward)

  // Access control: enforce the referencing collection's list_rule (admins bypass).
  const isAdmin = auth?.type === "admin";
  let ruleSql = "";
  const ruleParams: Array<string | number | bigint | boolean | null | Uint8Array> = [];
  if (!isAdmin && refCol.list_rule !== null) {
    if (refCol.list_rule === "") return; // admin-only collection → expose nothing
    try {
      const compiled = parseFilter(refCol.list_rule, userTableName(refColName), {
        auth: auth ?? null,
        lookup: makeCollectionLookup(),
        hostIdField: "id",
      });
      if (compiled) {
        ruleSql = ` AND (${compiled.sql})`;
        ruleParams.push(...(compiled.params as typeof ruleParams));
      }
    } catch {
      return; // an uncompilable rule fails closed
    }
  }

  const hostIds = [...new Set(items.map((it) => it.id))];
  const client = rawClient();
  const refTable = quoteIdent(userTableName(refColName));
  const fieldQ = quoteIdent(refFieldName);
  const placeholders = hostIds.map(() => "?").join(", ");
  const rows = client
    .prepare(`SELECT * FROM ${refTable} WHERE ${fieldQ} IN (${placeholders})${ruleSql}`)
    .all(...hostIds, ...ruleParams) as Record<string, unknown>[];

  const expanded = await Promise.all(rows.map((r) => rowToMetaAsync(r, refCol, refFields)));
  // Group referencing records by the host id their relation field holds.
  const byHost = new Map<string, RecordWithMeta[]>();
  for (const rec of expanded) {
    const hostId = rec[refFieldName];
    if (typeof hostId !== "string") continue;
    (byHost.get(hostId) ?? byHost.set(hostId, []).get(hostId)!).push(rec);
  }
  for (const item of items) {
    if (!item.expand) item.expand = {};
    item.expand[path] = byHost.get(item.id) ?? [];
  }
  if (restPaths.length > 0) await expandRelations(expanded, restPaths, refFields, auth);
}
