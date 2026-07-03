/**
 * WebAuthn / passkeys for auth-collection users. Mirrors the TOTP ceremony
 * placement in `auth.ts` and is mounted into `makeAuthPlugin` via `.route("/")`.
 *
 * Registration (authenticated — you register a passkey while logged in):
 *   POST /auth/:collection/webauthn/register/options   → { options, ticket }
 *   POST /auth/:collection/webauthn/register/verify     { ticket, response, device_name? }
 *
 * Login (pre-auth — passwordless):
 *   POST /auth/:collection/webauthn/login/options       { email } → { options, ticket }
 *   POST /auth/:collection/webauthn/login/verify         { ticket, response } → { token }
 *
 * Management (authenticated):
 *   GET    /auth/:collection/webauthn/credentials
 *   DELETE /auth/:collection/webauthn/credentials/:id
 *
 * Challenges are single-use rows in `cogworks_auth_tokens` (purpose
 * `webauthn_reg` / `webauthn_auth`), reusing its TTL + used_at machinery. The
 * challenge is consumed on every verify attempt — a retry needs fresh options,
 * which is the correct single-use-challenge behavior.
 */
import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { jsonBody } from "./validator.ts";
import { getDb } from "../db/client.ts";
import { authTokens } from "../db/schema.ts";
import { getCollection } from "../core/collections.ts";
import { findUserByEmail, findUserById } from "../core/users-table.ts";
import { signAuthToken, verifyAuthToken } from "../core/sec.ts";
import { tokenWindowSeconds } from "../core/auth-tokens.ts";
import { isAuthFeatureEnabled } from "../core/auth-features.ts";
import {
  getRpConfig,
  listCredentials,
  getCredentialByCredId,
  insertCredential,
  touchCredential,
  deleteCredential,
  bytesToBase64url,
  base64urlToBytes,
  type StoredCredential,
} from "../core/webauthn.ts";

const WEBAUTHN_TICKET_TTL_SECONDS = 5 * 60;

function newTicket(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function parseTransports(json: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!json) return undefined;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) && arr.length ? (arr as AuthenticatorTransportFuture[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Credential descriptor for allow/exclude lists — omits `transports` when
 * absent (exactOptionalPropertyTypes forbids an explicit `undefined`). */
function toDescriptor(c: StoredCredential): {
  id: string;
  transports?: AuthenticatorTransportFuture[];
} {
  const tr = parseTransports(c.transports);
  return tr ? { id: c.credential_id, transports: tr } : { id: c.credential_id };
}

/** Public projection of a stored credential (never leaks the public key). */
function publicCred(c: StoredCredential) {
  return {
    id: c.id,
    device_name: c.device_name,
    transports: parseTransports(c.transports) ?? [],
    created_at: c.created_at,
    last_used_at: c.last_used_at,
  };
}

export function makeAuthWebauthnPlugin(jwtSecret: string) {
  // ── ticket helpers (single-use challenge rows in cogworks_auth_tokens) ─────
  async function loadTicket(id: string, purpose: string, collectionId: string) {
    const rows = await getDb().select().from(authTokens).where(eq(authTokens.id, id)).limit(1);
    const tok = rows[0];
    const now = Math.floor(Date.now() / 1000);
    if (!tok || tok.purpose !== purpose || tok.collection_id !== collectionId) return null;
    if (tok.used_at || tok.expires_at < now) return null;
    return tok;
  }
  async function consumeTicket(id: string): Promise<void> {
    await getDb()
      .update(authTokens)
      .set({ used_at: Math.floor(Date.now() / 1000) })
      .where(eq(authTokens.id, id));
  }

  return (
    new Hono()
      // ── Registration: options (authenticated) ─────────────────────────────
      .post("/auth/:collection/webauthn/register/options", async (c) => {
        const request = c.req.raw;
        const col = await getCollection(c.req.param("collection"));
        if (!col) return c.json({ error: "Collection not found", code: 404 }, 404);
        if (col.type !== "auth")
          return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
        if (!isAuthFeatureEnabled("webauthn"))
          return c.json({ error: "WebAuthn is disabled", code: 422 }, 422);

        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        const authed = token ? await verifyAuthToken(token, jwtSecret, { audience: "user" }) : null;
        if (!authed) return c.json({ error: "Unauthorized", code: 401 }, 401);
        const u = findUserById(col, authed.id);
        if (!u) return c.json({ error: "User not found", code: 404 }, 404);

        const rp = getRpConfig();
        if (!rp)
          return c.json({ error: "WebAuthn is not configured (set app.url)", code: 422 }, 422);

        const existing = listCredentials(u.id, col.id);
        const options = await generateRegistrationOptions({
          rpName: rp.rpName,
          rpID: rp.rpID,
          userName: u.email ?? u.id,
          userID: new TextEncoder().encode(u.id),
          attestationType: "none",
          excludeCredentials: existing.map(toDescriptor),
          authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        });

        const ticket = newTicket();
        const now = Math.floor(Date.now() / 1000);
        await getDb()
          .insert(authTokens)
          .values({
            id: ticket,
            user_id: u.id,
            collection_id: col.id,
            purpose: "webauthn_reg",
            code: options.challenge,
            expires_at: now + WEBAUTHN_TICKET_TTL_SECONDS,
          });
        return c.json({ data: { options, ticket } });
      })
      // ── Registration: verify (authenticated) ──────────────────────────────
      .post(
        "/auth/:collection/webauthn/register/verify",
        jsonBody(
          t.Object({
            ticket: t.String(),
            response: t.Any(),
            device_name: t.Optional(t.String()),
          }),
        ),
        async (c) => {
          const request = c.req.raw;
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) return c.json({ error: "Collection not found", code: 404 }, 404);
          if (col.type !== "auth")
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          if (!isAuthFeatureEnabled("webauthn"))
            return c.json({ error: "WebAuthn is disabled", code: 422 }, 422);

          const token = request.headers.get("authorization")?.replace("Bearer ", "");
          const authed = token
            ? await verifyAuthToken(token, jwtSecret, { audience: "user" })
            : null;
          if (!authed) return c.json({ error: "Unauthorized", code: 401 }, 401);

          const rp = getRpConfig();
          if (!rp)
            return c.json({ error: "WebAuthn is not configured (set app.url)", code: 422 }, 422);

          const tok = await loadTicket(body.ticket, "webauthn_reg", col.id);
          if (!tok || tok.user_id !== authed.id || !tok.code)
            return c.json({ error: "Invalid or expired ticket", code: 400 }, 400);

          let verification;
          try {
            verification = await verifyRegistrationResponse({
              response: body.response as RegistrationResponseJSON,
              expectedChallenge: tok.code,
              expectedOrigin: rp.origins,
              expectedRPID: rp.rpID,
              requireUserVerification: false,
            });
          } catch (e) {
            await consumeTicket(tok.id);
            return c.json(
              { error: `Registration failed: ${(e as Error).message}`, code: 400 },
              400,
            );
          }
          await consumeTicket(tok.id);

          if (!verification.verified || !verification.registrationInfo)
            return c.json({ error: "Registration not verified", code: 400 }, 400);

          const cred = verification.registrationInfo.credential;
          const rowId = crypto.randomUUID();
          try {
            insertCredential({
              id: rowId,
              userId: authed.id,
              collectionId: col.id,
              credentialId: cred.id,
              publicKey: bytesToBase64url(cred.publicKey),
              counter: cred.counter,
              transports: cred.transports,
              deviceName: body.device_name ?? null,
            });
          } catch {
            // UNIQUE(credential_id) — this passkey is already registered.
            return c.json({ error: "Credential already registered", code: 409 }, 409);
          }
          return c.json({
            data: {
              verified: true,
              credential: { id: rowId, device_name: body.device_name ?? null },
            },
          });
        },
      )
      // ── Login: options (pre-auth, passwordless) ───────────────────────────
      .post(
        "/auth/:collection/webauthn/login/options",
        jsonBody(t.Object({ email: t.String() })),
        async (c) => {
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) return c.json({ error: "Collection not found", code: 404 }, 404);
          if (col.type !== "auth")
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          if (!isAuthFeatureEnabled("webauthn"))
            return c.json({ error: "WebAuthn is disabled", code: 422 }, 422);

          const rp = getRpConfig();
          if (!rp)
            return c.json({ error: "WebAuthn is not configured (set app.url)", code: 422 }, 422);

          // Look the user up to scope allowCredentials. When unknown/no passkeys
          // we still return valid options (empty allowCredentials) so the
          // response is uniform — no account-enumeration oracle.
          const u = findUserByEmail(col, body.email);
          const creds = u ? listCredentials(u.id, col.id) : [];
          const options = await generateAuthenticationOptions({
            rpID: rp.rpID,
            userVerification: "preferred",
            // Omit allowCredentials entirely (not `undefined`) when unknown →
            // discoverable-credential (usernameless) flow.
            ...(creds.length ? { allowCredentials: creds.map(toDescriptor) } : {}),
          });

          const ticket = newTicket();
          const now = Math.floor(Date.now() / 1000);
          await getDb()
            .insert(authTokens)
            .values({
              id: ticket,
              user_id: u?.id ?? "",
              collection_id: col.id,
              purpose: "webauthn_auth",
              code: options.challenge,
              expires_at: now + WEBAUTHN_TICKET_TTL_SECONDS,
            });
          return c.json({ data: { options, ticket } });
        },
      )
      // ── Login: verify (pre-auth) → JWT ────────────────────────────────────
      .post(
        "/auth/:collection/webauthn/login/verify",
        jsonBody(t.Object({ ticket: t.String(), response: t.Any() })),
        async (c) => {
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) return c.json({ error: "Collection not found", code: 404 }, 404);
          if (col.type !== "auth")
            return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
          if (!isAuthFeatureEnabled("webauthn"))
            return c.json({ error: "WebAuthn is disabled", code: 422 }, 422);

          const rp = getRpConfig();
          if (!rp)
            return c.json({ error: "WebAuthn is not configured (set app.url)", code: 422 }, 422);

          const tok = await loadTicket(body.ticket, "webauthn_auth", col.id);
          if (!tok || !tok.code)
            return c.json({ error: "Invalid or expired ticket", code: 400 }, 400);

          const responseId = (body.response as { id?: string })?.id ?? "";
          const cred = getCredentialByCredId(responseId);
          // Credential must exist AND belong to this collection — a passkey from
          // another collection must not authenticate here.
          if (!cred || cred.collection_id !== col.id) {
            await consumeTicket(tok.id);
            return c.json({ error: "Passkey not recognized", code: 401 }, 401);
          }

          const credTransports = parseTransports(cred.transports);
          let verification;
          try {
            verification = await verifyAuthenticationResponse({
              response: body.response as AuthenticationResponseJSON,
              expectedChallenge: tok.code,
              expectedOrigin: rp.origins,
              expectedRPID: rp.rpID,
              requireUserVerification: false,
              credential: {
                id: cred.credential_id,
                publicKey: base64urlToBytes(cred.public_key),
                counter: cred.counter,
                ...(credTransports ? { transports: credTransports } : {}),
              },
            });
          } catch (e) {
            await consumeTicket(tok.id);
            return c.json(
              { error: `Authentication failed: ${(e as Error).message}`, code: 401 },
              401,
            );
          }
          await consumeTicket(tok.id);

          if (!verification.verified)
            return c.json({ error: "Passkey verification failed", code: 401 }, 401);

          touchCredential(cred.id, verification.authenticationInfo.newCounter);
          const u = findUserById(col, cred.user_id);
          if (!u) return c.json({ error: "User not found", code: 401 }, 401);

          const { token } = await signAuthToken({
            payload: { id: u.id, email: u.email, collection: col.name },
            audience: "user",
            expiresInSeconds: tokenWindowSeconds("user"),
            jwtSecret,
          });
          return c.json({ data: { token, record: { id: u.id, email: u.email } } });
        },
      )
      // ── Management: list my passkeys (authenticated) ──────────────────────
      .get("/auth/:collection/webauthn/credentials", async (c) => {
        const request = c.req.raw;
        const col = await getCollection(c.req.param("collection"));
        if (!col) return c.json({ error: "Collection not found", code: 404 }, 404);
        if (col.type !== "auth")
          return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);

        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        const authed = token ? await verifyAuthToken(token, jwtSecret, { audience: "user" }) : null;
        if (!authed) return c.json({ error: "Unauthorized", code: 401 }, 401);

        return c.json({ data: listCredentials(authed.id, col.id).map(publicCred) });
      })
      // ── Management: delete a passkey (authenticated) ──────────────────────
      .delete("/auth/:collection/webauthn/credentials/:id", async (c) => {
        const request = c.req.raw;
        const col = await getCollection(c.req.param("collection"));
        if (!col) return c.json({ error: "Collection not found", code: 404 }, 404);
        if (col.type !== "auth")
          return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);

        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        const authed = token ? await verifyAuthToken(token, jwtSecret, { audience: "user" }) : null;
        if (!authed) return c.json({ error: "Unauthorized", code: 401 }, 401);

        const ok = deleteCredential(c.req.param("id"), authed.id, col.id);
        if (!ok) return c.json({ error: "Credential not found", code: 404 }, 404);
        return c.json({ data: { deleted: true } });
      })
  );
}
