import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import { log } from "../core/log.ts";
import type * as jose from "jose";
import { getDb } from "../db/client.ts";
import { admin, authTokens, mfaRecoveryCodes, mfaRecoveryLookup } from "../db/schema.ts";
import { getCollection, parseFields } from "../core/collections.ts";
import { findUserByEmail, findUserById, insertUser, updateUserById } from "../core/users-table.ts";
import { runAfterHook, runBeforeHook, makeHookHelpers } from "../core/hooks.ts";
import { getRecord } from "../core/records.ts";
import { validateRecord, ValidationError } from "../core/validate.ts";
import { tokenWindowSeconds } from "../core/auth-tokens.ts";
import {
  dummyPasswordHash,
  getAdmin,
  HASH_OPTS,
  hmacRecoveryCode,
  redactEmail,
  signAuthToken,
  verifyAuthToken,
} from "../core/sec.ts";
import { makeAuthOauth2Plugin } from "./auth-oauth2.ts";
import {
  getAppUrl,
  getTemplate,
  isSmtpConfigured,
  renderTemplate,
  sendEmail,
} from "../core/email.ts";
import { buildOtpauthUrl, generateSecret, verifyCode as verifyTotpCode } from "../core/totp.ts";
import { isAuthFeatureEnabled } from "../core/auth-features.ts";
import { validatePassword } from "../core/password-policy.ts";
import {
  recordAdminSession,
  recordLoginFailure,
  clearLoginFailures,
  isLockedOut,
  getTrustedProxiesRaw,
} from "../core/security.ts";

/** Best-effort client IP for lockout keying. Honours trusted-proxies setting. */
function clientIpForLockout(request: Request): string | null {
  if (!getTrustedProxiesRaw()) return null;
  const xff = request.headers.get("x-forwarded-for");
  if (!xff) return null;
  return (xff.split(",")[0] ?? "").trim() || null;
}

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const OTP_TTL_SECONDS = 10 * 60; // 10 minutes
const MFA_TICKET_TTL_SECONDS = 5 * 60; // 5 minutes — enough to type a code

async function hashPassword(plaintext: string): Promise<string> {
  return await Bun.password.hash(plaintext, HASH_OPTS);
}

const MAX_OTP_ATTEMPTS = 5;

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a single 8-character alphanumeric recovery code formatted as
 * `XXXX-XXXX`. Uses an unambiguous alphabet (no 0/O, 1/I) to make codes
 * easier to read off paper.
 */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newRecoveryCode(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += RECOVERY_ALPHABET[buf[i]! % RECOVERY_ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

async function generateRecoveryCodesFor(
  userId: string,
  collectionId: string,
  jwtSecret: string,
): Promise<string[]> {
  const db = getDb();
  // Wipe any existing codes — regenerate is "replace all".
  const old = await db
    .select()
    .from(mfaRecoveryCodes)
    .where(
      and(eq(mfaRecoveryCodes.user_id, userId), eq(mfaRecoveryCodes.collection_id, collectionId)),
    );
  for (const row of old) {
    try {
      await db.delete(mfaRecoveryLookup).where(eq(mfaRecoveryLookup.recovery_id, row.id));
    } catch {
      /* noop */
    }
  }
  await db
    .delete(mfaRecoveryCodes)
    .where(
      and(eq(mfaRecoveryCodes.user_id, userId), eq(mfaRecoveryCodes.collection_id, collectionId)),
    );
  const plain: string[] = [];
  for (let i = 0; i < 10; i++) plain.push(newRecoveryCode());
  const now = Math.floor(Date.now() / 1000);
  for (const code of plain) {
    const id = crypto.randomUUID();
    const hash = await hashPassword(code);
    const hmac = await hmacRecoveryCode(code, jwtSecret);
    await db.insert(mfaRecoveryCodes).values({
      id,
      user_id: userId,
      collection_id: collectionId,
      code_hash: hash,
      created_at: now,
    });
    await db.insert(mfaRecoveryLookup).values({ hmac, recovery_id: id });
  }
  return plain;
}

/**
 * Run `validateRecord` against a collection's user-defined fields *and*
 * any implicit fields (auth's email/verified). The default `validateRecord`
 * skips implicit entries on the assumption their storage lives elsewhere;
 * for register we still want admin-set custom options (min length, pattern)
 * to apply to the incoming email/verified payload.
 */
async function validateAuthRegister(
  col: {
    id: string;
    name: string;
    type: string;
    fields: string;
    created_at: number;
    updated_at: number;
    view_query: string | null;
    list_rule: string | null;
    view_rule: string | null;
    create_rule: string | null;
    update_rule: string | null;
    delete_rule: string | null;
  },
  data: Record<string, unknown>,
): Promise<void> {
  const fields = parseFields(col.fields).map((f) => ({ ...f, implicit: false }));
  // Build a synthetic collection with implicit flags stripped so the validator
  // checks options on email/verified just like any other field.
  const synthetic = { ...col, fields: JSON.stringify(fields) };
  await validateRecord(
    synthetic as unknown as Parameters<typeof validateRecord>[0],
    data,
    "create",
  );
  // validateRecord's "email" branch only checks regex, not min/max length —
  // enforce admin-set length constraints here so register matches the rest of
  // the API surface (text-typed fields already get min/max from validateRecord).
  const lenErrors: Record<string, string> = {};
  for (const f of fields) {
    if (f.type !== "email") continue;
    const v = data[f.name];
    if (typeof v !== "string" || v === "") continue;
    if (f.options?.min !== undefined && v.length < f.options.min) {
      lenErrors[f.name] = `${f.name} must be at least ${f.options.min} characters`;
    } else if (f.options?.max !== undefined && v.length > f.options.max) {
      lenErrors[f.name] = `${f.name} must be at most ${f.options.max} characters`;
    }
  }
  if (Object.keys(lenErrors).length > 0) throw new ValidationError(lenErrors);
}

/** 6-digit numeric OTP, zero-padded. Avoids leading-zero ambiguity. */
function newOtpCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0]! % 1_000_000).toString().padStart(6, "0");
}

function buildLink(
  appUrl: string,
  kind: "verify" | "reset" | "otp",
  collection: string,
  token: string,
): string {
  const base = appUrl.replace(/\/+$/, "");
  const path = kind === "verify" ? "/auth/verify" : kind === "reset" ? "/auth/reset" : "/auth/otp";
  return `${base}${path}?token=${token}&collection=${encodeURIComponent(collection)}`;
}

async function issueAndSend(
  kind: "verify" | "reset",
  user: { id: string; email: string },
  collectionId: string,
  collectionName: string,
): Promise<void> {
  const token = newToken();
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  await getDb()
    .insert(authTokens)
    .values({
      id: token,
      user_id: user.id,
      collection_id: collectionId,
      purpose: kind === "verify" ? "email_verify" : "password_reset",
      expires_at: expiresAt,
    });
  const tpl = getTemplate(kind);
  const appUrl = getAppUrl();
  const vars = {
    email: user.email,
    token,
    link: buildLink(appUrl, kind, collectionName, token),
    appUrl,
    collection: collectionName,
  };
  await sendEmail({
    to: user.email,
    subject: renderTemplate(tpl.subject, vars),
    text: renderTemplate(tpl.body, vars),
  });
}

/**
 * Issue a single OTP record carrying both a long token (for the magic link)
 * and a 6-digit code (for typing). Either is sufficient to authenticate.
 */
async function issueOtpAndSend(
  user: { id: string; email: string },
  collectionId: string,
  collectionName: string,
): Promise<void> {
  const token = newToken();
  const code = newOtpCode();
  const expiresAt = Math.floor(Date.now() / 1000) + OTP_TTL_SECONDS;
  await getDb().insert(authTokens).values({
    id: token,
    user_id: user.id,
    collection_id: collectionId,
    purpose: "otp",
    code,
    expires_at: expiresAt,
  });
  const tpl = getTemplate("otp");
  const appUrl = getAppUrl();
  const vars = {
    email: user.email,
    token,
    code,
    link: buildLink(appUrl, "otp", collectionName, token),
    appUrl,
    collection: collectionName,
  };
  await sendEmail({
    to: user.email,
    subject: renderTemplate(tpl.subject, vars),
    text: renderTemplate(tpl.body, vars),
  });
}

export function makeAuthPlugin(jwtSecret: string) {
  return (
    new Hono()
      .get("/admin/setup/status", async (c) => {
        const db = getDb();
        const existing = await db.select().from(admin).limit(1);
        return c.json({ data: { has_admin: existing.length > 0 } });
      })
      .post(
        "/admin/setup",
        jsonBody(t.Object({ email: t.String(), password: t.String() })),
        async (c) => {
          const request = c.req.raw;
          const body = c.req.valid("json");
          {
            const pwErr = await validatePassword(
              typeof body.password === "string" ? body.password : "",
            );
            if (pwErr) {
              return c.json({ error: pwErr, code: 422 }, 422);
            }
          }
          // Optional setup-key gate. When `VAULTBASE_SETUP_KEY` is set, the
          // request must carry it as `X-Setup-Key`. Closes the race where an
          // attacker reaches /setup before the operator on a public IP.
          const expected = process.env.VAULTBASE_SETUP_KEY;
          if (expected) {
            const provided = request.headers.get("x-setup-key");
            if (!provided || provided !== expected) {
              return c.json({ error: "Setup key required", code: 401 }, 401);
            }
          }
          const db = getDb();
          const id = crypto.randomUUID();
          const hash = await hashPassword(body.password);
          const now = Math.floor(Date.now() / 1000);
          try {
            // Atomic: UNIQUE on email + count check via INSERT-then-validate.
            await db.insert(admin).values({
              id,
              email: body.email,
              password_hash: hash,
              password_reset_at: now,
              created_at: now,
            });
          } catch {
            return c.json({ error: "Admin already set up", code: 400 }, 400);
          }
          // Confirm we're still the only admin — if a concurrent setup landed,
          // delete our row to keep the install clean and refuse.
          const all = await db.select().from(admin);
          if (all.length > 1) {
            await db.delete(admin).where(eq(admin.id, id));
            return c.json({ error: "Admin already set up", code: 400 }, 400);
          }
          return c.json({ data: { id, email: body.email } });
        },
      )
      .post(
        "/admin/auth/login",
        jsonBody(t.Object({ email: t.String(), password: t.String() })),
        async (c) => {
          const request = c.req.raw;
          const body = c.req.valid("json");
          const ip = clientIpForLockout(request);
          // Lockout gate runs *before* password verify so a successful attempt
          // by a different account from the same IP doesn't leak signal.
          if (await isLockedOut({ email: body.email, ip })) {
            return new Response(
              JSON.stringify({ error: "Too many failed attempts. Try again later.", code: 429 }),
              {
                status: 429,
                headers: { "content-type": "application/json" },
              },
            );
          }
          const db = getDb();
          const rows = await db.select().from(admin).where(eq(admin.email, body.email)).limit(1);
          const a = rows[0];
          const hashToCheck = a?.password_hash ?? dummyPasswordHash();
          const valid = await Bun.password.verify(body.password, hashToCheck).catch(() => false);
          if (!a || !valid) {
            await recordLoginFailure({ email: body.email, ip });
            return new Response(JSON.stringify({ error: "Invalid credentials", code: 401 }), {
              status: 401,
              headers: { "content-type": "application/json" },
            });
          }
          await clearLoginFailures({ email: body.email, ip });
          const ttl = tokenWindowSeconds("admin");
          const { token, jti, exp, iat } = await signAuthToken({
            payload: { id: a.id, email: a.email },
            audience: "admin",
            expiresInSeconds: ttl,
            jwtSecret,
          });
          await recordAdminSession({
            jti,
            admin_id: a.id,
            admin_email: a.email,
            issued_at: iat,
            expires_at: exp,
            request,
          });
          const isHttps = new URL(request.url).protocol === "https:";
          const secureFlag = isHttps ? " Secure;" : "";
          const cookie = `vaultbase_admin_token=${token}; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=${ttl}`;
          return new Response(
            JSON.stringify({ data: { token, admin: { id: a.id, email: a.email } } }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "set-cookie": cookie,
              },
            },
          );
        },
      )
      .get("/admin/auth/me", async (c) => {
        const request = c.req.raw;
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const ctx = await verifyAuthToken(token, jwtSecret, { audience: "admin" });
        if (!ctx) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        return c.json({ data: { id: ctx.id, email: ctx.email ?? "", aud: "admin", exp: ctx.exp } });
      })
      // Admin recovery: clear a user's TOTP secret + recovery codes. Records
      // flow `PATCH` strips auth-system columns, so this dedicated endpoint
      // exists for the "user lost their authenticator" admin operation.
      .post("/admin/users/:collection/:id/disable-mfa", async (c) => {
        const request = c.req.raw;
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const ctx = await verifyAuthToken(token, jwtSecret, { audience: "admin" });
        if (!ctx) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const col = await getCollection(c.req.param("collection"));
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        if (col.type !== "auth") {
          return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
        }
        const u = findUserById(col, c.req.param("id"));
        if (!u) {
          return c.json({ error: "User not found", code: 404 }, 404);
        }
        const now = Math.floor(Date.now() / 1000);
        await updateUserById(col, c.req.param("id"), {
          totp_enabled: 0,
          totp_secret: null,
          updated_at: now,
        });
        // Wipe recovery codes — useless without TOTP.
        await getDb()
          .delete(mfaRecoveryCodes)
          .where(
            and(
              eq(mfaRecoveryCodes.user_id, c.req.param("id")),
              eq(mfaRecoveryCodes.collection_id, col.id),
            ),
          );
        return c.json({ data: { disabled: true } });
      })
      .post(
        "/auth/:collection/register",
        jsonBody(
          t.Object({ email: t.String(), password: t.String() }, { additionalProperties: true }),
        ),
        async (c) => {
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) {
            return c.json({ error: "Collection not found", code: 404 }, 404);
          }
          if (col.type !== "auth") {
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          }
          {
            const pwErr = await validatePassword(
              typeof body.password === "string" ? body.password : "",
            );
            if (pwErr) {
              return c.json({ error: pwErr, code: 422 }, 422);
            }
          }
          // v0.11: per-collection email uniqueness via vb_<col> + legacy
          // fallback. Earlier versions enforced GLOBAL email uniqueness across
          // every auth collection — pre-existing rows still work via the
          // helper's fallback to vaultbase_users.
          const existing = findUserByEmail(col, body.email);
          // No-enumeration: always return a generic success. If the email is
          // taken, queue a "complete account / reset password" email instead so
          // the legitimate owner can recover, and refuse silently.
          if (existing) {
            if (isSmtpConfigured()) {
              issueAndSend(
                "reset",
                { id: existing.id, email: existing.email },
                col.id,
                col.name,
              ).catch((e) => {
                log.error("reset email failed", {
                  scope: "auth",
                  email: redactEmail(existing.email),
                  err: e,
                });
              });
            }
            // Return the same shape as a fresh-success path so a network observer
            // can't tell the two cases apart. `id` is the existing user's id —
            // not a leak: knowing the id alone gives no access without auth.
            return c.json({ data: { id: existing.id, email: body.email } });
          }
          try {
            await validateAuthRegister(col, body as Record<string, unknown>);
          } catch (e) {
            if (e instanceof ValidationError) {
              return c.json({ error: "Validation failed", code: 422, details: e.details }, 422);
            }
            throw e;
          }
          const hash = await hashPassword(body.password);
          const id = crypto.randomUUID();
          const now = Math.floor(Date.now() / 1000);
          const { email, password, ...extra } = body;
          void password;

          // Hook lifecycle — auth signup gets the same beforeCreate /
          // afterCreate semantics as the records flow. beforeCreate can
          // mutate `extra` (custom fields) or throw to abort.
          const hookData: Record<string, unknown> = { email, ...extra };
          const helpers = makeHookHelpers({ collection: col.name, event: "beforeCreate" });
          try {
            await runBeforeHook(col, "beforeCreate", {
              record: hookData,
              existing: null,
              auth: null,
              helpers,
            });
          } catch (e) {
            if (e instanceof ValidationError) {
              return c.json({ error: "Validation failed", code: 422, details: e.details }, 422);
            }
            throw e;
          }
          const finalExtra: Record<string, unknown> = { ...(hookData as Record<string, unknown>) };
          delete finalExtra.email; // already a top-level column

          await insertUser(col, {
            id,
            email,
            password_hash: hash,
            custom: finalExtra,
            legacyDataJson: JSON.stringify(finalExtra),
            created_at: now,
            updated_at: now,
          });

          // Read back as a record (uniform shape with password_hash stripped)
          // and fire afterCreate.
          const created = await getRecord(col.name, id);
          if (created) {
            runAfterHook(col, "afterCreate", {
              record: created as unknown as Record<string, unknown>,
              existing: null,
              auth: null,
              helpers,
            });
          }
          if (isSmtpConfigured()) {
            issueAndSend("verify", { id, email }, col.id, col.name).catch((e) => {
              log.error("verification email failed", {
                scope: "auth",
                email: redactEmail(email),
                err: e,
              });
            });
          }
          return c.json({ data: { id, email } });
        },
      )
      .post(
        "/auth/:collection/login",
        jsonBody(t.Object({ email: t.String(), password: t.String() })),
        async (c) => {
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) {
            return c.json({ error: "Collection not found", code: 404 }, 404);
          }
          if (col.type !== "auth") {
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          }
          // Per-collection email lookup (vb_<col> first, legacy fallback).
          const u = findUserByEmail(col, body.email);
          // Always verify (against dummy hash on miss) so timing is constant.
          const hashToCheck = u?.password_hash ?? dummyPasswordHash();
          const valid = await Bun.password.verify(body.password, hashToCheck).catch(() => false);
          if (!u || !valid) {
            return c.json({ error: "Invalid credentials", code: 401 }, 401);
          }

          const db = getDb();
          if (u.totp_enabled === 1) {
            const ticket = newToken();
            const now = Math.floor(Date.now() / 1000);
            await db.insert(authTokens).values({
              id: ticket,
              user_id: u.id,
              collection_id: col.id,
              purpose: "mfa_ticket",
              expires_at: now + MFA_TICKET_TTL_SECONDS,
            });
            return c.json({ data: { mfa_required: true, mfa_token: ticket } });
          }

          const { token } = await signAuthToken({
            payload: { id: u.id, email: u.email, collection: c.req.param("collection") },
            audience: "user",
            expiresInSeconds: tokenWindowSeconds("user"),
            jwtSecret,
          });
          return c.json({ data: { token, record: { id: u.id, email: u.email } } });
        },
      )
      // Step-2 of MFA login: trade the mfa_token + a valid TOTP code (or a
      // single-use recovery code) for a full JWT. Exactly one of `code` /
      // `recovery_code` must be supplied.
      .post(
        "/auth/:collection/login/mfa",
        jsonBody(
          t.Object({
            mfa_token: t.String(),
            code: t.Optional(t.String()),
            recovery_code: t.Optional(t.String()),
          }),
        ),
        async (c) => {
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) {
            return c.json({ error: "Collection not found", code: 404 }, 404);
          }
          if (col.type !== "auth") {
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          }
          const hasCode = typeof body.code === "string" && body.code.length > 0;
          const hasRecovery =
            typeof body.recovery_code === "string" && body.recovery_code.length > 0;
          if (hasCode === hasRecovery) {
            return c.json(
              { error: "Provide exactly one of code or recovery_code", code: 422 },
              422,
            );
          }
          const db = getDb();
          const rows = await db
            .select()
            .from(authTokens)
            .where(eq(authTokens.id, body.mfa_token))
            .limit(1);
          const tok = rows[0];
          const now = Math.floor(Date.now() / 1000);
          if (
            tok?.purpose !== "mfa_ticket" ||
            tok.collection_id !== col.id ||
            tok.used_at ||
            tok.expires_at < now
          ) {
            return c.json({ error: "Invalid or expired MFA ticket", code: 400 }, 400);
          }
          const u = findUserById(col, tok.user_id);
          if (!u?.totp_secret) {
            return c.json({ error: "MFA not configured for this account", code: 400 }, 400);
          }
          if (hasCode) {
            if (!verifyTotpCode(u.totp_secret, body.code!)) {
              // Brute-force gate per ticket.
              const attempts = (tok.attempts ?? 0) + 1;
              await db.update(authTokens).set({ attempts }).where(eq(authTokens.id, tok.id));
              if (attempts >= MAX_OTP_ATTEMPTS) {
                await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
              }
              return c.json({ error: "Invalid code", code: 401 }, 401);
            }
          } else {
            // O(1) HMAC lookup; the actual hash is still argon2id (defense in depth).
            const hmac = await hmacRecoveryCode(body.recovery_code!, jwtSecret);
            const lookupRows = await db
              .select()
              .from(mfaRecoveryLookup)
              .where(eq(mfaRecoveryLookup.hmac, hmac))
              .limit(1);
            let matchId: string | null = null;
            if (lookupRows[0]) {
              const codeRow = await db
                .select()
                .from(mfaRecoveryCodes)
                .where(
                  and(
                    eq(mfaRecoveryCodes.id, lookupRows[0].recovery_id),
                    eq(mfaRecoveryCodes.user_id, u.id),
                    eq(mfaRecoveryCodes.collection_id, col.id),
                    isNull(mfaRecoveryCodes.used_at),
                  ),
                )
                .limit(1);
              if (codeRow[0]) {
                const ok = await Bun.password
                  .verify(body.recovery_code!, codeRow[0].code_hash)
                  .catch(() => false);
                if (ok) matchId = codeRow[0].id;
              }
            }
            if (!matchId) {
              const attempts = (tok.attempts ?? 0) + 1;
              await db.update(authTokens).set({ attempts }).where(eq(authTokens.id, tok.id));
              if (attempts >= MAX_OTP_ATTEMPTS) {
                await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
              }
              return c.json({ error: "Invalid recovery code", code: 401 }, 401);
            }
            await db
              .update(mfaRecoveryCodes)
              .set({ used_at: now })
              .where(eq(mfaRecoveryCodes.id, matchId));
            await db.delete(mfaRecoveryLookup).where(eq(mfaRecoveryLookup.recovery_id, matchId));
          }
          await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
          const { token } = await signAuthToken({
            payload: { id: u.id, email: u.email, collection: col.name },
            audience: "user",
            expiresInSeconds: tokenWindowSeconds("user"),
            jwtSecret,
          });
          return c.json({ data: { token, record: { id: u.id, email: u.email } } });
        },
      )
      // Mint 10 fresh recovery codes (replaces all existing). Returns plaintext.
      .post("/auth/:collection/totp/recovery/regenerate", async (c) => {
        const request = c.req.raw;
        const col = await getCollection(c.req.param("collection"));
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        if (col.type !== "auth") {
          return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
        }
        if (!isAuthFeatureEnabled("mfa")) {
          return c.json({ error: "MFA is disabled", code: 422 }, 422);
        }
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        // Centralized verifier — enforces jti revocation + password_reset_at
        // (a raw jwtVerify here skipped both: logged-out/reset tokens still passed).
        const authed = await verifyAuthToken(token, jwtSecret, { audience: "user" });
        if (!authed) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const userId = authed.id;
        const _db = getDb();
        const u = findUserById(col, userId);
        if (!u) {
          return c.json({ error: "User not found", code: 404 }, 404);
        }
        const codes = await generateRecoveryCodesFor(u.id, col.id, jwtSecret);
        return c.json({ data: { codes } });
      })
      // Counts of recovery codes (never plaintext). Used by the UI to nag users
      // to regenerate when they're running low.
      .get("/auth/:collection/totp/recovery/status", async (c) => {
        const request = c.req.raw;
        const col = await getCollection(c.req.param("collection"));
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        if (col.type !== "auth") {
          return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
        }
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        // Centralized verifier — enforces jti revocation + password_reset_at
        // (a raw jwtVerify here skipped both: logged-out/reset tokens still passed).
        const authed = await verifyAuthToken(token, jwtSecret, { audience: "user" });
        if (!authed) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const userId = authed.id;
        const db = getDb();
        const rows = await db
          .select()
          .from(mfaRecoveryCodes)
          .where(
            and(eq(mfaRecoveryCodes.user_id, userId), eq(mfaRecoveryCodes.collection_id, col.id)),
          );
        const total = rows.length;
        const remaining = rows.filter((r) => r.used_at === null).length;
        return c.json({ data: { total, remaining } });
      })
      .get("/auth/me", async (c) => {
        const request = c.req.raw;
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const ctx = await verifyAuthToken(token, jwtSecret, { audience: "user" });
        if (!ctx) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        return c.json({ data: { id: ctx.id, email: ctx.email ?? "", aud: "user", exp: ctx.exp } });
      })
      // ── Email verification ──────────────────────────────────────────────────
      // Authenticated user requests a fresh verification email for their address.
      .post("/auth/:collection/request-verify", async (c) => {
        const request = c.req.raw;
        const col = await getCollection(c.req.param("collection"));
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        if (col.type !== "auth") {
          return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
        }
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        // Centralized verifier — enforces jti revocation + password_reset_at
        // (a raw jwtVerify here skipped both: logged-out/reset tokens still passed).
        const authed = await verifyAuthToken(token, jwtSecret, { audience: "user" });
        if (!authed) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const userId = authed.id;
        const _db = getDb();
        const u = findUserById(col, userId);
        if (!u) {
          return c.json({ error: "User not found", code: 404 }, 404);
        }
        if (u.email_verified) return c.json({ data: { sent: false, alreadyVerified: true } });
        if (!isSmtpConfigured()) {
          return c.json({ error: "SMTP not configured", code: 422 }, 422);
        }
        try {
          await issueAndSend("verify", { id: u.id, email: u.email }, col.id, col.name);
          return c.json({ data: { sent: true } });
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : String(e), code: 500 }, 500);
        }
      })
      // Anyone with a valid token can confirm their email.
      .post(
        "/auth/:collection/verify-email",
        jsonBody(t.Object({ token: t.String() })),
        async (c) => {
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) {
            return c.json({ error: "Collection not found", code: 404 }, 404);
          }
          if (col.type !== "auth") {
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          }
          const db = getDb();
          const rows = await db
            .select()
            .from(authTokens)
            .where(eq(authTokens.id, body.token))
            .limit(1);
          const tok = rows[0];
          const now = Math.floor(Date.now() / 1000);
          if (
            tok?.purpose !== "email_verify" ||
            tok.collection_id !== col.id ||
            tok.used_at ||
            tok.expires_at < now
          ) {
            return c.json({ error: "Invalid or expired token", code: 400 }, 400);
          }
          await updateUserById(col, tok.user_id, { email_verified: 1, updated_at: now });
          await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
          return c.json({ data: { verified: true } });
        },
      )
      // ── Password reset ──────────────────────────────────────────────────────
      // Always returns 200 to avoid leaking which emails are registered.
      .post(
        "/auth/:collection/request-password-reset",
        jsonBody(t.Object({ email: t.String() })),
        async (c) => {
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) {
            return c.json({ error: "Collection not found", code: 404 }, 404);
          }
          if (col.type !== "auth") {
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          }
          if (!isSmtpConfigured()) {
            return c.json({ error: "SMTP not configured", code: 422 }, 422);
          }
          const u = findUserByEmail(col, body.email);
          if (u) {
            try {
              await issueAndSend("reset", { id: u.id, email: u.email }, col.id, col.name);
            } catch (e) {
              log.error("password reset email failed", {
                scope: "auth",
                email: redactEmail(u.email),
                err: e,
              });
            }
          }
          return c.json({ data: { sent: true } });
        },
      )
      .post(
        "/auth/:collection/confirm-password-reset",
        jsonBody(t.Object({ token: t.String(), password: t.String() })),
        async (c) => {
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) {
            return c.json({ error: "Collection not found", code: 404 }, 404);
          }
          if (col.type !== "auth") {
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          }
          {
            const pwErr = await validatePassword(
              typeof body.password === "string" ? body.password : "",
            );
            if (pwErr) {
              return c.json({ error: pwErr, code: 422 }, 422);
            }
          }
          const db = getDb();
          const rows = await db
            .select()
            .from(authTokens)
            .where(eq(authTokens.id, body.token))
            .limit(1);
          const tok = rows[0];
          const now = Math.floor(Date.now() / 1000);
          if (
            tok?.purpose !== "password_reset" ||
            tok.collection_id !== col.id ||
            tok.used_at ||
            tok.expires_at < now
          ) {
            return c.json({ error: "Invalid or expired token", code: 400 }, 400);
          }
          const hash = await hashPassword(body.password);
          // Bump `password_reset_at` so every JWT issued before the reset is
          // invalidated (verifyAuthToken rejects tokens with iat < this) — the
          // whole point of "reset my password because it was compromised".
          await updateUserById(col, tok.user_id, {
            password_hash: hash,
            password_reset_at: now,
            updated_at: now,
          });
          await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
          return c.json({ data: { reset: true } });
        },
      )
      // ── OTP / magic link ────────────────────────────────────────────────────
      // Always returns 200 (no enumeration). Issues both a long token (link) and
      // a 6-digit code; either can be used to authenticate.
      .post(
        "/auth/:collection/otp/request",
        jsonBody(t.Object({ email: t.String() })),
        async (c) => {
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) {
            return c.json({ error: "Collection not found", code: 404 }, 404);
          }
          if (col.type !== "auth") {
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          }
          if (!isAuthFeatureEnabled("otp")) {
            return c.json({ error: "OTP login is disabled", code: 422 }, 422);
          }
          if (!isSmtpConfigured()) {
            return c.json({ error: "SMTP not configured", code: 422 }, 422);
          }
          const u = findUserByEmail(col, body.email);
          if (u && u.is_anonymous !== 1) {
            try {
              await issueOtpAndSend({ id: u.id, email: u.email }, col.id, col.name);
            } catch (e) {
              log.error("otp email failed", {
                scope: "auth",
                email: redactEmail(u.email),
                err: e,
              });
            }
          }
          return c.json({ data: { sent: true } });
        },
      )
      // Auth via OTP — accepts either the long token OR the short code.
      // Logout — revokes the bearer token's `jti` and clears any auth cookies.
      .post("/auth/logout", async (c) => {
        const request = c.req.raw;
        const { extractBearer, revokeToken } = await import("../core/sec.ts");
        const token = extractBearer(request);
        if (token) {
          const ctx = await verifyAuthToken(token, jwtSecret, { recheckPrincipal: false });
          if (ctx?.jti && ctx.exp) await revokeToken(ctx.jti, ctx.exp);
        }
        const isHttps = new URL(request.url).protocol === "https:";
        const secureFlag = isHttps ? " Secure;" : "";
        const headers = new Headers({ "content-type": "application/json" });
        headers.append(
          "set-cookie",
          `vaultbase_admin_token=; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=0`,
        );
        headers.append(
          "set-cookie",
          `vaultbase_user_token=; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=0`,
        );
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers });
      })
      .post(
        "/auth/:collection/otp/auth",
        jsonBody(
          t.Object({
            token: t.Optional(t.String()),
            code: t.Optional(t.String()),
            email: t.Optional(t.String()),
          }),
        ),
        async (c) => {
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) {
            return c.json({ error: "Collection not found", code: 404 }, 404);
          }
          if (col.type !== "auth") {
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          }
          if (!isAuthFeatureEnabled("otp")) {
            return c.json({ error: "OTP login is disabled", code: 422 }, 422);
          }
          if (!body.token && !body.code) {
            return c.json({ error: "Provide token or code", code: 422 }, 422);
          }
          const db = getDb();
          const now = Math.floor(Date.now() / 1000);
          let tok;
          if (body.token) {
            const rows = await db
              .select()
              .from(authTokens)
              .where(eq(authTokens.id, body.token))
              .limit(1);
            tok = rows[0];
          } else {
            // Code lookups need the email too — codes alone are 6 digits and
            // cross-user collisions during the 10-minute window are realistic.
            if (!body.email) {
              return c.json({ error: "code requires email", code: 422 }, 422);
            }
            const userByEmail = findUserByEmail(col, body.email);
            if (!userByEmail) {
              return c.json({ error: "Invalid or expired code", code: 400 }, 400);
            }
            const tokenRows = await db
              .select()
              .from(authTokens)
              .where(
                and(
                  eq(authTokens.user_id, userByEmail.id),
                  eq(authTokens.purpose, "otp"),
                  eq(authTokens.code, body.code!),
                ),
              )
              .limit(1);
            tok = tokenRows[0];
          }
          if (
            tok?.purpose !== "otp" ||
            tok.collection_id !== col.id ||
            tok.used_at ||
            tok.expires_at < now
          ) {
            return c.json({ error: "Invalid or expired code", code: 400 }, 400);
          }
          if ((tok.attempts ?? 0) >= MAX_OTP_ATTEMPTS) {
            await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
            return c.json({ error: "Invalid or expired code", code: 400 }, 400);
          }
          const u = findUserById(col, tok.user_id);
          if (!u) {
            await db
              .update(authTokens)
              .set({ attempts: (tok.attempts ?? 0) + 1 })
              .where(eq(authTokens.id, tok.id));
            return c.json({ error: "User not found", code: 400 }, 400);
          }

          await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
          // OTP-issued sessions imply the email is verified (the IdP — us — confirmed it).
          if (!u.email_verified) {
            await updateUserById(col, u.id, { email_verified: 1, updated_at: now });
          }
          // OTP MFA gate would defeat the purpose of magic-link sign-in (no password).
          // We still respect TOTP if the user enabled it: issue an mfa ticket instead.
          if (u.totp_enabled === 1) {
            const ticket = newToken();
            await db.insert(authTokens).values({
              id: ticket,
              user_id: u.id,
              collection_id: col.id,
              purpose: "mfa_ticket",
              expires_at: now + MFA_TICKET_TTL_SECONDS,
            });
            return c.json({ data: { mfa_required: true, mfa_token: ticket } });
          }
          const { token: jwt } = await signAuthToken({
            payload: { id: u.id, email: u.email, collection: col.name },
            audience: "user",
            expiresInSeconds: tokenWindowSeconds("user"),
            jwtSecret,
          });
          return c.json({ data: { token: jwt, record: { id: u.id, email: u.email } } });
        },
      )
      // ── TOTP ────────────────────────────────────────────────────────────────
      // Step 1: generate a fresh secret + otpauth URL. Doesn't enable MFA yet.
      .post("/auth/:collection/totp/setup", async (c) => {
        const request = c.req.raw;
        const col = await getCollection(c.req.param("collection"));
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        if (col.type !== "auth") {
          return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
        }
        if (!isAuthFeatureEnabled("mfa")) {
          return c.json({ error: "MFA is disabled", code: 422 }, 422);
        }
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        // Centralized verifier — enforces jti revocation + password_reset_at
        // (a raw jwtVerify here skipped both: logged-out/reset tokens still passed).
        const authed = await verifyAuthToken(token, jwtSecret, { audience: "user" });
        if (!authed) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const userId = authed.id;
        const _db = getDb();
        const u = findUserById(col, userId);
        if (!u) {
          return c.json({ error: "User not found", code: 404 }, 404);
        }
        const secret = generateSecret();
        // Stash the pending secret on the user; gets activated on /confirm.
        await updateUserById(col, u.id, {
          totp_secret: secret,
          updated_at: Math.floor(Date.now() / 1000),
        });
        const otpauthUrl = buildOtpauthUrl({
          secret,
          accountName: u.email,
          issuer: getAppUrl() || "Vaultbase",
        });
        return c.json({ data: { secret, otpauth_url: otpauthUrl } });
      })
      // Step 2: confirm by submitting a code from the authenticator app — flips totp_enabled.
      .post(
        "/auth/:collection/totp/confirm",
        jsonBody(t.Object({ code: t.String() })),
        async (c) => {
          const request = c.req.raw;
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) {
            return c.json({ error: "Collection not found", code: 404 }, 404);
          }
          if (col.type !== "auth") {
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          }
          if (!isAuthFeatureEnabled("mfa")) {
            return c.json({ error: "MFA is disabled", code: 422 }, 422);
          }
          const token = request.headers.get("authorization")?.replace("Bearer ", "");
          if (!token) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          // Centralized verifier — enforces jti revocation + password_reset_at
          // (a raw jwtVerify here skipped both: logged-out/reset tokens still passed).
          const authed = await verifyAuthToken(token, jwtSecret, { audience: "user" });
          if (!authed) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const userId = authed.id;
          const _db = getDb();
          const u = findUserById(col, userId);
          if (!u) {
            return c.json({ error: "User not found", code: 404 }, 404);
          }
          if (!u.totp_secret) {
            return c.json({ error: "Run /totp/setup first", code: 400 }, 400);
          }
          if (!verifyTotpCode(u.totp_secret, body.code)) {
            return c.json({ error: "Invalid code", code: 401 }, 401);
          }
          await updateUserById(col, u.id, {
            totp_enabled: 1,
            updated_at: Math.floor(Date.now() / 1000),
          });
          return c.json({ data: { enabled: true } });
        },
      )
      // Disable MFA. Requires the current code to prevent hijacked sessions from disabling it.
      .post(
        "/auth/:collection/totp/disable",
        jsonBody(t.Object({ code: t.String() })),
        async (c) => {
          const request = c.req.raw;
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) {
            return c.json({ error: "Collection not found", code: 404 }, 404);
          }
          if (col.type !== "auth") {
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          }
          const token = request.headers.get("authorization")?.replace("Bearer ", "");
          if (!token) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          // Centralized verifier — enforces jti revocation + password_reset_at
          // (a raw jwtVerify here skipped both: logged-out/reset tokens still passed).
          const authed = await verifyAuthToken(token, jwtSecret, { audience: "user" });
          if (!authed) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const userId = authed.id;
          const db = getDb();
          const u = findUserById(col, userId);
          if (!u) {
            return c.json({ error: "User not found", code: 404 }, 404);
          }
          if (!u.totp_secret) {
            return c.json({ error: "MFA not configured", code: 400 }, 400);
          }
          if (!verifyTotpCode(u.totp_secret, body.code)) {
            return c.json({ error: "Invalid code", code: 401 }, 401);
          }
          await updateUserById(col, u.id, {
            totp_enabled: 0,
            totp_secret: null,
            updated_at: Math.floor(Date.now() / 1000),
          });
          // Wipe recovery codes — they're useless without TOTP, and leaving
          // them around would let a re-enabled MFA inherit stale codes.
          await db
            .delete(mfaRecoveryCodes)
            .where(
              and(eq(mfaRecoveryCodes.user_id, u.id), eq(mfaRecoveryCodes.collection_id, col.id)),
            );
          return c.json({ data: { enabled: false } });
        },
      )
      // ── Anonymous ──────────────────────────────────────────────────────────
      // Mints a guest user with a synthetic email. The returned JWT is a regular
      // user token — caller can later "promote" by setting email + password via PATCH.
      .post("/auth/:collection/anonymous", async (c) => {
        const col = await getCollection(c.req.param("collection"));
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        if (col.type !== "auth") {
          return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
        }
        if (!isAuthFeatureEnabled("anonymous")) {
          return c.json({ error: "Anonymous auth is disabled", code: 422 }, 422);
        }
        const id = crypto.randomUUID();
        const email = `anon_${id.replace(/-/g, "").slice(0, 16)}@anonymous.invalid`;
        const randomPw = crypto.randomUUID() + crypto.randomUUID();
        const hash = await hashPassword(randomPw);
        const now = Math.floor(Date.now() / 1000);
        await insertUser(col, {
          id,
          email,
          password_hash: hash,
          is_anonymous: 1,
          legacyDataJson: "{}",
          created_at: now,
          updated_at: now,
        });
        // afterCreate hook on anonymous signup — same lifecycle as a real
        // user, so apps that auto-provision related rows (default profile,
        // welcome notification, etc.) keep working.
        const created = await getRecord(col.name, id);
        if (created) {
          runAfterHook(col, "afterCreate", {
            record: created as unknown as Record<string, unknown>,
            existing: null,
            auth: null,
            helpers: makeHookHelpers({ collection: col.name, event: "afterCreate" }),
          });
        }
        const { token: jwt } = await signAuthToken({
          payload: { id, email, collection: col.name, anonymous: true },
          audience: "user",
          expiresInSeconds: tokenWindowSeconds("anonymous"),
          jwtSecret,
        });
        return c.json({ data: { token: jwt, record: { id, email, anonymous: true } } });
      })
      // ── Anonymous → real account promotion ─────────────────────────────────
      // Caller must be holding an anonymous user JWT; supplies a real email +
      // password. We hash the password, flip is_anonymous=0, mint a fresh
      // (non-anonymous) JWT. Validates email uniqueness and the collection's
      // schema (so a min-length on `email` still applies).
      .post(
        "/auth/:collection/promote",
        jsonBody(
          t.Object({ email: t.String(), password: t.String() }, { additionalProperties: true }),
        ),
        async (c) => {
          const request = c.req.raw;
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) {
            return c.json({ error: "Collection not found", code: 404 }, 404);
          }
          if (col.type !== "auth") {
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          }
          const token = request.headers.get("authorization")?.replace("Bearer ", "");
          if (!token) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          // Centralized verifier — enforces jti revocation + password_reset_at
          // (a raw jwtVerify here skipped both). Anonymous-only is authoritatively
          // enforced below via `u.is_anonymous`, so the token's `anonymous` claim
          // is no longer consulted.
          const authed = await verifyAuthToken(token, jwtSecret, { audience: "user" });
          if (!authed) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const userId = authed.id;
          const _db = getDb();
          const u = findUserById(col, userId);
          if (!u) {
            return c.json({ error: "User not found", code: 404 }, 404);
          }
          if (u.is_anonymous !== 1) {
            return c.json({ error: "Only anonymous accounts can be promoted", code: 422 }, 422);
          }
          // Validate against the collection's schema (implicit + user fields).
          try {
            await validateAuthRegister(col, body as Record<string, unknown>);
          } catch (e) {
            if (e instanceof ValidationError) {
              return c.json({ error: "Validation failed", code: 422, details: e.details }, 422);
            }
            throw e;
          }
          // Email uniqueness within the collection (excluding self).
          const dup = findUserByEmail(col, body.email);
          if (dup && dup.id !== u.id) {
            return c.json({ error: "Email already in use", code: 409 }, 409);
          }
          {
            const pwErr = await validatePassword(
              typeof body.password === "string" ? body.password : "",
            );
            if (pwErr) {
              return c.json({ error: pwErr, code: 422 }, 422);
            }
          }
          const hash = await hashPassword(body.password);
          const now = Math.floor(Date.now() / 1000);
          const { email, password, ...extra } = body as Record<string, unknown>;
          void password;
          const update: Record<string, unknown> = {
            email: email as string,
            password_hash: hash,
            is_anonymous: 0,
            updated_at: now,
          };
          // Custom fields land as top-level keys; updateUserById whitelists
          // against the per-collection table schema. Legacy dual-write merges
          // them into the `data` JSON.
          for (const [k, v] of Object.entries(extra)) update[k] = v;
          await updateUserById(col, u.id, update);
          const { token: jwt } = await signAuthToken({
            payload: { id: u.id, email: email as string, collection: col.name },
            audience: "user",
            expiresInSeconds: tokenWindowSeconds("user"),
            jwtSecret,
          });
          return c.json({ data: { token: jwt, record: { id: u.id, email: email as string } } });
        },
      )
      // ── Admin impersonation ────────────────────────────────────────────────
      // Admin mints a short-lived user JWT for support purposes. JWT carries
      // `impersonated_by` so audit logs can attribute actions to the admin.
      .post("/admin/impersonate/:collection/:userId", async (c) => {
        const request = c.req.raw;
        // Centralized admin verifier — enforces jti revocation + password_reset_at.
        // A raw jwtVerify here let a revoked admin token mint impersonation JWTs.
        const me = await getAdmin(request, jwtSecret);
        if (!me) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const adminId = me.id;
        if (!isAuthFeatureEnabled("impersonation")) {
          return c.json({ error: "Impersonation is disabled", code: 422 }, 422);
        }
        const col = await getCollection(c.req.param("collection"));
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        if (col.type !== "auth") {
          return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
        }
        const u = findUserById(col, c.req.param("userId"));
        if (!u) {
          return c.json({ error: "User not found", code: 404 }, 404);
        }
        const { token: jwt } = await signAuthToken({
          payload: { id: u.id, email: u.email, collection: col.name, impersonated_by: adminId },
          audience: "user",
          expiresInSeconds: tokenWindowSeconds("impersonate"),
          jwtSecret,
        });
        return c.json({
          data: { token: jwt, record: { id: u.id, email: u.email }, impersonated_by: adminId },
        });
      })
      // OAuth2 routes — see ./auth-oauth2.ts
      .route("/", makeAuthOauth2Plugin(jwtSecret))
      // Token refresh — re-validates that the principal still exists.
      .post("/auth/refresh", async (c) => {
        const request = c.req.raw;
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const ctx = await verifyAuthToken(token, jwtSecret);
        if (!ctx) {
          return c.json({ error: "Token expired or invalid", code: 401 }, 401);
        }
        if (ctx.type !== "user" && ctx.type !== "admin") {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const claims: jose.JWTPayload = { id: ctx.id };
        if (ctx.email) claims.email = ctx.email;
        const { token: newToken } = await signAuthToken({
          payload: claims,
          audience: ctx.type,
          expiresInSeconds: tokenWindowSeconds("refresh"),
          jwtSecret,
        });
        return c.json({ data: { token: newToken } });
      })
  );
}
