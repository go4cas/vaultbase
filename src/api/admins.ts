import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import { getDb } from "../db/client.ts";
import { admin } from "../db/schema.ts";
import { HASH_OPTS, verifyAuthToken } from "../core/sec.ts";
import { validatePassword } from "../core/password-policy.ts";

interface AdminClaims {
  id: string;
  email: string;
}

async function verifyAdmin(request: Request, jwtSecret: string): Promise<AdminClaims | null> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  // Centralized verifier — fixes N-1 admin-token-bypass.
  const ctx = await verifyAuthToken(token, jwtSecret, { audience: "admin" });
  if (!ctx) return null;
  return { id: ctx.id, email: ctx.email ?? "" };
}

export function makeAdminsPlugin(jwtSecret: string) {
  return (
    new Hono()
      .get("/admin/admins", async (c) => {
        const me = await verifyAdmin(c.req.raw, jwtSecret);
        if (!me) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const db = getDb();
        const rows = await db
          .select({ id: admin.id, email: admin.email, created_at: admin.created_at })
          .from(admin);
        return c.json({ data: rows });
      })

      // Create new admin
      .post(
        "/admin/admins",
        jsonBody(t.Object({ email: t.String(), password: t.String() })),
        async (c) => {
          const me = await verifyAdmin(c.req.raw, jwtSecret);
          if (!me) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const body = c.req.valid("json");
          const pwErr = await validatePassword(body.password);
          if (pwErr) {
            return c.json({ error: pwErr, code: 422 }, 422);
          }
          const db = getDb();
          const existing = await db
            .select()
            .from(admin)
            .where(eq(admin.email, body.email))
            .limit(1);
          if (existing.length > 0) {
            return c.json({ error: "Email already in use", code: 400 }, 400);
          }
          const hash = await Bun.password.hash(body.password, HASH_OPTS);
          const id = crypto.randomUUID();
          const now = Math.floor(Date.now() / 1000);
          await db
            .insert(admin)
            .values({ id, email: body.email, password_hash: hash, created_at: now });
          return c.json({ data: { id, email: body.email, created_at: now } });
        },
      )

      // Update admin (email and/or password)
      .patch(
        "/admin/admins/:id",
        jsonBody(t.Object({ email: t.Optional(t.String()), password: t.Optional(t.String()) })),
        async (c) => {
          const me = await verifyAdmin(c.req.raw, jwtSecret);
          if (!me) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const id = c.req.param("id");
          const body = c.req.valid("json");
          const db = getDb();
          const target = await db.select().from(admin).where(eq(admin.id, id)).limit(1);
          if (target.length === 0) {
            return c.json({ error: "Admin not found", code: 404 }, 404);
          }

          const update: { email?: string; password_hash?: string } = {};
          if (body.email !== undefined) {
            // Check email uniqueness
            const dup = await db.select().from(admin).where(eq(admin.email, body.email)).limit(1);
            if (dup.length > 0 && dup[0]!.id !== id) {
              return c.json({ error: "Email already in use", code: 400 }, 400);
            }
            update.email = body.email;
          }
          if (body.password !== undefined) {
            const pwErr = await validatePassword(body.password);
            if (pwErr) {
              return c.json({ error: pwErr, code: 422 }, 422);
            }
            update.password_hash = await Bun.password.hash(body.password, HASH_OPTS);
          }
          if (Object.keys(update).length === 0) {
            return c.json({ data: { id, email: target[0]!.email } });
          }
          await db.update(admin).set(update).where(eq(admin.id, id));
          return c.json({ data: { id, email: update.email ?? target[0]!.email } });
        },
      )

      // Delete admin (cannot delete self, cannot delete last admin)
      .delete("/admin/admins/:id", async (c) => {
        const me = await verifyAdmin(c.req.raw, jwtSecret);
        if (!me) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const id = c.req.param("id");
        if (me.id === id) {
          return c.json({ error: "Cannot delete your own account", code: 400 }, 400);
        }
        const db = getDb();
        const countRows = await db.select({ c: count() }).from(admin);
        const total = countRows[0]?.c ?? 0;
        if (total <= 1) {
          return c.json({ error: "Cannot delete the last admin", code: 400 }, 400);
        }
        const target = await db.select().from(admin).where(eq(admin.id, id)).limit(1);
        if (target.length === 0) {
          return c.json({ error: "Admin not found", code: 404 }, 404);
        }
        await db.delete(admin).where(eq(admin.id, id));
        return c.json({ data: null });
      })
  );
}
