/**
 * WebAuthn / passkeys — Relying-Party config + credential registry helpers.
 *
 * The ceremony logic (generate/verify registration + authentication) lives in
 * `src/api/auth-webauthn.ts`; this module owns the two things that outlive a
 * single request: where the RP identity comes from, and the persistent
 * credential store (`cogworks_webauthn_credentials`).
 *
 * RP identity is derived from the existing `app.url` setting (the canonical
 * "where the frontend lives" value, already used for email links) so operators
 * configure one thing. `webauthn.rp_id` / `webauthn.origins` / `webauthn.rp_name`
 * settings override it when the API and frontend live on different hosts.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { webauthnCredentials } from "../db/schema.ts";
import { getAllSettings } from "../api/settings.ts";
import { getAppUrl } from "./email.ts";

export interface RpConfig {
  /** Relying Party ID — the registrable domain, no scheme/port (e.g. "app.example.com"). */
  rpID: string;
  /** Human-facing RP name shown in some authenticator UIs. */
  rpName: string;
  /** Allowed origins (scheme+host+port) accepted during verification. */
  origins: string[];
}

/**
 * Resolve RP config from settings, defaulting to the `app.url` host/origin.
 * Returns null when neither an explicit `webauthn.rp_id`+`webauthn.origins`
 * nor a parseable `app.url` is configured — callers should surface a clear
 * "WebAuthn not configured" error rather than attempting a ceremony.
 */
export function getRpConfig(): RpConfig | null {
  const s = getAllSettings();
  let rpID = (s["webauthn.rp_id"] ?? "").trim();
  let origins = (s["webauthn.origins"] ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (!rpID || origins.length === 0) {
    const appUrl = getAppUrl();
    if (appUrl) {
      try {
        const u = new URL(appUrl);
        if (!rpID) rpID = u.hostname;
        if (origins.length === 0) origins = [u.origin];
      } catch {
        /* malformed app.url — fall through to the null guard */
      }
    }
  }
  if (!rpID || origins.length === 0) return null;
  const rpName = (s["webauthn.rp_name"] ?? "").trim() || "Cogworks";
  return { rpID, rpName, origins };
}

export interface StoredCredential {
  id: string;
  user_id: string;
  collection_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_name: string | null;
  created_at: number;
  last_used_at: number | null;
}

/** All passkeys registered by a user in a collection, newest first. */
export function listCredentials(userId: string, collectionId: string): StoredCredential[] {
  const db = getDb();
  return db
    .select()
    .from(webauthnCredentials)
    .where(
      and(
        eq(webauthnCredentials.user_id, userId),
        eq(webauthnCredentials.collection_id, collectionId),
      ),
    )
    .all() as StoredCredential[];
}

/** Look up a single credential by its (globally unique) base64url credential id. */
export function getCredentialByCredId(credentialId: string): StoredCredential | null {
  const db = getDb();
  const rows = db
    .select()
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.credential_id, credentialId))
    .limit(1)
    .all() as StoredCredential[];
  return rows[0] ?? null;
}

export function insertCredential(row: {
  id: string;
  userId: string;
  collectionId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[] | undefined;
  deviceName: string | null;
}): void {
  getDb()
    .insert(webauthnCredentials)
    .values({
      id: row.id,
      user_id: row.userId,
      collection_id: row.collectionId,
      credential_id: row.credentialId,
      public_key: row.publicKey,
      counter: row.counter,
      transports: row.transports?.length ? JSON.stringify(row.transports) : null,
      device_name: row.deviceName,
    })
    .run();
}

/** Advance the signature counter + stamp last-used after a successful assertion. */
export function touchCredential(id: string, counter: number): void {
  getDb()
    .update(webauthnCredentials)
    .set({ counter, last_used_at: Math.floor(Date.now() / 1000) })
    .where(eq(webauthnCredentials.id, id))
    .run();
}

/** Delete a credential, scoped to its owner. Returns true if a row was removed. */
export function deleteCredential(id: string, userId: string, collectionId: string): boolean {
  const res = getDb()
    .delete(webauthnCredentials)
    .where(
      and(
        eq(webauthnCredentials.id, id),
        eq(webauthnCredentials.user_id, userId),
        eq(webauthnCredentials.collection_id, collectionId),
      ),
    )
    .run();
  return (res as unknown as { changes: number }).changes > 0;
}

/** Base64URL(no-pad) ⇄ bytes — used to persist the COSE public key as text. */
export function bytesToBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
export function base64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  // Uint8Array.from copies into a fresh ArrayBuffer-backed view (not the
  // Buffer's pooled ArrayBufferLike) — matches @simplewebauthn's expected type.
  return Uint8Array.from(Buffer.from(s, "base64url"));
}
