/**
 * Shared helpers + constants for the auth sub-plugins (setup / user-auth /
 * MFA-recovery / account). Extracted from the monolithic `auth.ts` (T-6) so the
 * route groups can live in their own files without duplicating this logic.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { authTokens, mfaRecoveryCodes, mfaRecoveryLookup } from "../db/schema.ts";
import { parseFields } from "../core/collections.ts";
import { validateRecord, ValidationError } from "../core/validate.ts";
import { HASH_OPTS, hmacRecoveryCode } from "../core/sec.ts";
import { getAppUrl, getTemplate, renderTemplate } from "../core/email.ts";
import { enqueueEmail } from "../core/mail-queue.ts";
import { getTrustedProxiesRaw } from "../core/security.ts";

export const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const OTP_TTL_SECONDS = 10 * 60; // 10 minutes
export const MFA_TICKET_TTL_SECONDS = 5 * 60; // 5 minutes — enough to type a code
export const MAX_OTP_ATTEMPTS = 5;

/** Best-effort client IP for lockout keying. Honours trusted-proxies setting. */
export function clientIpForLockout(request: Request): string | null {
  if (!getTrustedProxiesRaw()) return null;
  const xff = request.headers.get("x-forwarded-for");
  if (!xff) return null;
  return (xff.split(",")[0] ?? "").trim() || null;
}

export async function hashPassword(plaintext: string): Promise<string> {
  return await Bun.password.hash(plaintext, HASH_OPTS);
}

/**
 * Generate a single 8-character alphanumeric recovery code formatted as
 * `XXXX-XXXX`. Uses an unambiguous alphabet (no 0/O, 1/I) to make codes
 * easier to read off paper.
 */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newRecoveryCode(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += RECOVERY_ALPHABET[buf[i]! % RECOVERY_ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 6-digit numeric OTP, zero-padded. Avoids leading-zero ambiguity. */
export function newOtpCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0]! % 1_000_000).toString().padStart(6, "0");
}

export async function generateRecoveryCodesFor(
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
 * Run `validateRecord` against a collection's user-defined fields *and* any
 * implicit fields (auth's email/verified). The default `validateRecord` skips
 * implicit entries; for register we still want admin-set custom options (min
 * length, pattern) to apply to the incoming email/verified payload.
 */
export async function validateAuthRegister(
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

export function buildLink(
  appUrl: string,
  kind: "verify" | "reset" | "otp",
  collection: string,
  token: string,
): string {
  const base = appUrl.replace(/\/+$/, "");
  const path = kind === "verify" ? "/auth/verify" : kind === "reset" ? "/auth/reset" : "/auth/otp";
  return `${base}${path}?token=${token}&collection=${encodeURIComponent(collection)}`;
}

export async function issueAndSend(
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
  // Durable send (E-8): enqueue so an SMTP blip retries instead of dropping.
  await enqueueEmail({
    to: user.email,
    subject: renderTemplate(tpl.subject, vars),
    text: renderTemplate(tpl.body, vars),
  });
}

/**
 * Issue a single OTP record carrying both a long token (for the magic link)
 * and a 6-digit code (for typing). Either is sufficient to authenticate.
 */
export async function issueOtpAndSend(
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
  // Durable send (E-8): enqueue so an SMTP blip retries instead of dropping.
  await enqueueEmail({
    to: user.email,
    subject: renderTemplate(tpl.subject, vars),
    text: renderTemplate(tpl.body, vars),
  });
}
