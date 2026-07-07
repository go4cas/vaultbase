/**
 * Admin read-side inspector for the realtime layer:
 *   GET /admin/realtime/state — live subscription topics + connection count
 *                               (this worker) and presence channels (cluster-wide,
 *                               from the presence table).
 */
import { Hono } from "hono";
import { getAdmin } from "../core/sec.ts";
import { realtimeStats } from "../realtime/manager.ts";
import { presenceChannels } from "../realtime/presence.ts";

export function makeRealtimeAdminPlugin(jwtSecret: string) {
  return new Hono().get("/admin/realtime/state", async (c) => {
    const me = await getAdmin(c.req.raw, jwtSecret);
    if (!me) {
      return c.json({ error: "Unauthorized", code: 401 }, 401);
    }
    const stats = realtimeStats();
    return c.json({
      data: {
        connections: stats.connections,
        topics: stats.topics,
        presence: presenceChannels(),
      },
    });
  });
}
