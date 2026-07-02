/**
 * Feature flags API.
 *
 * Admin (auth required, `audience: "admin"`):
 *   GET    /api/v1/admin/flags                — list all
 *   GET    /api/v1/admin/flags/:key           — read one
 *   POST   /api/v1/admin/flags                — create
 *   PATCH  /api/v1/admin/flags/:key           — update
 *   DELETE /api/v1/admin/flags/:key           — delete
 *   POST   /api/v1/admin/flags/:key/evaluate  — admin "test context" preview
 *
 * Public (auth optional — but evaluation context typically carries the
 * caller's user info):
 *   POST /api/v1/flags/evaluate    body: { context, keys?: string[] }
 *      → returns { data: { <key>: <value>, ... } }
 *      Returns ALL flags when `keys` is omitted; otherwise only those.
 *      Bulk-eval is the recommended client-SDK path: one round trip,
 *      one flag map you can refresh on websocket deltas later.
 */
import { Hono } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import { verifyAuthToken } from "../core/sec.ts";
import {
  listFlags,
  getFlag,
  upsertFlag,
  deleteFlag,
  evaluate,
  evaluateAll,
  listSegments,
  getSegment,
  upsertSegment,
  deleteSegment,
  type FlagValue,
  type Variation,
  type Rule,
  type Condition,
} from "../core/flags.ts";
import { broadcastSystem } from "../realtime/manager.ts";

const FLAGS_TOPIC = "__flags";

function pushFlagDelta(payload: { type: "flag_changed" | "flag_deleted"; key: string }): void {
  try {
    broadcastSystem(FLAGS_TOPIC, payload);
  } catch {
    /* swallow */
  }
}

async function requireAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

export function makeFlagsPlugin(jwtSecret: string) {
  return (
    new Hono()
      // ── Admin CRUD ────────────────────────────────────────────────────────
      .get("/admin/flags", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        return c.json({ data: await listFlags() });
      })
      .get("/admin/flags/:key", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const flag = await getFlag(c.req.param("key"));
        if (!flag) {
          return c.json({ error: "Flag not found", code: 404 }, 404);
        }
        return c.json({ data: flag });
      })
      .post(
        "/admin/flags",
        jsonBody(
          t.Object({
            key: t.String(),
            description: t.Optional(t.String()),
            type: t.Optional(
              t.Union([
                t.Literal("bool"),
                t.Literal("string"),
                t.Literal("number"),
                t.Literal("json"),
              ]),
            ),
            enabled: t.Optional(t.Boolean()),
            default_value: t.Optional(t.Any()),
            variations: t.Optional(t.Array(t.Any())),
            rules: t.Optional(t.Array(t.Any())),
          }),
        ),
        async (c) => {
          if (!(await requireAdmin(c.req.raw, jwtSecret))) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const body = c.req.valid("json");
          try {
            const input: Parameters<typeof upsertFlag>[0] = { key: body.key };
            if (body.description !== undefined) input.description = body.description;
            if (body.type !== undefined) input.type = body.type;
            if (body.enabled !== undefined) input.enabled = body.enabled;
            if (body.default_value !== undefined)
              input.default_value = body.default_value as FlagValue;
            if (body.variations !== undefined) input.variations = body.variations as Variation[];
            if (body.rules !== undefined) input.rules = body.rules as Rule[];
            const created = await upsertFlag(input);
            pushFlagDelta({ type: "flag_changed", key: created.key });
            return c.json({ data: created });
          } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e), code: 422 }, 422);
          }
        },
      )
      .patch(
        "/admin/flags/:key",
        jsonBody(
          t.Object({
            description: t.Optional(t.String()),
            type: t.Optional(
              t.Union([
                t.Literal("bool"),
                t.Literal("string"),
                t.Literal("number"),
                t.Literal("json"),
              ]),
            ),
            enabled: t.Optional(t.Boolean()),
            default_value: t.Optional(t.Any()),
            variations: t.Optional(t.Array(t.Any())),
            rules: t.Optional(t.Array(t.Any())),
          }),
        ),
        async (c) => {
          if (!(await requireAdmin(c.req.raw, jwtSecret))) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const body = c.req.valid("json");
          try {
            const input: Parameters<typeof upsertFlag>[0] = { key: c.req.param("key") };
            if (body.description !== undefined) input.description = body.description;
            if (body.type !== undefined) input.type = body.type;
            if (body.enabled !== undefined) input.enabled = body.enabled;
            if (body.default_value !== undefined)
              input.default_value = body.default_value as FlagValue;
            if (body.variations !== undefined) input.variations = body.variations as Variation[];
            if (body.rules !== undefined) input.rules = body.rules as Rule[];
            const updated = await upsertFlag(input);
            pushFlagDelta({ type: "flag_changed", key: updated.key });
            return c.json({ data: updated });
          } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e), code: 422 }, 422);
          }
        },
      )
      .delete("/admin/flags/:key", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const key = c.req.param("key");
        await deleteFlag(key);
        pushFlagDelta({ type: "flag_deleted", key });
        return c.json({ data: { deleted: key } });
      })
      // Test-evaluate: takes an arbitrary context, returns the resolved value
      // plus the trace (matched rule id, reason). Drives the "test context"
      // panel in the admin Flag editor.
      .post(
        "/admin/flags/:key/evaluate",
        jsonBody(t.Object({ context: t.Optional(t.Record(t.String(), t.Any())) })),
        async (c) => {
          if (!(await requireAdmin(c.req.raw, jwtSecret))) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const body = c.req.valid("json");
          const result = await evaluate(
            c.req.param("key"),
            (body.context ?? {}) as Record<string, unknown>,
          );
          return c.json({ data: result });
        },
      )

      // ── Segments ─────────────────────────────────────────────────────────
      .get("/admin/flag-segments", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        return c.json({ data: await listSegments() });
      })
      .get("/admin/flag-segments/:name", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const seg = await getSegment(c.req.param("name"));
        if (!seg) {
          return c.json({ error: "Segment not found", code: 404 }, 404);
        }
        return c.json({ data: seg });
      })
      .post(
        "/admin/flag-segments",
        jsonBody(
          t.Object({
            name: t.String(),
            description: t.Optional(t.String()),
            conditions: t.Optional(t.Any()),
          }),
        ),
        async (c) => {
          if (!(await requireAdmin(c.req.raw, jwtSecret))) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const body = c.req.valid("json");
          try {
            const input: Parameters<typeof upsertSegment>[0] = { name: body.name };
            if (body.description !== undefined) input.description = body.description;
            if (body.conditions !== undefined) input.conditions = body.conditions as Condition;
            const seg = await upsertSegment(input);
            pushFlagDelta({ type: "flag_changed", key: `__segment:${seg.name}` });
            return c.json({ data: seg });
          } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e), code: 422 }, 422);
          }
        },
      )
      .patch(
        "/admin/flag-segments/:name",
        jsonBody(
          t.Object({
            description: t.Optional(t.String()),
            conditions: t.Optional(t.Any()),
          }),
        ),
        async (c) => {
          if (!(await requireAdmin(c.req.raw, jwtSecret))) {
            return c.json({ error: "Unauthorized", code: 401 }, 401);
          }
          const body = c.req.valid("json");
          try {
            const input: Parameters<typeof upsertSegment>[0] = { name: c.req.param("name") };
            if (body.description !== undefined) input.description = body.description;
            if (body.conditions !== undefined) input.conditions = body.conditions as Condition;
            const seg = await upsertSegment(input);
            pushFlagDelta({ type: "flag_changed", key: `__segment:${seg.name}` });
            return c.json({ data: seg });
          } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e), code: 422 }, 422);
          }
        },
      )
      .delete("/admin/flag-segments/:name", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const name = c.req.param("name");
        await deleteSegment(name);
        pushFlagDelta({ type: "flag_deleted", key: `__segment:${name}` });
        return c.json({ data: { deleted: name } });
      })

      // ── Public bulk eval ──────────────────────────────────────────────────
      .post(
        "/flags/evaluate",
        jsonBody(
          t.Object({
            context: t.Optional(t.Record(t.String(), t.Any())),
            keys: t.Optional(t.Array(t.String())),
          }),
        ),
        async (c) => {
          const body = c.req.valid("json");
          const ctx = (body.context ?? {}) as Record<string, unknown>;
          if (Array.isArray(body.keys) && body.keys.length > 0) {
            const out: Record<string, FlagValue> = {};
            for (const k of body.keys) {
              const r = await evaluate(k, ctx);
              out[k] = r.value;
            }
            return c.json({ data: out });
          }
          return c.json({ data: await evaluateAll(ctx) });
        },
      )
  );
}
