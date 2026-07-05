/**
 * Long-lived API tokens — cogworks's Sanctum-style personal-access-token
 * surface, distinct from short-lived user/admin JWTs.
 *
 * Use cases (see docs/concepts/api-tokens.md):
 *   - CI / cron / service-to-service automation
 *   - n8n / Zapier / Make / IFTTT integrations
 *   - AI agents (Claude Desktop, Cursor) over MCP
 *   - Third-party admin dashboards (read-only auditor access)
 *
 * Why a separate audience: short-lived user/admin JWTs are designed to
 * expire weekly so a leaked token decays. API tokens are meant to live
 * months — leak risk is mitigated by per-token revoke + scopes + audit
 * trail per token rather than expiry.
 *
 * Format on the wire: `Authorization: Bearer cwat_<jwt>` — the prefix
 * lets log scanners + secret-scanning tools detect leaked tokens. The
 * underlying JWT carries audience="api", jti=<token id>, plus name/scopes
 * claims for display. Verification is signature + jti lookup in the
 * cogworks_api_tokens table; revoked tokens have revoked_at set AND a
 * row in cogworks_token_revocations so the existing JWT verifier
 * short-circuits before this module is even called.
 */

import { eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm/sql";
import { getDb } from "../db/client.ts";
import { apiTokens } from "../db/schema.ts";
import { signAuthToken, revokeToken } from "../core/sec.ts";

/** Stable token-prefix so leaks are grep-able. */
export const API_TOKEN_PREFIX = "cwat_";

/** Maximum allowed token lifetime — 10 years. Anything longer is asking for trouble. */
export const MAX_API_TOKEN_TTL_SEC = 10 * 365 * 24 * 60 * 60;

/** Default token lifetime when caller doesn't pin one — 90 days. */
export const DEFAULT_API_TOKEN_TTL_SEC = 90 * 24 * 60 * 60;

/**
 * Coarse, fixed scope strings. Per-collection scopes (`collection:<name>:read`,
 * `collection:<name>:write`, with `*` wildcards) are dynamic and validated by
 * {@link isValidScope} rather than enumerated here — that's F-10, "hand an agent
 * a token that reads posts and touches nothing else."
 */
export const KNOWN_SCOPES = [
  "admin", // full admin equivalent
  "read", // any GET on records / files (all collections)
  "write", // POST/PATCH/DELETE on records (all collections; rules still apply)
  "mcp:read", // MCP server: read-only tools
  "mcp:write", // MCP server: mutating tools (records, hooks, settings)
  "mcp:admin", // MCP server: full admin
  "mcp:sql", // MCP server: raw SQL tool
] as const;
export type Scope = (typeof KNOWN_SCOPES)[number] | string;

/**
 * Per-collection scope grammar: `collection:<name>:<action>` where `<name>` is a
 * collection name or `*`, and `<action>` is `read`, `write`, or `*`.
 * Examples: `collection:posts:read`, `collection:posts:*`, `collection:*:read`.
 */
const COLLECTION_SCOPE_RE = /^collection:[A-Za-z0-9_*]+:(read|write|\*)$/;

/** True if `s` is a recognized coarse scope or a well-formed per-collection scope. */
export function isValidScope(s: string): boolean {
  return (KNOWN_SCOPES as readonly string[]).includes(s) || COLLECTION_SCOPE_RE.test(s);
}

export interface MintInput {
  name: string;
  scopes: Scope[];
  /** Lifetime in seconds. Capped at MAX_API_TOKEN_TTL_SEC. Default 90d. */
  ttlSeconds?: number;
  /** Admin id minting the token. */
  createdBy: string;
  /** Admin email at mint time (for display + audit). */
  createdByEmail: string;
}

export interface MintResult {
  /** The full token string the caller must save (`cwat_<jwt>`) — shown ONCE. */
  token: string;
  /** Token id (== jti). Use to revoke later. */
  id: string;
  expires_at: number;
}

export async function mintApiToken(input: MintInput, jwtSecret: string): Promise<MintResult> {
  if (!input.name || input.name.length === 0) throw new Error("name is required");
  if (input.name.length > 100) throw new Error("name must be 100 characters or fewer");
  if (!Array.isArray(input.scopes) || input.scopes.length === 0)
    throw new Error("at least one scope required");
  for (const s of input.scopes) {
    if (typeof s !== "string" || s.length === 0 || s.length > 64 || !isValidScope(s))
      throw new Error(`invalid scope: ${s}`);
  }

  const ttlSeconds = Math.min(
    Math.max(60, input.ttlSeconds ?? DEFAULT_API_TOKEN_TTL_SEC),
    MAX_API_TOKEN_TTL_SEC,
  );
  const now = Math.floor(Date.now() / 1000);
  const expires_at = now + ttlSeconds;

  const { token: rawJwt, jti } = await signAuthToken({
    payload: { name: input.name, scopes: input.scopes },
    audience: "api",
    expiresInSeconds: ttlSeconds,
    jwtSecret,
  });

  await getDb()
    .insert(apiTokens)
    .values({
      id: jti,
      name: input.name,
      scopes: JSON.stringify(input.scopes),
      created_by: input.createdBy,
      created_by_email: input.createdByEmail,
      created_at: now,
      expires_at,
      use_count: 0,
    });

  return { token: API_TOKEN_PREFIX + rawJwt, id: jti, expires_at };
}

export interface ApiTokenRow {
  id: string;
  name: string;
  scopes: string[];
  created_by: string;
  created_by_email: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  last_used_ua: string | null;
  use_count: number;
}

function parseRow(r: typeof apiTokens.$inferSelect): ApiTokenRow {
  let scopes: string[] = [];
  try {
    const p = JSON.parse(r.scopes);
    if (Array.isArray(p)) scopes = p.filter((s): s is string => typeof s === "string");
  } catch {
    /* malformed row — treat as no-scope */
  }
  return {
    id: r.id,
    name: r.name,
    scopes,
    created_by: r.created_by,
    created_by_email: r.created_by_email,
    created_at: r.created_at,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at ?? null,
    last_used_at: r.last_used_at ?? null,
    last_used_ip: r.last_used_ip ?? null,
    last_used_ua: r.last_used_ua ?? null,
    use_count: r.use_count,
  };
}

export async function listApiTokens(): Promise<ApiTokenRow[]> {
  const rows = await getDb().select().from(apiTokens).orderBy(sql`${apiTokens.created_at} DESC`);
  return rows.map(parseRow);
}

export async function getApiToken(id: string): Promise<ApiTokenRow | null> {
  const rows = await getDb().select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1);
  return rows[0] ? parseRow(rows[0]) : null;
}

/**
 * Revoke a token. Sets revoked_at AND inserts the jti into the global
 * revocations list so the standard JWT verifier rejects on next use.
 * Idempotent — calling twice is fine.
 */
export async function revokeApiToken(id: string): Promise<{ revoked: boolean }> {
  const db = getDb();
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1);
  const row = rows[0];
  if (!row) return { revoked: false };
  const now = Math.floor(Date.now() / 1000);
  if (row.revoked_at == null) {
    await db.update(apiTokens).set({ revoked_at: now }).where(eq(apiTokens.id, id));
  }
  await revokeToken(id, row.expires_at);
  return { revoked: true };
}

/**
 * Resolve token metadata for a verified jti. Called from the JWT verifier
 * extension that handles `audience: "api"` — returns null when the token
 * isn't in the table (somehow signed but not minted via the proper path).
 */
export async function loadApiTokenByJti(jti: string): Promise<ApiTokenRow | null> {
  return getApiToken(jti);
}

// ── Scope check helpers ──────────────────────────────────────────────────────

/**
 * True if the token's scopes satisfy `required`.
 *
 * - `admin` implies every scope; `mcp:admin` implies every `mcp:*`.
 * - `read` and `write` are independent (a `read` token can't write, and vice-versa).
 * - A per-collection `required` (`collection:<name>:<action>`) is satisfied by:
 *     · the exact scope, or a `collection:<name>:*` / `collection:*:<action>` /
 *       `collection:*:*` wildcard, **or**
 *     · the matching GLOBAL scope — a `read` token reads any collection, a
 *       `write` token writes any collection. (So global scopes stay a superset
 *       of per-collection ones; per-collection scopes are strictly narrower.)
 */
export function hasScope(tokenScopes: readonly string[], required: string): boolean {
  if (tokenScopes.includes("admin")) return true;
  if (tokenScopes.includes(required)) return true;
  if (required.startsWith("mcp:") && tokenScopes.includes("mcp:admin")) return true;
  if (required.startsWith("collection:")) {
    const parts = required.split(":");
    const name = parts[1];
    const action = parts[2];
    if (!name || !action) return false;
    if (action === "read" && tokenScopes.includes("read")) return true;
    if (action === "write" && tokenScopes.includes("write")) return true;
    if (tokenScopes.includes(`collection:${name}:*`)) return true;
    if (tokenScopes.includes(`collection:*:${action}`)) return true;
    if (tokenScopes.includes("collection:*:*")) return true;
    return false;
  }
  return false;
}

// ── Last-used buffering (off-hot-path) ───────────────────────────────────────
//
// Writing last_used_at on every authenticated request is way too costly under
// load. Buffer in memory; flush every 30 s OR every 1000 events, whichever
// fires first. Worst-case loss on hard crash: 30 s of usage telemetry — pure
// observability data, not authoritative.

interface PendingUsage {
  count: number;
  lastAt: number;
  lastIp: string;
  lastUa: string;
}
const pendingUsage = new Map<string, PendingUsage>();
let usageTimer: ReturnType<typeof setTimeout> | null = null;
const USAGE_FLUSH_MS = 30_000;
const USAGE_FORCE_FLUSH_AT = 1000;

export function recordApiTokenUsage(jti: string, ip: string | null, ua: string | null): void {
  const e = pendingUsage.get(jti) ?? { count: 0, lastAt: 0, lastIp: "", lastUa: "" };
  e.count++;
  e.lastAt = Math.floor(Date.now() / 1000);
  if (ip) e.lastIp = ip;
  if (ua) e.lastUa = ua.slice(0, 200);
  pendingUsage.set(jti, e);

  if (pendingUsage.size >= USAGE_FORCE_FLUSH_AT) {
    void flushApiTokenUsage();
    return;
  }
  if (!usageTimer) {
    usageTimer = setTimeout(() => {
      void flushApiTokenUsage();
    }, USAGE_FLUSH_MS);
  }
}

export async function flushApiTokenUsage(): Promise<void> {
  if (usageTimer) {
    clearTimeout(usageTimer);
    usageTimer = null;
  }
  if (pendingUsage.size === 0) return;
  const snapshot = new Map(pendingUsage);
  pendingUsage.clear();

  const db = getDb();
  for (const [jti, e] of snapshot) {
    try {
      await db
        .update(apiTokens)
        .set({
          last_used_at: e.lastAt,
          last_used_ip: e.lastIp || null,
          last_used_ua: e.lastUa || null,
          use_count: sql`${apiTokens.use_count} + ${e.count}`,
        })
        .where(eq(apiTokens.id, jti));
    } catch {
      /* ignore — observability data, never break a request */
    }
  }
}

/** Called from server.ts boot. Flushes pending usage once a minute as a
 *  safety net beyond the natural per-request triggers. */
export function startApiTokenUsageFlusher(): void {
  setInterval(() => {
    void flushApiTokenUsage();
  }, 60_000).unref?.();
}

// ── Token format helpers ─────────────────────────────────────────────────────

/**
 * Strip the `cwat_` (or legacy `vbat_`) prefix if present. Returns the raw JWT for the
 * standard verifier. Idempotent for tokens missing the prefix (callers may
 * pass plain JWTs in rare paths — tests, internal scripts).
 */
export function stripApiTokenPrefix(token: string): string {
  return token.startsWith("cwat_") || token.startsWith("vbat_") ? token.slice(5) : token;
}

/** True if the wire token uses the API-token prefix. */
export function isApiTokenFormat(token: string): boolean {
  return token.startsWith("cwat_") || token.startsWith("vbat_");
}

// ── Pruning ──────────────────────────────────────────────────────────────────

/**
 * Drop expired + long-revoked rows. Bound table growth on long-running
 * deployments. Called from the periodic cleanup task.
 */
export async function pruneExpiredApiTokens(): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  // Keep the row for 30 d after expiry/revoke so the admin UI can still
  // show "expired/revoked recently" entries before they vanish.
  const res = await getDb()
    .delete(apiTokens)
    .where(
      sql`(${apiTokens.expires_at} < ${cutoff}) OR (${apiTokens.revoked_at} IS NOT NULL AND ${apiTokens.revoked_at} < ${cutoff})`,
    );
  return (res as unknown as { changes?: number }).changes ?? 0;
}

// Suppress unused-import warning when no scope leans on isNull at compile time.
void isNull;
