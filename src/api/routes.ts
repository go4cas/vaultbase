import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import { log } from "../core/log.ts";
import { getDb } from "../db/client.ts";
import { routes } from "../db/schema.ts";
import { ROUTE_METHODS, dispatchCustomRoute, invalidateRoutesCache } from "../core/routes.ts";
import { verifyAuthToken } from "../core/sec.ts";
import { customInnerPath } from "../core/api-paths.ts";

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  // Centralized verifier — fixes N-1 admin-token-bypass.
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

function validatePath(path: string): string | null {
  if (!path) return "path required";
  if (!path.startsWith("/")) return "path must start with /";
  if (path.includes("..")) return "path cannot contain '..'";
  return null;
}

/**
 * Returns a Response if the path matches a user route, otherwise undefined.
 * Wired into the main Elysia app's onRequest hook so it fires before route
 * resolution (preventing collisions with built-in /api/:collection routes).
 */
export async function tryDispatchCustom(
  request: Request,
  jwtSecret: string,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const inner = customInnerPath(url.pathname);
  if (inner === null) return undefined;
  try {
    const result = await dispatchCustomRoute(request, inner, jwtSecret);
    if (!result) {
      return new Response(JSON.stringify({ error: "No matching custom route", code: 404 }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...result.headers,
    };
    const body = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
    return new Response(body, { status: result.status, headers });
  } catch (e) {
    log.error("tryDispatchCustom failed", { scope: "routes", err: e });
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({ error: `Custom route dispatch failed: ${msg}`, code: 500 }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

export function makeRoutesPlugin(jwtSecret: string) {
  return new Hono()
    .get("/admin/routes", async (c) => {
      if (!(await isAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const rows = await getDb().select().from(routes);
      return c.json({ data: rows });
    })

    .post(
      "/admin/routes",
      jsonBody(
        t.Object({
          name: t.Optional(t.String()),
          method: t.Optional(t.String()),
          path: t.String(),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
        }),
      ),
      async (c) => {
        if (!(await isAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const body = c.req.valid("json");
        const method = (body.method ?? "GET").toUpperCase();
        if (!ROUTE_METHODS.includes(method as (typeof ROUTE_METHODS)[number])) {
          return c.json({ error: `Invalid method: ${method}`, code: 422 }, 422);
        }
        const pathErr = validatePath(body.path ?? "");
        if (pathErr) {
          return c.json({ error: pathErr, code: 422 }, 422);
        }
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        await getDb()
          .insert(routes)
          .values({
            id,
            name: body.name ?? "",
            method,
            path: body.path,
            code: body.code ?? "",
            enabled: body.enabled === false ? 0 : 1,
            created_at: now,
            updated_at: now,
          });
        invalidateRoutesCache();
        const row = await getDb().select().from(routes).where(eq(routes.id, id)).limit(1);
        return c.json({ data: row[0] });
      },
    )

    .patch(
      "/admin/routes/:id",
      jsonBody(
        t.Object({
          name: t.Optional(t.String()),
          method: t.Optional(t.String()),
          path: t.Optional(t.String()),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
        }),
      ),
      async (c) => {
        if (!(await isAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const body = c.req.valid("json");
        const update: {
          name?: string;
          method?: string;
          path?: string;
          code?: string;
          enabled?: number;
          updated_at: number;
        } = {
          updated_at: Math.floor(Date.now() / 1000),
        };
        if (body.name !== undefined) update.name = body.name;
        if (body.method !== undefined) {
          const m = body.method.toUpperCase();
          if (!ROUTE_METHODS.includes(m as (typeof ROUTE_METHODS)[number])) {
            return c.json({ error: `Invalid method: ${body.method}`, code: 422 }, 422);
          }
          update.method = m;
        }
        if (body.path !== undefined) {
          const pathErr = validatePath(body.path);
          if (pathErr) {
            return c.json({ error: pathErr, code: 422 }, 422);
          }
          update.path = body.path;
        }
        if (body.code !== undefined) update.code = body.code;
        if (body.enabled !== undefined) update.enabled = body.enabled ? 1 : 0;
        await getDb()
          .update(routes)
          .set(update)
          .where(eq(routes.id, c.req.param("id")));
        invalidateRoutesCache();
        const row = await getDb()
          .select()
          .from(routes)
          .where(eq(routes.id, c.req.param("id")))
          .limit(1);
        if (row.length === 0) {
          return c.json({ error: "Route not found", code: 404 }, 404);
        }
        return c.json({ data: row[0] });
      },
    )

    .delete("/admin/routes/:id", async (c) => {
      if (!(await isAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      await getDb()
        .delete(routes)
        .where(eq(routes.id, c.req.param("id")));
      invalidateRoutesCache();
      return c.json({ data: null });
    });
}
