import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./validator.ts";
import * as jose from "jose";
import { timeFor } from "../core/perf-metrics.ts";
import { ISSUER, requireAdmin } from "../core/sec.ts";
import { isAdminApiPath } from "../core/api-paths.ts";
import { resStatus } from "./http-util.ts";
import {
  appendLogEntry,
  listLogDates,
  readLogs,
  searchLogs,
  type LogEntry,
  type LogRuleEval,
} from "../core/file-logger.ts";
import { clearRequestContext, getRuleEvals } from "../core/request-context.ts";

const SKIP_PREFIXES = ["/_/", "/admin/logs", "/realtime", "/health"];

function shouldSkip(path: string): boolean {
  return SKIP_PREFIXES.some((p) => path.startsWith(p));
}

export interface AuthLogContext {
  id: string;
  type: "user" | "admin";
  email?: string;
  /** Admin id from the JWT's `impersonated_by` claim, if present. */
  impersonated_by?: string;
}

export async function insertLog(
  method: string,
  path: string,
  status: number,
  duration_ms: number,
  ip: string | null,
  auth: AuthLogContext | null,
  rules?: LogRuleEval[],
): Promise<void> {
  const tsSec = Math.floor(Date.now() / 1000);
  const entry: LogEntry = {
    id: crypto.randomUUID(),
    ts: new Date(tsSec * 1000).toISOString(),
    created_at: tsSec,
    method,
    path,
    status,
    duration_ms,
    ip,
    auth_id: auth?.id ?? null,
    auth_type: auth?.type ?? null,
    auth_email: auth?.email ?? null,
    auth_impersonated_by: auth?.impersonated_by ?? null,
  };
  if (rules && rules.length > 0) entry.rules = rules;
  // Recorded inside the request's perf timer at the call site below — keep
  // this function pure so it stays callable from non-request paths.
  appendLogEntry(entry);
}

export type RuleOutcomeFilter = "all" | "any" | "allow" | "deny" | "filter";

export interface ListLogsOptions {
  page: number;
  perPage: number;
  method: string;
  status: string;
  includeAdmin: boolean;
  search?: string;
  minDuration?: number;
  /**
   * Filter by per-request rule outcome (records-API requests carry one or more
   * `rules[]` evaluations on the log entry):
   *   - "all"    → no filter (default)
   *   - "any"    → only entries that have any rule eval at all
   *   - "allow"  → at least one rule with outcome="allow"
   *   - "deny"   → at least one rule with outcome="deny"
   *   - "filter" → at least one rule with outcome="filter" (list_rule applied as SQL filter)
   */
  ruleOutcome?: RuleOutcomeFilter;
}

function matches(e: LogEntry, opts: ListLogsOptions): boolean {
  if (!opts.includeAdmin && isAdminApiPath(e.path)) return false;
  if (opts.method !== "all" && e.method !== opts.method) return false;
  if (opts.status === "2xx" && !(e.status >= 200 && e.status < 300)) return false;
  if (opts.status === "4xx" && !(e.status >= 400 && e.status < 500)) return false;
  if (opts.status === "5xx" && !(e.status >= 500)) return false;
  if (opts.search) {
    const q = opts.search.toLowerCase();
    const haystack = [
      e.path,
      e.message ?? "",
      e.hook_name ?? "",
      e.hook_event ?? "",
      e.hook_collection ?? "",
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (
    typeof opts.minDuration === "number" &&
    opts.minDuration > 0 &&
    e.duration_ms < opts.minDuration
  )
    return false;
  if (opts.ruleOutcome && opts.ruleOutcome !== "all") {
    const rules = e.rules ?? [];
    if (rules.length === 0) return false;
    if (opts.ruleOutcome === "any") return true;
    if (!rules.some((r) => r.outcome === opts.ruleOutcome)) return false;
  }
  return true;
}

const READ_CAP = 50_000;

export async function listLogs(opts: ListLogsOptions) {
  const { page, perPage } = opts;
  const all = await readLogs({ limit: READ_CAP });
  const filtered = all.filter((e) => matches(e, opts));
  const totalItems = filtered.length;
  const offset = (page - 1) * perPage;
  const data = filtered.slice(offset, offset + perPage);
  return {
    data,
    page,
    perPage,
    totalItems,
    totalPages: Math.ceil(totalItems / perPage),
  };
}

export async function extractAuth(
  request: Request,
  secret: Uint8Array,
): Promise<AuthLogContext | null> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  try {
    // For attribution on the request-log entry we do NOT need the full
    // recheck-principal pass — even a revoked-since-this-request token
    // should still show who originated the call. The handler that
    // serviced the request already enforced the live verification.
    const { payload } = await jose.jwtVerify(token, secret, { issuer: ISSUER });
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    if (aud !== "user" && aud !== "admin") return null;
    const ctx: AuthLogContext = {
      id: payload.id as string,
      type: aud as "user" | "admin",
    };
    if (typeof payload.email === "string") ctx.email = payload.email;
    if (typeof payload.impersonated_by === "string") ctx.impersonated_by = payload.impersonated_by;
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Root-level Hono middleware: access-log every non-skipped request after the
 * handler runs (replaces the Elysia `{as:"global"}` onAfterHandle + onError).
 * Uses try/finally so errored requests are logged too. Best-effort — the log
 * write is fire-and-forget so it never adds latency or breaks the response.
 */
export function accessLogMiddleware(jwtSecret: string): MiddlewareHandler {
  const secret = new TextEncoder().encode(jwtSecret);
  return async (c, next) => {
    const request = c.req.raw;
    const start = Date.now();
    try {
      await next();
    } finally {
      const path = new URL(request.url).pathname;
      if (!shouldSkip(path)) {
        const ms = Date.now() - start;
        const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
        const status = resStatus(c, 500);
        void (async () => {
          const auth = await extractAuth(request, secret);
          const rules = getRuleEvals(request);
          clearRequestContext(request);
          void timeFor(request, "log_write", () =>
            insertLog(request.method, path, status, ms, ip, auth, rules),
          );
        })();
      }
    }
  };
}

export function makeLogsPlugin(jwtSecret: string) {
  return new Hono()
    .get("/admin/logs", async (c) => {
      if (!(await requireAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
      const perPage = Math.min(
        200,
        Math.max(1, parseInt(c.req.query("perPage") ?? "50", 10) || 50),
      );
      const minDurationRaw = c.req.query("minDuration");
      const minDuration = minDurationRaw ? parseInt(minDurationRaw, 10) || 0 : 0;
      const opts: ListLogsOptions = {
        page,
        perPage,
        method: c.req.query("method") ?? "all",
        status: c.req.query("status") ?? "all",
        includeAdmin: c.req.query("includeAdmin") === "true",
        minDuration,
      };
      const search = c.req.query("search");
      if (search) opts.search = search;
      const ruleOutcome = c.req.query("ruleOutcome");
      if (ruleOutcome && ["all", "any", "allow", "deny", "filter"].includes(ruleOutcome)) {
        opts.ruleOutcome = ruleOutcome as RuleOutcomeFilter;
      }
      return c.json(await listLogs(opts));
    })
    .get("/admin/logs/files", async (c) => {
      if (!(await requireAdmin(c.req.raw, jwtSecret))) {
        return c.json({ error: "Unauthorized", code: 401 }, 401);
      }
      return c.json({ data: listLogDates() });
    })
    .post(
      "/admin/logs/search",
      jsonBody(
        t.Object({
          jsonpath: t.String(),
          from: t.Optional(t.String()),
          to: t.Optional(t.String()),
          limit: t.Optional(t.Number()),
        }),
      ),
      async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        const body = c.req.valid("json");
        if (!body.jsonpath || typeof body.jsonpath !== "string") {
          return c.json({ error: "jsonpath required", code: 422 }, 422);
        }
        const opts: { from?: string; to?: string; limit?: number } = {};
        if (body.from) opts.from = body.from;
        if (body.to) opts.to = body.to;
        if (typeof body.limit === "number" && body.limit > 0)
          opts.limit = Math.min(5000, body.limit);
        const result = await searchLogs(body.jsonpath, opts);
        return c.json({ data: result });
      },
    );
}
