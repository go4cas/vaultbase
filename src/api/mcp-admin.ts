/**
 * MCP admin REST surface — backs the `/_/mcp` admin SPA page.
 *
 *   GET /admin/mcp/clients   — currently-connected SSE clients (live)
 *   GET /admin/mcp/catalog   — enumerated tools / resources / prompts
 *
 * Both endpoints require the same admin JWT the rest of the SPA uses
 * (audience: "admin"). The catalog endpoint constructs an empty
 * ToolContext purely for description rendering; no tool handler runs,
 * so no scopes are exercised.
 */

import { Hono } from "hono";
import { extractBearer, verifyAuthToken } from "../core/sec.ts";
import { listMcpEventClients } from "../mcp/events.ts";
import { buildRegistry } from "../mcp/server.ts";
import { listResources, listResourceTemplates } from "../mcp/resources.ts";
import { listPrompts } from "../mcp/prompts.ts";

interface AdminCtx {
  id: string;
  email: string;
}

async function getAdmin(request: Request, jwtSecret: string): Promise<AdminCtx | null> {
  const token = extractBearer(request);
  if (!token) return null;
  const ctx = await verifyAuthToken(token, jwtSecret, { audience: "admin" });
  if (!ctx) return null;
  return { id: ctx.id, email: ctx.email ?? "" };
}

export function makeMcpAdminPlugin(jwtSecret: string) {
  return new Hono()
    .get("/admin/mcp/clients", async (c) => {
      const me = await getAdmin(c.req.raw, jwtSecret);
      if (!me) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      return c.json({ data: listMcpEventClients() });
    })
    .get("/admin/mcp/catalog", async (c) => {
      const me = await getAdmin(c.req.raw, jwtSecret);
      if (!me) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const reg = await buildRegistry(false);
      const tools = reg.list();
      const resources = listResources();
      const templates = listResourceTemplates();
      const prompts = listPrompts();
      return c.json({
        data: {
          tools,
          resources,
          resourceTemplates: templates,
          prompts,
          counts: {
            tools: tools.length,
            resources: resources.length,
            templates: templates.length,
            prompts: prompts.length,
          },
        },
      });
    });
}
