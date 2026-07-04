import type { Context } from "hono";

/**
 * Read `c.res.status`, tolerating the case where no response has been set yet
 * (accessing `.res` before dispatch, or after a handler threw). Returns
 * `fallback` in that case — access-log/audit sites default to 500, the root
 * timer to 0.
 */
export function resStatus(c: Context, fallback = 0): number {
  try {
    return c.res.status;
  } catch {
    return fallback;
  }
}
