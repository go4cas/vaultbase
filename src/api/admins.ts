import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import { getDb } from "../db/client.ts";
import { admin } from "../db/schema.ts";
import { HASH_OPTS, getAdmin } from "../core/sec.ts";
import { validatePassword } from "../core/password-policy.ts";
import { ADMIN_ROLES, isAdminRole, normalizeRole, roleRank } from "../core/admin-roles.ts";

/** Owners currently in the table — used to protect the last-owner invariant. */
async function ownerCount(): Promise<number> {
  const rows = await getDb().select({ c: count() }).from(admin).where(eq(admin.role, "owner"));
  return rows[0]?.c ?? 0;
}

export function makeAdminsPlugin(jwtSecret: string) {
  return (
    new Hono()
      .get("/admin/admins", async (c) => {
        const me = await getAdmin(c.req.raw, jwtSecret);
        if (!me) return c.json({ error: "Unauthorized", code: 401 }, 401);
        const rows = await getDb()
          .select({
            id: admin.id,
            email: admin.email,
            role: admin.role,
            created_at: admin.created_at,
          })
          .from(admin);
        return c.json({ data: rows });
      })

      // Create new admin. `role` defaults to `editor` (least privilege for a new
      // teammate) and may not exceed the caller's own role.
      .post(
        "/admin/admins",
        jsonBody(
          t.Object({
            email: t.String(),
            password: t.String(),
            role: t.Optional(t.Union(ADMIN_ROLES.map((r) => t.Literal(r)))),
          }),
        ),
        async (c) => {
          const me = await getAdmin(c.req.raw, jwtSecret);
          if (!me) return c.json({ error: "Unauthorized", code: 401 }, 401);
          const body = c.req.valid("json");
          const role = body.role ?? "editor";
          if (!isAdminRole(role)) return c.json({ error: "Invalid role", code: 422 }, 422);
          if (roleRank(role) > roleRank(me.role)) {
            return c.json({ error: "Cannot grant a role above your own", code: 403 }, 403);
          }
          const pwErr = await validatePassword(body.password);
          if (pwErr) return c.json({ error: pwErr, code: 422 }, 422);

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
            .values({ id, email: body.email, password_hash: hash, role, created_at: now });
          return c.json({ data: { id, email: body.email, role, created_at: now } });
        },
      )

      // Update admin (email, password, and/or role).
      .patch(
        "/admin/admins/:id",
        jsonBody(
          t.Object({
            email: t.Optional(t.String()),
            password: t.Optional(t.String()),
            role: t.Optional(t.Union(ADMIN_ROLES.map((r) => t.Literal(r)))),
          }),
        ),
        async (c) => {
          const me = await getAdmin(c.req.raw, jwtSecret);
          if (!me) return c.json({ error: "Unauthorized", code: 401 }, 401);
          const id = c.req.param("id");
          const body = c.req.valid("json");
          const db = getDb();
          const targetRows = await db.select().from(admin).where(eq(admin.id, id)).limit(1);
          const target = targetRows[0];
          if (!target) return c.json({ error: "Admin not found", code: 404 }, 404);

          const update: { email?: string; password_hash?: string; role?: string } = {};
          if (body.email !== undefined) {
            const dup = await db.select().from(admin).where(eq(admin.email, body.email)).limit(1);
            if (dup.length > 0 && dup[0]!.id !== id) {
              return c.json({ error: "Email already in use", code: 400 }, 400);
            }
            update.email = body.email;
          }
          if (body.password !== undefined) {
            const pwErr = await validatePassword(body.password);
            if (pwErr) return c.json({ error: pwErr, code: 422 }, 422);
            update.password_hash = await Bun.password.hash(body.password, HASH_OPTS);
          }
          if (body.role !== undefined) {
            if (!isAdminRole(body.role)) return c.json({ error: "Invalid role", code: 422 }, 422);
            if (roleRank(body.role) > roleRank(me.role)) {
              return c.json({ error: "Cannot grant a role above your own", code: 403 }, 403);
            }
            // Protect the last owner: refuse to demote the final owner account.
            if (
              normalizeRole(target.role) === "owner" &&
              body.role !== "owner" &&
              (await ownerCount()) <= 1
            ) {
              return c.json({ error: "Cannot demote the last owner", code: 400 }, 400);
            }
            update.role = body.role;
          }
          if (Object.keys(update).length === 0) {
            return c.json({ data: { id, email: target.email, role: target.role } });
          }
          await db.update(admin).set(update).where(eq(admin.id, id));
          return c.json({
            data: { id, email: update.email ?? target.email, role: update.role ?? target.role },
          });
        },
      )

      // Delete admin (cannot delete self, the last admin, or the last owner).
      .delete("/admin/admins/:id", async (c) => {
        const me = await getAdmin(c.req.raw, jwtSecret);
        if (!me) return c.json({ error: "Unauthorized", code: 401 }, 401);
        const id = c.req.param("id");
        if (me.id === id) {
          return c.json({ error: "Cannot delete your own account", code: 400 }, 400);
        }
        const db = getDb();
        const total = (await db.select({ c: count() }).from(admin))[0]?.c ?? 0;
        if (total <= 1) {
          return c.json({ error: "Cannot delete the last admin", code: 400 }, 400);
        }
        const targetRows = await db.select().from(admin).where(eq(admin.id, id)).limit(1);
        const target = targetRows[0];
        if (!target) return c.json({ error: "Admin not found", code: 404 }, 404);
        if (normalizeRole(target.role) === "owner" && (await ownerCount()) <= 1) {
          return c.json({ error: "Cannot delete the last owner", code: 400 }, 400);
        }
        await db.delete(admin).where(eq(admin.id, id));
        return c.json({ data: null });
      })
  );
}
