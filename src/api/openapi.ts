/**
 * OpenAPI spec + docs UI (roadmap F-2).
 *
 *   GET /api/v1/openapi.json  → the generated OpenAPI 3.0 document (offline)
 *   GET /api/v1/docs          → a Scalar-rendered reference for it
 *
 * Both are gated by the `docs.enabled` setting (default on) so an operator can
 * hide the API surface. The spec is fully self-contained; the docs page pulls
 * the Scalar viewer from a CDN when a human opens it (the server stays offline).
 */
import { Hono } from "hono";
import { listCollections } from "../core/collections.ts";
import { buildOpenApiSpec } from "../core/openapi.ts";
import { getAllSettings } from "./settings.ts";
import { getAppUrl } from "../core/email.ts";
import { COGWORKS_VERSION } from "../core/version.ts";

function docsEnabled(): boolean {
  const raw = getAllSettings()["docs.enabled"];
  return raw === undefined ? true : raw === "1" || raw === "true";
}

function serverUrl(): string {
  const app = getAppUrl();
  return app ? `${app.replace(/\/$/, "")}/api/v1` : "/api/v1";
}

const DOCS_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cogworks API</title>
  </head>
  <body>
    <script id="api-reference" data-url="./openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;

export function makeOpenApiPlugin() {
  return new Hono()
    .get("/openapi.json", async (c) => {
      if (!docsEnabled()) return c.json({ error: "Docs are disabled", code: 404 }, 404);
      const collections = await listCollections();
      const spec = buildOpenApiSpec(collections, {
        serverUrl: serverUrl(),
        version: COGWORKS_VERSION,
      });
      return c.json(spec);
    })
    .get("/docs", (c) => {
      if (!docsEnabled()) return c.json({ error: "Docs are disabled", code: 404 }, 404);
      return c.html(DOCS_HTML);
    });
}
