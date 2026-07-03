/**
 * Admin REST surface for API tokens.
 *
 *   GET    /admin/api-tokens          — list (no token values, only metadata)
 *   GET    /admin/api-tokens/:id      — one
 *   POST   /admin/api-tokens          — mint, returns the token ONCE
 *   DELETE /admin/api-tokens/:id      — revoke
 *   GET    /admin/api-tokens/me       — describe the current request's token
 *
 * Routes mount under `/api/v1` via the server's group prefix.
 */
import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import {
  DEFAULT_API_TOKEN_TTL_SEC,
  KNOWN_SCOPES,
  MAX_API_TOKEN_TTL_SEC,
  getApiToken,
  listApiTokens,
  mintApiToken,
  revokeApiToken,
} from "../core/api-tokens.ts";
import { extractBearer, getAdmin, verifyAuthToken } from "../core/sec.ts";

/** Sanitised row for the wire — never includes a token value. */
function rowForWire(r: Awaited<ReturnType<typeof getApiToken>>) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    scopes: r.scopes,
    created_by: r.created_by,
    created_by_email: r.created_by_email,
    created_at: r.created_at,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
    last_used_at: r.last_used_at,
    last_used_ip: r.last_used_ip,
    last_used_ua: r.last_used_ua,
    use_count: r.use_count,
    status: r.revoked_at
      ? "revoked"
      : r.expires_at < Math.floor(Date.now() / 1000)
        ? "expired"
        : "active",
  };
}

export function makeApiTokensPlugin(jwtSecret: string) {
  return new Hono()
    .get("/admin/api-tokens", async (c) => {
      const me = await getAdmin(c.req.raw, jwtSecret);
      if (!me) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const rows = await listApiTokens();
      return c.json({ data: rows.map((r) => rowForWire(r)) });
    })
    .get("/admin/api-tokens/me", async (c) => {
      // Useful for client tooling to verify what scopes a token has.
      const tok = extractBearer(c.req.raw);
      if (!tok) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const ctx = await verifyAuthToken(tok, jwtSecret);
      if (!ctx?.viaApiToken) {
        return c.json({ error: "not an api token", code: 400 }, 400);
      }
      return c.json({
        data: {
          id: ctx.jti,
          name: ctx.tokenName ?? "",
          scopes: ctx.scopes ?? [],
          minter_email: ctx.email ?? "",
          expires_at: ctx.exp ?? 0,
        },
      });
    })
    .get("/admin/api-tokens/:id", async (c) => {
      const me = await getAdmin(c.req.raw, jwtSecret);
      if (!me) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const row = await getApiToken(c.req.param("id"));
      if (!row) {
        return c.json({ error: "Token not found", code: 404 }, 404);
      }
      return c.json({ data: rowForWire(row) });
    })
    .post(
      "/admin/api-tokens",
      jsonBody(
        t.Object({
          name: t.String({ minLength: 1, maxLength: 100 }),
          scopes: t.Array(t.String({ minLength: 1, maxLength: 64 }), { minItems: 1 }),
          ttl_seconds: t.Optional(t.Integer({ minimum: 60, maximum: MAX_API_TOKEN_TTL_SEC })),
          ttlSeconds: t.Optional(t.Integer({ minimum: 60, maximum: MAX_API_TOKEN_TTL_SEC })),
        }),
      ),
      async (c) => {
        const me = await getAdmin(c.req.raw, jwtSecret);
        if (!me) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const body = c.req.valid("json");
        try {
          const ttlSeconds = body.ttl_seconds ?? body.ttlSeconds ?? DEFAULT_API_TOKEN_TTL_SEC;
          const result = await mintApiToken(
            {
              name: body.name,
              scopes: body.scopes,
              ttlSeconds,
              createdBy: me.id,
              createdByEmail: me.email,
            },
            jwtSecret,
          );
          // Return the token ONCE. Caller MUST persist it.
          return c.json(
            {
              data: {
                id: result.id,
                token: result.token,
                expires_at: result.expires_at,
                warning: "Save this token now — it will never be shown again.",
              },
            },
            201,
          );
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : "mint failed", code: 422 }, 422);
        }
      },
    )
    .delete("/admin/api-tokens/:id", async (c) => {
      const me = await getAdmin(c.req.raw, jwtSecret);
      if (!me) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const r = await revokeApiToken(c.req.param("id"));
      if (!r.revoked) {
        return c.json({ error: "Token not found", code: 404 }, 404);
      }
      return c.json({ data: { revoked: true } });
    })
    .get("/admin/api-tokens-meta/scopes", async (c) => {
      const me = await getAdmin(c.req.raw, jwtSecret);
      if (!me) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      return c.json({ data: { scopes: KNOWN_SCOPES } });
    });
}
