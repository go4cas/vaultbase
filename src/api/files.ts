import { and, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getDb } from "../db/client.ts";
import { auditLog, files, fileTokenUses } from "../db/schema.ts";
import { getCollection, parseFields, type FieldDef } from "../core/collections.ts";
import {
  detectFormat,
  generateThumbnail,
  parseThumbSpec,
  thumbCachePath,
  thumbMime,
  type ThumbFormat,
} from "../core/image.ts";
import { getRecord } from "../core/records.ts";
import { evaluateRule, type AuthContext } from "../core/rules.ts";
import type { RequestContextLike } from "../core/filter.ts";
import { deleteFile, fileExists, fileResponse, readFile, writeFile } from "../core/storage.ts";
import { tokenWindowSeconds } from "../core/auth-tokens.ts";
import {
  extractBearer,
  isAllowedUploadMime,
  isSafeToRenderInline,
  isValidStorageFilename,
  signAuthToken,
  trustedClientIp,
  verifyAuthToken,
} from "../core/sec.ts";

async function getAuthContext(request: Request, jwtSecret: string): Promise<AuthContext | null> {
  const token = extractBearer(request);
  if (!token) return null;
  return await verifyAuthToken(token, jwtSecret);
}

async function isFileProtected(filename: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.select().from(files).where(eq(files.filename, filename)).limit(1);
  const meta = rows[0];
  if (!meta) return false;
  const col = await getCollection(meta.collection_id);
  if (!col) return false;
  const fields = parseFields(col.fields);
  const def = fields.find((f) => f.name === meta.field_name);
  return def?.options?.protected === true;
}

async function fileMetaOf(filename: string) {
  const db = getDb();
  const rows = await db.select().from(files).where(eq(files.filename, filename)).limit(1);
  return rows[0] ?? null;
}

/** Pull the peer-IP off the Bun connection info Hono exposes. */
function peerIpOf(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/** Build the file-context object exposed to per-field rules. */
function buildFileRequestContext(
  request: Request,
  ip: string,
  meta: { mime_type: string; size: number; field_name: string },
  collectionName: string,
): RequestContextLike & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  for (const [k, v] of request.headers.entries()) {
    const lower = k.toLowerCase();
    if (lower === "authorization" || lower === "cookie" || lower === "set-cookie") continue;
    headers[lower.replace(/-/g, "_")] = v;
  }
  // `@request.ip` and `@file.*` are read-only — surfaced via the `headers` map
  // so the existing rule engine doesn't need a new operand kind. Rule authors
  // write `@request.headers.x_vb_ip = '1.2.3.4'`-style — but for ergonomics we
  // also expose them under conventional names.
  headers.x_vb_ip = ip;
  headers.x_vb_file_field = meta.field_name;
  headers.x_vb_file_mime = meta.mime_type;
  headers.x_vb_file_size = String(meta.size);
  headers.x_vb_collection = collectionName;
  return {
    method: request.method.toUpperCase(),
    context: "protectedFile",
    headers,
    query: {},
    body: null,
    existing: null,
  };
}

interface FileTokenClaims {
  filename: string;
  ip?: string;
  uses?: number;
  jti?: string;
}

/**
 * Verify a file-audience JWT and return the relevant claims. Returns null on
 * any verify failure (signature / audience / expiry / revocation).
 */
async function verifyFileTokenClaims(
  token: string,
  jwtSecret: string,
): Promise<FileTokenClaims | null> {
  const ctx = await verifyAuthToken(token, jwtSecret, {
    audience: "file",
    recheckPrincipal: false,
  });
  if (!ctx) return null;
  // verifyAuthToken returned ok — re-decode payload (no signature work) to
  // pull the file-specific claims that the common return shape doesn't carry.
  try {
    const mid = token.split(".")[1] ?? "";
    const padded = mid
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(mid.length / 4) * 4, "=");
    const json = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))),
    ) as Record<string, unknown>;
    const filename = typeof json.filename === "string" ? json.filename : null;
    if (!filename) return null;
    const out: FileTokenClaims = { filename };
    if (typeof json.ip === "string") out.ip = json.ip;
    if (typeof json.uses === "number") out.uses = json.uses;
    if (typeof ctx.jti === "string") out.jti = ctx.jti;
    return out;
  } catch {
    return null;
  }
}

/**
 * Try to claim a one-time-use token. Returns true on first claim, false on
 * replay (a row with the same `jti` already exists). Idempotent w.r.t. the
 * same jti.
 */
async function claimOneTimeToken(jti: string, ip: string | null): Promise<boolean> {
  try {
    await getDb()
      .insert(fileTokenUses)
      .values({
        jti,
        used_at: Math.floor(Date.now() / 1000),
        ...(ip ? { ip } : {}),
      });
    return true;
  } catch {
    return false; // primary-key conflict → replay
  }
}

/** Prune file_token_uses rows older than 24h. Called from the periodic cleanup. */
export async function pruneFileTokenUses(): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const res = await getDb().delete(fileTokenUses).where(lt(fileTokenUses.used_at, cutoff));
  return (res as unknown as { changes?: number }).changes ?? 0;
}

interface AccessOutcome {
  allowed: boolean;
  reason: string;
  /** Field def for downstream audit / token mint. */
  fieldDef: FieldDef | null;
}

/**
 * Centralised access-decision for a file fetch / token mint. Combines the
 * collection view_rule and the field-level viewRule (AND), then applies the
 * field-level requireAuth gate. Admin always passes (handled by evaluateRule).
 */
async function evaluateFileAccess(
  collectionId: string,
  recordId: string,
  fieldName: string,
  auth: AuthContext | null,
  reqCtx: RequestContextLike | null,
): Promise<AccessOutcome> {
  const col = await getCollection(collectionId);
  if (!col) return { allowed: false, reason: "collection not found", fieldDef: null };

  if (auth?.type === "admin") {
    const fields = parseFields(col.fields);
    return {
      allowed: true,
      reason: "admin bypass",
      fieldDef: fields.find((f) => f.name === fieldName) ?? null,
    };
  }

  const fields = parseFields(col.fields);
  const fieldDef = fields.find((f) => f.name === fieldName) ?? null;
  const opts = fieldDef?.options ?? {};

  // requireAuth gate — must run before any rule eval, since the rule engine
  // treats `null` rules as public.
  if (opts.requireAuth && !auth) return { allowed: false, reason: "auth required", fieldDef };

  // Collection rule
  if (col.view_rule === "") return { allowed: false, reason: "collection: admin only", fieldDef };
  let record: Record<string, unknown> | null = null;
  if (col.view_rule !== null) {
    record = (await getRecord(col.name, recordId)) as Record<string, unknown> | null;
    if (!record) return { allowed: false, reason: "record not found", fieldDef };
    const ok = evaluateRule(col.view_rule, auth, record, reqCtx);
    if (!ok) return { allowed: false, reason: "collection rule denied", fieldDef };
  }

  // Field rule
  const fieldRule = opts.viewRule;
  if (fieldRule === "") return { allowed: false, reason: "field: admin only", fieldDef };
  if (typeof fieldRule === "string" && fieldRule !== "") {
    if (record === null) {
      record = (await getRecord(col.name, recordId)) as Record<string, unknown> | null;
      if (!record) return { allowed: false, reason: "record not found", fieldDef };
    }
    const ok = evaluateRule(fieldRule, auth, record, reqCtx);
    if (!ok) return { allowed: false, reason: "field rule denied", fieldDef };
  }

  return { allowed: true, reason: "rule passed", fieldDef };
}

/** Append a `files.download` row to the audit log. Best-effort — never throws. */
async function emitDownloadAudit(opts: {
  request: Request;
  ip: string | null;
  auth: AuthContext | null;
  filename: string;
  collection: string;
  recordId: string;
  field: string;
  mime: string;
  size: number;
  via: "rule" | "token";
}): Promise<void> {
  try {
    const url = new URL(opts.request.url);
    await getDb()
      .insert(auditLog)
      .values({
        id: crypto.randomUUID(),
        actor_id: opts.auth?.id ?? null,
        actor_email: (opts.auth as { email?: string } | null)?.email ?? null,
        method: "GET",
        path: url.pathname,
        action: "files.download",
        target: opts.filename,
        status: 200,
        ip: opts.ip,
        summary: JSON.stringify({
          collection: opts.collection,
          record: opts.recordId,
          field: opts.field,
          mime: opts.mime,
          size: opts.size,
          via: opts.via,
        }).slice(0, 1024),
        at: Math.floor(Date.now() / 1000),
      });
  } catch {
    /* audit must never break a download */
  }
}

function mimeAllowed(mime: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  for (const p of patterns) {
    if (p === mime) return true;
    if (p.endsWith("/*")) {
      const prefix = p.slice(0, -1);
      if (mime.startsWith(prefix)) return true;
    }
  }
  return false;
}

/** Resolve `key` against `uploadDir` and assert it does not escape the dir. */
// biome-ignore lint/correctness/noUnusedVariables: retained path-safety helper for future storage callers
function safeJoin(uploadDir: string, key: string): string | null {
  if (!isValidStorageFilename(key)) return null;
  const root = resolve(uploadDir);
  const full = resolve(join(root, key));
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

const SAFE_EXT_RE = /^[a-z0-9]{1,12}$/i;

function safeExt(originalName: string): string {
  const dot = originalName.lastIndexOf(".");
  if (dot < 0) return "bin";
  const ext = originalName.slice(dot + 1).toLowerCase();
  return SAFE_EXT_RE.test(ext) ? ext : "bin";
}

export function makeFilesPlugin(uploadDir: string, jwtSecret: string) {
  return new Hono()
    .post("/files/:collection/:recordId/:field", async (c) => {
      const request = c.req.raw;
      const collection = c.req.param("collection");
      const recordId = c.req.param("recordId");
      const field = c.req.param("field");
      const auth = await getAuthContext(request, jwtSecret);
      if (!auth) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }

      const col = await getCollection(collection);
      if (!col) {
        return c.json({ error: `Collection '${collection}' not found`, code: 404 }, 404);
      }

      // Authz — admin always; else evaluate the appropriate rule. New record
      // → create_rule; existing record → update_rule.
      const existing = await getRecord(collection, recordId);
      if (auth.type !== "admin") {
        const rule = existing ? col.update_rule : col.create_rule;
        if (rule === "") {
          return c.json({ error: "Forbidden", code: 403 }, 403);
        }
        if (rule !== null) {
          const ok = evaluateRule(rule, auth, (existing ?? {}) as Record<string, unknown>);
          if (!ok) {
            return c.json({ error: "Forbidden", code: 403 }, 403);
          }
        }
      }

      const formData = await request.formData();
      const fileEntries = (formData.getAll("file") as unknown[]).filter(
        (v): v is File => v instanceof File,
      );
      if (fileEntries.length === 0) {
        return c.json({ error: "No file uploaded", code: 400 }, 400);
      }

      const schema = parseFields(col.fields);
      const fieldDef = schema.find((f) => f.name === field);
      if (!fieldDef) {
        return c.json({ error: `Field '${field}' not found on '${col.name}'`, code: 404 }, 404);
      }
      if (fieldDef.type !== "file") {
        return c.json({ error: `Field '${field}' is not a file field`, code: 400 }, 400);
      }

      const opts = fieldDef.options ?? {};
      const multiple = !!opts.multiple;
      const maxSize = typeof opts.maxSize === "number" ? opts.maxSize : 0;
      const mimeTypes = Array.isArray(opts.mimeTypes) ? (opts.mimeTypes as string[]) : [];

      if (!multiple && fileEntries.length > 1) {
        return c.json(
          {
            error: `Field '${field}' is single-file; multiple uploads not allowed`,
            code: 400,
          },
          400,
        );
      }

      // Validate every file before writing any. Reject anything outside the
      // global allowlist regardless of the field's configured patterns.
      for (const f of fileEntries) {
        if (maxSize > 0 && f.size > maxSize) {
          return c.json(
            {
              error: `File too large: ${f.size} bytes (max ${maxSize})`,
              code: 422,
              details: { [field]: `Max ${maxSize} bytes` },
            },
            422,
          );
        }
        const fm = f.type || "application/octet-stream";
        if (!isAllowedUploadMime(fm)) {
          return c.json({ error: `MIME type '${fm}' not allowed`, code: 415 }, 415);
        }
        if (!mimeAllowed(fm, mimeTypes)) {
          return c.json(
            {
              error: `MIME type '${fm}' not allowed by field rules`,
              code: 422,
              details: { [field]: `Allowed: ${mimeTypes.join(", ")}` },
            },
            422,
          );
        }
      }

      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      const uploaded: Array<{
        id: string;
        filename: string;
        originalName: string;
        size: number;
        mimeType: string;
      }> = [];
      for (const file of fileEntries) {
        const ext = safeExt(file.name);
        const id = crypto.randomUUID();
        const filename = `${id}.${ext}`;
        const fileMime = file.type || "application/octet-stream";
        await writeFile(filename, await file.arrayBuffer(), fileMime);
        await db.insert(files).values({
          id,
          collection_id: col.id,
          record_id: recordId,
          field_name: field,
          filename,
          original_name: file.name.slice(0, 255),
          mime_type: fileMime,
          size: file.size,
          created_at: now,
        });
        uploaded.push({
          id,
          filename,
          originalName: file.name,
          size: file.size,
          mimeType: fileMime,
        });
      }

      if (!multiple) return c.json({ data: uploaded[0] });
      return c.json({ data: uploaded });
    })
    .post("/files/:collection/:recordId/:field/:filename/token", async (c) => {
      const request = c.req.raw;
      const collection = c.req.param("collection");
      const recordId = c.req.param("recordId");
      const field = c.req.param("field");
      const filename = c.req.param("filename");
      if (!isValidStorageFilename(filename)) {
        return c.json({ error: "Invalid filename", code: 400 }, 400);
      }
      const auth = await getAuthContext(request, jwtSecret);

      const col = await getCollection(collection);
      if (!col) {
        return c.json({ error: "Collection not found", code: 404 }, 404);
      }
      const fields = parseFields(col.fields);
      const fieldDef = fields.find((f) => f.name === field);
      if (fieldDef?.type !== "file") {
        return c.json({ error: "File field not found", code: 404 }, 404);
      }
      const record = await getRecord(collection, recordId);
      if (!record) {
        return c.json({ error: "Record not found", code: 404 }, 404);
      }

      const db = getDb();
      const fileRows = await db
        .select()
        .from(files)
        .where(
          and(
            eq(files.collection_id, col.id),
            eq(files.record_id, recordId),
            eq(files.field_name, field),
            eq(files.filename, filename),
          ),
        )
        .limit(1);
      const meta = fileRows[0];
      if (!meta) {
        return c.json({ error: "File not found", code: 404 }, 404);
      }

      const peerIp = peerIpOf(c);
      const ip = trustedClientIp(request, peerIp);
      const reqCtx = buildFileRequestContext(request, ip, meta, col.name);
      const decision = await evaluateFileAccess(col.id, recordId, field, auth, reqCtx);
      if (!decision.allowed) {
        return c.json({ error: "Forbidden", code: 403 }, 403);
      }

      const opts = fieldDef.options ?? {};
      const payload: Record<string, unknown> = { filename };
      if (opts.bindTokenIp) payload.ip = ip;
      if (opts.oneTimeToken) payload.uses = 1;

      const { token, exp } = await signAuthToken({
        payload,
        audience: "file",
        expiresInSeconds: tokenWindowSeconds("file"),
        jwtSecret,
      });
      return c.json({ data: { token, expires_at: exp } });
    })
    .get("/files/:filename", async (c) => {
      const request = c.req.raw;
      const filename = c.req.param("filename");
      const queryToken = c.req.query("token");
      const queryThumb = c.req.query("thumb");
      if (!isValidStorageFilename(filename)) {
        return c.json({ error: "Invalid filename", code: 400 }, 400);
      }
      if (!(await fileExists(filename))) {
        return c.json({ error: "File not found", code: 404 }, 404);
      }

      const meta = await fileMetaOf(filename);
      const peerIp = peerIpOf(c);
      const clientIp = trustedClientIp(request, peerIp);
      const auth = await getAuthContext(request, jwtSecret);

      let allowed = false;
      let via: "rule" | "token" = "rule";
      let collectionName = "";
      let fieldDefForAudit: FieldDef | null = null;

      if (!meta) {
        // Orphan files (no row) — admin-only.
        allowed = auth?.type === "admin";
      } else {
        const col = await getCollection(meta.collection_id);
        collectionName = col?.name ?? "";
        if (col) {
          const fields = parseFields(col.fields);
          fieldDefForAudit = fields.find((f) => f.name === meta.field_name) ?? null;
        }
        const tok = queryToken;
        if (tok) {
          // ── Token path ────────────────────────────────────────────────
          const claims = await verifyFileTokenClaims(tok, jwtSecret);
          if (claims && claims.filename === filename) {
            // IP binding: token's ip claim must match the requesting client.
            if (claims.ip !== undefined && claims.ip !== clientIp) {
              return c.json({ error: "Token bound to a different IP", code: 403 }, 403);
            }
            // One-time use: insert-or-fail on the jti.
            if (claims.uses === 1 && claims.jti) {
              const ok = await claimOneTimeToken(claims.jti, clientIp);
              if (!ok) {
                return c.json({ error: "Token already used", code: 410 }, 410);
              }
            }
            allowed = true;
            via = "token";
          }
        }
        if (!allowed) {
          // ── Rule path ─────────────────────────────────────────────────
          const reqCtx = buildFileRequestContext(request, clientIp, meta, collectionName);
          const decision = await evaluateFileAccess(
            meta.collection_id,
            meta.record_id,
            meta.field_name,
            auth,
            reqCtx,
          );
          if (decision.fieldDef) fieldDefForAudit = decision.fieldDef;
          allowed = decision.allowed;
        }
      }

      if (!allowed) {
        // Legacy `protected: true` field with no token? 401 (the front-end
        // knows to mint a token when it sees this code). Otherwise 403.
        if (meta && (await isFileProtected(filename)) && !queryToken) {
          return c.json({ error: "Token required", code: 401 }, 401);
        }
        return c.json({ error: "Forbidden", code: 403 }, 403);
      }

      if (meta && fieldDefForAudit?.options?.auditDownloads) {
        await emitDownloadAudit({
          request,
          ip: clientIp,
          auth,
          filename,
          collection: collectionName,
          recordId: meta.record_id,
          field: meta.field_name,
          mime: meta.mime_type,
          size: meta.size,
          via,
        });
      }

      const inlineSafe = meta ? isSafeToRenderInline(meta.mime_type) : false;
      const baseHeaders: Record<string, string> = {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      };
      if (!inlineSafe) {
        const safeName = (meta?.original_name ?? filename).replace(/[^a-zA-Z0-9._-]/g, "_");
        baseHeaders["Content-Disposition"] = `attachment; filename="${safeName}"`;
      }

      const spec = parseThumbSpec(queryThumb);
      if (!spec) {
        const r = await fileResponse(filename);
        if (!r) {
          return c.json({ error: "File not found", code: 404 }, 404);
        }
        // Layer headers on top of storage Response.
        for (const [k, v] of Object.entries(baseHeaders)) r.headers.set(k, v);
        return r;
      }

      const cachePath = thumbCachePath(uploadDir, filename, spec);
      const cached = Bun.file(cachePath);
      if (await cached.exists()) {
        const head = new Uint8Array(await cached.slice(0, 16).arrayBuffer());
        const cf = detectFormat(head);
        const headers: Record<string, string> = { ...baseHeaders };
        if (cf) headers["Content-Type"] = thumbMime(cf);
        return new Response(cached, { headers });
      }

      const buf = await readFile(filename);
      if (!buf) {
        return c.json({ error: "File not found", code: 404 }, 404);
      }
      const bytes = new Uint8Array(buf);
      const format = detectFormat(bytes);
      if (!format) {
        const r = await fileResponse(filename);
        if (!r) return new Response(null, { status: 404 });
        for (const [k, v] of Object.entries(baseHeaders)) r.headers.set(k, v);
        return r;
      }

      try {
        const thumb = await generateThumbnail(bytes, spec, format as ThumbFormat);
        await Bun.write(cachePath, thumb);
        const outFormat = detectFormat(thumb) ?? format;
        return new Response(thumb, {
          headers: { ...baseHeaders, "Content-Type": thumbMime(outFormat) },
        });
      } catch {
        const r = await fileResponse(filename);
        if (!r) return new Response(null, { status: 404 });
        for (const [k, v] of Object.entries(baseHeaders)) r.headers.set(k, v);
        return r;
      }
    })
    .delete("/files/:collection/:recordId/:field", async (c) => {
      const request = c.req.raw;
      const collection = c.req.param("collection");
      const recordId = c.req.param("recordId");
      const field = c.req.param("field");
      const auth = await getAuthContext(request, jwtSecret);
      if (!auth) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const col = await getCollection(collection);
      if (!col) {
        return c.json({ error: "Collection not found", code: 404 }, 404);
      }
      if (auth.type !== "admin") {
        const existing = await getRecord(collection, recordId);
        const rule = col.update_rule;
        if (rule === "") {
          return c.json({ error: "Forbidden", code: 403 }, 403);
        }
        if (rule !== null) {
          const ok = evaluateRule(rule, auth, (existing ?? {}) as Record<string, unknown>);
          if (!ok) {
            return c.json({ error: "Forbidden", code: 403 }, 403);
          }
        }
      }
      const db = getDb();
      const rows = await db
        .select()
        .from(files)
        .where(
          and(
            eq(files.collection_id, col.id),
            eq(files.record_id, recordId),
            eq(files.field_name, field),
          ),
        );
      if (rows.length === 0) {
        return c.json({ error: "File not found", code: 404 }, 404);
      }
      for (const meta of rows) {
        await deleteFile(meta.filename);
        deleteThumbsFor(uploadDir, meta.filename);
        await db.delete(files).where(eq(files.id, meta.id));
      }
      return c.json({ data: { deleted: rows.length } });
    })
    .delete("/files/:collection/:recordId/:field/:filename", async (c) => {
      const request = c.req.raw;
      const collection = c.req.param("collection");
      const recordId = c.req.param("recordId");
      const field = c.req.param("field");
      const filename = c.req.param("filename");
      const auth = await getAuthContext(request, jwtSecret);
      if (!auth) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      if (!isValidStorageFilename(filename)) {
        return c.json({ error: "Invalid filename", code: 400 }, 400);
      }
      const col = await getCollection(collection);
      if (!col) {
        return c.json({ error: "Collection not found", code: 404 }, 404);
      }
      if (auth.type !== "admin") {
        const existing = await getRecord(collection, recordId);
        const rule = col.update_rule;
        if (rule === "") {
          return c.json({ error: "Forbidden", code: 403 }, 403);
        }
        if (rule !== null) {
          const ok = evaluateRule(rule, auth, (existing ?? {}) as Record<string, unknown>);
          if (!ok) {
            return c.json({ error: "Forbidden", code: 403 }, 403);
          }
        }
      }
      const db = getDb();
      const rows = await db
        .select()
        .from(files)
        .where(
          and(
            eq(files.collection_id, col.id),
            eq(files.record_id, recordId),
            eq(files.field_name, field),
            eq(files.filename, filename),
          ),
        )
        .limit(1);
      const meta = rows[0];
      if (!meta) {
        return c.json({ error: "File not found", code: 404 }, 404);
      }
      await deleteFile(meta.filename);
      deleteThumbsFor(uploadDir, meta.filename);
      await db.delete(files).where(eq(files.id, meta.id));
      return c.json({ data: null });
    });
}

function deleteThumbsFor(uploadDir: string, filename: string): void {
  const dir = join(uploadDir, ".thumbs");
  if (!existsSync(dir)) return;
  const prefix = `${filename}__`;
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix)) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}
