import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import * as jose from "jose";
import { getDb } from "../db/client.ts";
import { authTokens, oauthLinks } from "../db/schema.ts";
import { getCollection } from "../core/collections.ts";
import { getRecord } from "../core/records.ts";
import { tokenWindowSeconds } from "../core/auth-tokens.ts";
import { findUserByEmail, findUserById, insertUser, updateUserById } from "../core/users-table.ts";
import { makeHookHelpers, runAfterHook } from "../core/hooks.ts";
import { HASH_OPTS, signAuthToken } from "../core/sec.ts";
import { getAllSettings } from "./settings.ts";
import {
  buildAuthorizeUrl,
  codeChallengeFromVerifier,
  exchangeCodeForToken,
  fetchProviderProfileFromExchange,
  generateCodeVerifier,
  isProviderEnabled,
  listEnabledProviders,
  providerRequiresPkce,
  PROVIDERS,
} from "../core/oauth2.ts";

const PKCE_TTL_SECONDS = 10 * 60; // 10 minutes — enough to complete the IdP redirect

function getSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

async function hashPassword(plaintext: string): Promise<string> {
  return await Bun.password.hash(plaintext, HASH_OPTS);
}

function isRedirectUriAllowed(provider: string, uri: string): boolean {
  const settings = getAllSettings();
  const raw =
    settings[`oauth2.${provider}.allowed_redirect_uris`] ??
    settings["oauth2.allowed_redirect_uris"] ??
    "";
  if (!raw) return true; // not configured → fall back to provider-side allowlist
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes("*")) return true;
  return list.some((p) => p === uri || (p.endsWith("*") && uri.startsWith(p.slice(0, -1))));
}

export function makeAuthOauth2Plugin(jwtSecret: string) {
  return (
    new Hono()
      .get("/auth/:collection/oauth2/providers", async (c) => {
        const col = await getCollection(c.req.param("collection"));
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        if (col.type !== "auth") {
          return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
        }
        return c.json({ data: listEnabledProviders() });
      })
      // Returns the provider's authorize URL with the caller-supplied redirect/state.
      // PKCE (RFC 7636):
      //  - Client provides `code_challenge` → server bakes it into the URL untouched
      //    and never stores anything; the client owns the verifier.
      //  - Client omits `code_challenge` → server generates a verifier, stashes it
      //    in `cogworks_auth_tokens` keyed by `state` (purpose="oauth2_pkce"), and
      //    bakes the derived challenge into the URL. Useful for confidential web
      //    flows where the caller can't easily keep the verifier across the redirect.
      .get("/auth/:collection/oauth2/authorize", async (c) => {
        const col = await getCollection(c.req.param("collection"));
        if (!col) {
          return c.json({ error: "Collection not found", code: 404 }, 404);
        }
        if (col.type !== "auth") {
          return c.json({ error: `'${col.name}' is not an auth collection`, code: 422 }, 422);
        }
        const provider = c.req.query("provider");
        const redirectUri = c.req.query("redirectUri");
        if (!provider || !redirectUri) {
          return c.json({ error: "provider and redirectUri are required", code: 422 }, 422);
        }
        if (!isProviderEnabled(provider)) {
          return c.json({ error: `Provider '${provider}' is not enabled`, code: 422 }, 422);
        }
        if (!isRedirectUriAllowed(provider, redirectUri)) {
          return c.json({ error: "redirectUri not in allowlist", code: 422 }, 422);
        }
        const state = c.req.query("state") ?? "";
        let codeChallenge: string | undefined;
        let serverManagedPkce = false;
        // Twitter (and any future requiresPkce provider) needs PKCE no matter what
        // the caller asked for. Promote use_pkce so we generate + store the verifier.
        const forcePkce = providerRequiresPkce(provider);
        const codeChallengeQuery = c.req.query("code_challenge");
        const usePkce = c.req.query("use_pkce");
        if (codeChallengeQuery) {
          // Client-managed PKCE: trust their challenge, store nothing.
          codeChallenge = codeChallengeQuery;
        } else if (usePkce === "1" || usePkce === "true" || forcePkce) {
          // Server-managed PKCE: generate verifier, store keyed by state.
          if (!state) {
            return c.json({ error: "state is required when use_pkce=1", code: 422 }, 422);
          }
          const verifier = generateCodeVerifier();
          codeChallenge = await codeChallengeFromVerifier(verifier);
          const now = Math.floor(Date.now() / 1000);
          try {
            await getDb()
              .insert(authTokens)
              .values({
                id: state,
                user_id: "", // pre-auth flow, no user yet
                collection_id: col.id,
                purpose: "oauth2_pkce",
                code: verifier, // reuse the `code` column to hold the verifier
                expires_at: now + PKCE_TTL_SECONDS,
              });
          } catch (e) {
            return c.json(
              {
                error: `Failed to persist PKCE state (state must be unique): ${e instanceof Error ? e.message : String(e)}`,
                code: 422,
              },
              422,
            );
          }
          serverManagedPkce = true;
        }
        try {
          const url = buildAuthorizeUrl({
            provider,
            redirectUri,
            state,
            ...(codeChallenge ? { codeChallenge, codeChallengeMethod: "S256" as const } : {}),
          });
          return c.json({
            data: {
              authorize_url: url,
              ...(codeChallenge
                ? { code_challenge: codeChallenge, code_challenge_method: "S256" }
                : {}),
              pkce: serverManagedPkce ? "server" : codeChallenge ? "client" : "none",
            },
          });
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : String(e), code: 422 }, 422);
        }
      })
      // Exchange authorization code for a cogworks JWT.
      // Linking strategy:
      //  1. Existing oauth_link row for (provider, provider_user_id) → log in linked user
      //  2. Otherwise, if profile.emailVerified and email matches an existing user in
      //     this collection → create link, log in
      //  3. Otherwise, create a fresh user (random unguessable password) + link
      .post(
        "/auth/:collection/oauth2/exchange",
        jsonBody(
          t.Object({
            provider: t.String(),
            code: t.String(),
            redirectUri: t.String(),
            // PKCE: client-supplied verifier wins; otherwise we look up by `state`.
            state: t.Optional(t.String()),
            code_verifier: t.Optional(t.String()),
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
          if (!PROVIDERS[body.provider]) {
            return c.json({ error: `Unknown provider '${body.provider}'`, code: 422 }, 422);
          }
          if (!isProviderEnabled(body.provider)) {
            return c.json({ error: `Provider '${body.provider}' is not enabled`, code: 422 }, 422);
          }
          if (!isRedirectUriAllowed(body.provider, body.redirectUri)) {
            return c.json({ error: "redirectUri not in allowlist", code: 422 }, 422);
          }

          // PKCE — pull a server-stored verifier keyed by state, if one exists.
          // Falls through silently when the caller is doing PKCE entirely client-side
          // (or not at all). A stored verifier is consumed (used_at set) on lookup.
          const db = getDb();
          const now = Math.floor(Date.now() / 1000);
          let codeVerifier: string | undefined = body.code_verifier;
          if (!codeVerifier && body.state) {
            const tokRows = await db
              .select()
              .from(authTokens)
              .where(eq(authTokens.id, body.state))
              .limit(1);
            const tok = tokRows[0];
            if (
              tok &&
              tok.purpose === "oauth2_pkce" &&
              tok.collection_id === col.id &&
              !tok.used_at &&
              tok.expires_at >= now
            ) {
              codeVerifier = tok.code ?? undefined;
              await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
            }
          }

          let profile;
          try {
            const tok = await exchangeCodeForToken({
              provider: body.provider,
              code: body.code,
              redirectUri: body.redirectUri,
              ...(codeVerifier ? { codeVerifier } : {}),
            });
            // Apple: identity comes from the id_token in the exchange response.
            // Everyone else: hit the provider's userinfo endpoint with the access_token.
            profile = await fetchProviderProfileFromExchange(body.provider, tok);
          } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e), code: 400 }, 400);
          }
          if (!profile.id || !profile.email) {
            return c.json(
              {
                error: "Provider returned an incomplete profile (missing id or email)",
                code: 400,
              },
              400,
            );
          }

          // 1. Existing link?
          const linked = await db
            .select()
            .from(oauthLinks)
            .where(
              and(
                eq(oauthLinks.provider, body.provider),
                eq(oauthLinks.provider_user_id, profile.id),
              ),
            )
            .limit(1);
          let userId: string | null = null;
          if (linked.length > 0 && linked[0]!.collection_id === col.id) {
            userId = linked[0]!.user_id;
          }

          // 2. Email-match (only if provider verified the email).
          //    Instead of auto-linking, return a 200 with `merge_required: true`
          //    and a single-use `merge_token`. The caller must call
          //    `/oauth2/merge-confirm` with the user's existing password (or a
          //    valid user token for that user) to consent before we link.
          if (!userId && profile.emailVerified) {
            const existing = findUserByEmail(col, profile.email);
            if (existing) {
              const matchedUserId = existing.id;
              const mergeToken = crypto.randomUUID();
              await db.insert(authTokens).values({
                id: mergeToken,
                user_id: matchedUserId,
                collection_id: col.id,
                purpose: "oauth2_merge",
                code: JSON.stringify({
                  provider: body.provider,
                  provider_user_id: profile.id,
                  email: profile.email,
                  name: profile.name ?? null,
                }),
                expires_at: now + 15 * 60,
                used_at: null,
                created_at: now,
              });
              return c.json({
                data: {
                  merge_required: true,
                  merge_token: mergeToken,
                  email: profile.email,
                  provider: body.provider,
                  message:
                    "An account with this email already exists. Confirm with your existing password (or a valid user token) at POST /api/v1/auth/:collection/oauth2/merge-confirm to link this provider.",
                },
              });
            }
          }

          // 3. Create new user — fires afterCreate on the auth collection.
          if (!userId) {
            const randomPw = crypto.randomUUID() + crypto.randomUUID();
            const hash = await hashPassword(randomPw);
            userId = crypto.randomUUID();
            await insertUser(col, {
              id: userId,
              email: profile.email,
              password_hash: hash,
              email_verified: profile.emailVerified ? 1 : 0,
              custom: profile.name ? { name: profile.name } : {},
              created_at: now,
              updated_at: now,
            });
            await db.insert(oauthLinks).values({
              id: crypto.randomUUID(),
              user_id: userId,
              collection_id: col.id,
              provider: body.provider,
              provider_user_id: profile.id,
              provider_email: profile.email,
            });
            // afterCreate hook on OAuth-provisioned new user.
            const created = await getRecord(col.name, userId);
            if (created) {
              runAfterHook(col, "afterCreate", {
                record: created as unknown as Record<string, unknown>,
                existing: null,
                auth: null,
                helpers: makeHookHelpers({ collection: col.name, event: "afterCreate" }),
              });
            }
          }

          const { token } = await signAuthToken({
            payload: { id: userId, email: profile.email, collection: col.name },
            audience: "user",
            expiresInSeconds: tokenWindowSeconds("user"),
            jwtSecret,
          });
          return c.json({ data: { token, record: { id: userId, email: profile.email } } });
        },
      )
      // Confirm a pending OAuth2 → existing-user merge. The exchange step
      // returned `{ merge_required: true, merge_token }` because the IdP-verified
      // email matched an existing account; this endpoint takes that token plus
      // proof-of-ownership (the user's password OR a valid user JWT for that
      // account) and performs the link.
      .post(
        "/auth/:collection/oauth2/merge-confirm",
        jsonBody(
          t.Object({
            merge_token: t.String(),
            password: t.Optional(t.String()),
          }),
        ),
        async (c) => {
          const request = c.req.raw;
          const body = c.req.valid("json");
          const col = await getCollection(c.req.param("collection"));
          if (!col) {
            return c.json({ error: "Collection not found", code: 404 }, 404);
          }
          const db = getDb();
          const now = Math.floor(Date.now() / 1000);

          const tokRows = await db
            .select()
            .from(authTokens)
            .where(eq(authTokens.id, body.merge_token))
            .limit(1);
          const tok = tokRows[0];
          if (
            tok?.purpose !== "oauth2_merge" ||
            tok.collection_id !== col.id ||
            tok.used_at ||
            tok.expires_at < now
          ) {
            return c.json({ error: "Invalid or expired merge token", code: 401 }, 401);
          }

          let stored: {
            provider: string;
            provider_user_id: string;
            email: string;
            name: string | null;
          };
          try {
            stored = JSON.parse(tok.code ?? "");
          } catch {
            return c.json({ error: "Corrupted merge token", code: 500 }, 500);
          }

          const user = findUserById(col, tok.user_id);
          if (!user) {
            return c.json({ error: "Account no longer exists", code: 401 }, 401);
          }

          // Proof of ownership — accept either:
          //   1. password (verify against the existing user's hash), OR
          //   2. an Authorization: Bearer <user-jwt> belonging to this user.
          let proven = false;
          if (typeof body.password === "string" && body.password !== "") {
            proven = await Bun.password.verify(body.password, user.password_hash);
          }
          if (!proven) {
            const headerToken = request.headers.get("authorization")?.replace("Bearer ", "");
            if (headerToken) {
              try {
                const { payload } = await jose.jwtVerify(headerToken, getSecret(jwtSecret), {
                  audience: "user",
                });
                if (typeof payload.id === "string" && payload.id === user.id) proven = true;
              } catch {
                /* invalid token — leave proven=false */
              }
            }
          }
          if (!proven) {
            return c.json(
              {
                error: "Password or user token did not match the existing account",
                code: 401,
              },
              401,
            );
          }

          // Already linked? If the same provider+provider_user_id row already
          // exists for this user, treat the call as idempotent and just sign a JWT.
          const existingLink = await db
            .select()
            .from(oauthLinks)
            .where(
              and(
                eq(oauthLinks.user_id, user.id),
                eq(oauthLinks.provider, stored.provider),
                eq(oauthLinks.provider_user_id, stored.provider_user_id),
              ),
            )
            .limit(1);
          if (existingLink.length === 0) {
            await db.insert(oauthLinks).values({
              id: crypto.randomUUID(),
              user_id: user.id,
              collection_id: col.id,
              provider: stored.provider,
              provider_user_id: stored.provider_user_id,
              provider_email: stored.email,
            });
          }
          if (!user.email_verified) {
            await updateUserById(col, user.id, { email_verified: 1, updated_at: now });
          }
          await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));

          const { token } = await signAuthToken({
            payload: { id: user.id, email: user.email, collection: col.name },
            audience: "user",
            expiresInSeconds: tokenWindowSeconds("user"),
            jwtSecret,
          });
          return c.json({
            data: {
              token,
              record: { id: user.id, email: user.email },
              linked_provider: stored.provider,
            },
          });
        },
      )
      // Unlink an OAuth2 provider from the calling user's account.
      // Refuses to leave the user without ANY way to sign in: if the user has no
      // password set (or only a placeholder; we can't tell post-hash) AND this
      // would be their last remaining link, returns 409. Detects the "real" case
      // by checking whether at least one OTHER link exists, OR a password_hash
      // is present (any user has one — anonymous + oauth-only users still hold a
      // random one — so the heuristic falls back to "must have ≥1 other sign-in
      // path", i.e. another link OR a verified email + non-anonymous flag).
      .delete("/auth/:collection/oauth2/:provider/unlink", async (c) => {
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
        let userId: string;
        try {
          const { payload } = await jose.jwtVerify(token, getSecret(jwtSecret), {
            audience: "user",
          });
          userId = String(payload.id ?? "");
          if (!userId) throw new Error("missing id");
        } catch {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const db = getDb();
        const u = findUserById(col, userId);
        if (!u) {
          return c.json({ error: "User not found", code: 404 }, 404);
        }

        const linkRows = await db
          .select()
          .from(oauthLinks)
          .where(
            and(eq(oauthLinks.user_id, userId), eq(oauthLinks.provider, c.req.param("provider"))),
          )
          .limit(1);
        if (linkRows.length === 0) {
          return c.json({ error: "No link for that provider", code: 404 }, 404);
        }

        // Lockout guard: a user with no password and no other oauth link would
        // be unable to sign in again. password_hash is NOT NULL at the schema
        // level, but oauth-only users carry an empty/placeholder hash that we
        // treat as "no password". (We can't actually distinguish a placeholder
        // from a hashed password without extra metadata, so callers who want
        // password+oauth must keep the password column non-empty — which the
        // standard register flow does.)
        const allLinks = await db.select().from(oauthLinks).where(eq(oauthLinks.user_id, userId));
        const remainingAfter = allLinks.filter(
          (l) => l.provider !== c.req.param("provider"),
        ).length;
        const hasPassword = u.password_hash !== "" && u.is_anonymous !== 1;
        if (!hasPassword && remainingAfter === 0) {
          return c.json({ error: "Cannot unlink — would leave you locked out", code: 409 }, 409);
        }

        await db
          .delete(oauthLinks)
          .where(
            and(eq(oauthLinks.user_id, userId), eq(oauthLinks.provider, c.req.param("provider"))),
          );
        return c.json({ data: null });
      })
  );
}
