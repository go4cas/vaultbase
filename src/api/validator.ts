import { tbValidator } from "@hono/typebox-validator";
import type { TSchema } from "@sinclair/typebox";

/**
 * Body/query validators that fail with vaultbase's standard `{ error, code }`
 * envelope and a 422 (matching the pre-Hono Elysia behaviour + `ValidationError`
 * convention) instead of `@hono/typebox-validator`'s default 400 + bare message.
 */
export function jsonBody<T extends TSchema>(schema: T) {
  return tbValidator("json", schema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "Invalid request body", code: 422 }, 422);
    }
  });
}

export function queryParams<T extends TSchema>(schema: T) {
  return tbValidator("query", schema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "Invalid query parameters", code: 422 }, 422);
    }
  });
}
