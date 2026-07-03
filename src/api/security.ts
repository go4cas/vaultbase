/**
 * /api/v1/admin/security/* — backs the **Settings → Security** tab.
 */
import { Hono } from "hono";
import { requireAdmin, securityHeaders } from "../core/sec.ts";
import {
  listAdminSessions,
  revokeAdminSession,
  forceLogoutAllAdmins,
  shortFingerprint,
} from "../core/security.ts";

export function makeSecurityPlugin(jwtSecret: string, encryptionKey: string | undefined) {
  return new Hono()
    .get("/admin/security/sessions", async (c) => {
      if (!(await requireAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const activeOnly = c.req.query("activeOnly") !== "0";
      const sessions = await listAdminSessions({ activeOnly });
      return c.json({ data: sessions });
    })

    .delete("/admin/security/sessions/:jti", async (c) => {
      if (!(await requireAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const jti = c.req.param("jti");
      await revokeAdminSession(jti);
      return c.json({ data: { revoked: jti } });
    })

    .post("/admin/security/force-logout-all", async (c) => {
      if (!(await requireAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const result = await forceLogoutAllAdmins();
      return c.json({ data: result });
    })

    .get("/admin/security/fingerprints", async (c) => {
      if (!(await requireAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const [jwtFp, aesFp] = await Promise.all([
        shortFingerprint(jwtSecret),
        encryptionKey ? shortFingerprint(encryptionKey) : Promise.resolve("—"),
      ]);
      return c.json({
        data: {
          jwt_secret_fingerprint: jwtFp,
          encryption_key_fingerprint: aesFp,
          encryption_key_present: Boolean(encryptionKey),
        },
      });
    })

    .get("/admin/security/headers-preview", async (c) => {
      if (!(await requireAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      return c.json({
        data: {
          api: securityHeaders({ isApi: true }),
          ui: securityHeaders({ isApi: false }),
        },
      });
    });
}
