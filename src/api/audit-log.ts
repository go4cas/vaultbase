import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { listAuditEntries, recordAuditEntry } from "../core/audit-log.ts";
import { verifyAuthToken } from "../core/sec.ts";
import { isAdminApiPath } from "../core/api-paths.ts";

async function getAdmin(
  request: Request,
  jwtSecret: string,
): Promise<{ id: string; email: string } | null> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const ctx = await verifyAuthToken(token, jwtSecret, { audience: "admin" });
  if (!ctx) return null;
  return { id: ctx.id, email: ctx.email ?? "" };
}

/**
 * Root-level Hono middleware: capture every state-changing `/api/v1/admin/*`
 * request into the audit log (replaces the Elysia `{as:"global"}` onAfterHandle
 * + onError). `recordAuditEntry` skips read GETs internally. try/finally so
 * errored requests are audited too; the write is fire-and-forget.
 */
export function auditLogMiddleware(jwtSecret: string): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
    } finally {
      const request = c.req.raw;
      const url = new URL(request.url);
      if (isAdminApiPath(url.pathname)) {
        let status = 500;
        try {
          status = c.res.status;
        } catch {
          /* no response set — treat as 500 */
        }
        void (async () => {
          const actor = await getAdmin(request, jwtSecret);
          // Body is already consumed by the handler — we don't try to capture
          // it. The action label + target id from the path is sufficient for
          // most audit needs; full request bodies belong in the file logger.
          void recordAuditEntry({ request, status, actor }).catch(() => {
            /* swallow */
          });
        })();
      }
    }
  };
}

export function makeAuditLogPlugin(jwtSecret: string) {
  return new Hono().get("/admin/audit-log", async (c) => {
    const me = await getAdmin(c.req.raw, jwtSecret);
    if (!me) {
      return c.json({ error: "Unauthorized", code: 401 }, 401);
    }
    const opts: Parameters<typeof listAuditEntries>[0] = {};
    const page = c.req.query("page");
    const perPage = c.req.query("perPage");
    const actorId = c.req.query("actorId");
    const actionPrefix = c.req.query("actionPrefix");
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (page) opts.page = parseInt(page, 10);
    if (perPage) opts.perPage = parseInt(perPage, 10);
    if (actorId) opts.actorId = actorId;
    if (actionPrefix) opts.actionPrefix = actionPrefix;
    if (from) opts.from = parseInt(from, 10);
    if (to) opts.to = parseInt(to, 10);
    const result = await listAuditEntries(opts);
    return c.json({ data: result });
  });
}
