/**
 * Control-plane role gate (roadmap F-9).
 *
 * One middleware, mounted ahead of the API plugins, that enforces the admin
 * operator-role tiers defined in `core/admin-roles.ts`. It only acts on gated
 * control-plane paths (schema, code, ops, credentials, admin management) — every
 * other request (records, auth, files, observability reads) falls straight
 * through to the endpoint's own `requireAdmin`. This is defense-in-depth layered
 * ON TOP of each plugin's existing auth, not a replacement for it.
 */
import type { MiddlewareHandler } from "hono";
import { classifyRequiredRole, roleAtLeast } from "../core/admin-roles.ts";
import { getAdmin } from "../core/sec.ts";

export function roleGateMiddleware(jwtSecret: string): MiddlewareHandler {
  return async (c, next) => {
    const required = classifyRequiredRole(c.req.method, c.req.path);
    if (!required) return next();

    const me = await getAdmin(c.req.raw, jwtSecret);
    // No valid admin token → let the endpoint's own gate produce the 401 (keeps
    // error shapes consistent), but short-circuit here so we never leak a
    // gated handler to an unauthenticated caller.
    if (!me) return c.json({ error: "Unauthorized", code: 401 }, 401);

    if (!roleAtLeast(me.role, required)) {
      return c.json(
        { error: `Forbidden: this action requires the '${required}' role or higher`, code: 403 },
        403,
      );
    }
    return next();
  };
}
