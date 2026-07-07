import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Type as t } from "@sinclair/typebox";
import { jsonBody } from "./api/validator.ts";
import { upgradeWebSocket, websocket as bunWebsocket } from "hono/bun";
import type { Config } from "./config.ts";
import { getRawClient } from "./db/client.ts";
import { COGWORKS_VERSION } from "./core/version.ts";
import { securityHeaders, verifyAuthToken } from "./core/sec.ts";
import { getAllSettings } from "./api/settings.ts";
import { setLogsDir } from "./core/file-logger.ts";
import { applyCorsHeaders, handleCorsPreflight } from "./core/cors.ts";
import { setUploadDir } from "./core/storage.ts";
import { setPublicDir, servePublicFile } from "./core/static-files.ts";
import { setSandboxDir, pruneStaleSandboxes } from "./core/sql-sandbox.ts";
import { makeAuthPlugin } from "./api/auth.ts";
import { makeCollectionsPlugin } from "./api/collections.ts";
import { makeRecordsPlugin } from "./api/records.ts";
import { makeFilesPlugin, pruneFileTokenUses } from "./api/files.ts";
import { makeAdminPlugin } from "./admin/index.ts";
import { makeAuthPagesPlugin } from "./admin/auth-pages.ts";
import { makeLogsPlugin, accessLogMiddleware } from "./api/logs.ts";
import { makeAdminsPlugin } from "./api/admins.ts";
import { roleGateMiddleware } from "./api/role-gate.ts";
import { resStatus } from "./api/http-util.ts";
import { makeBackupPlugin } from "./api/backup.ts";
import { rateLimitMiddleware } from "./api/ratelimit.ts";
import { makeIndexesPlugin } from "./api/indexes.ts";
import { makeSettingsPlugin } from "./api/settings.ts";
import { makeHooksPlugin } from "./api/hooks.ts";
import { makeRoutesPlugin, tryDispatchCustom } from "./api/routes.ts";
import { makeJobsPlugin } from "./api/jobs.ts";
import { makeQueuesPlugin } from "./api/queues.ts";
import { makeBatchPlugin } from "./api/batch.ts";
import { makeCsvPlugin } from "./api/csv.ts";
import { makeMigrationsPlugin } from "./api/migrations.ts";
import { makeMetricsPlugin } from "./api/metrics.ts";
import { makeAuditLogPlugin, auditLogMiddleware } from "./api/audit-log.ts";
import { makeApiTokensPlugin } from "./api/api-tokens.ts";
import { makeMcpPlugin } from "./api/mcp.ts";
import { makeMcpAdminPlugin } from "./api/mcp-admin.ts";
import { makeRealtimeAdminPlugin } from "./api/realtime-admin.ts";
import { makeSqlPlugin } from "./api/sql.ts";
import {
  startApiTokenUsageFlusher,
  recordApiTokenUsage,
  pruneExpiredApiTokens,
} from "./core/api-tokens.ts";
import { makeSecurityPlugin } from "./api/security.ts";
import { makeThemePlugin } from "./api/theme.ts";
import { makeOpenApiPlugin } from "./api/openapi.ts";
import { makeFlagsPlugin } from "./api/flags.ts";
import { makeWebhooksPlugin } from "./api/webhooks.ts";
import { makeNotificationsPlugin } from "./api/notifications.ts";
import { startScheduler } from "./core/jobs.ts";
import { startQueueScheduler } from "./core/queues.ts";
import { startWorkflowScheduler } from "./core/workflows.ts";
import { startUpdateCheckScheduler } from "./core/update-check.ts";
import { startWebhookDispatcher } from "./core/webhooks.ts";
import { registerNotificationsWorker } from "./core/notifications.ts";
import { registerMailWorker } from "./core/mail-queue.ts";
import { RequestTimer, attachTimer, detachTimer } from "./core/perf-metrics.ts";
import { exportRequestTrace } from "./core/otel.ts";
import { log } from "./core/log.ts";
import {
  setWSAuth,
  getWSAuth,
  subscribe,
  unsubscribe,
  disconnectAll,
  listSubsFor,
  getSSEClient,
  setSSESubscriptions,
  unregisterSSEClient,
  deliverRecordLocal,
  deliverSystemLocal,
  type WSAuth,
  type RealtimeEvent,
  type BroadcastOpts,
} from "./realtime/manager.ts";
import {
  trackPresence,
  untrackPresence,
  dropConnPresence,
  presenceState,
  presenceTopic,
  startPresenceScheduler,
} from "./realtime/presence.ts";
import { startRealtimeTail, pruneRealtimeEvents } from "./realtime/cluster-bus.ts";
import { openSSEStream } from "./realtime/sse.ts";

interface ClientMessage {
  type:
    | "subscribe"
    | "unsubscribe"
    | "auth"
    | "list-subs"
    | "presence-track"
    | "presence-untrack"
    | "presence-state";
  /** Preferred field name. */
  topics?: string[];
  /** Backwards-compat alias for topics. */
  collections?: string[];
  /** When type === "auth": the bearer token to attach to this connection. */
  token?: string;
  /** When type === "subscribe": a filter expression applied to these topics (E-2). */
  filter?: string;
  /** Presence: the channel to track/observe. */
  channel?: string;
  /** Presence: client-chosen grouping key (defaults to auth id, else conn id). */
  key?: string;
  /** Presence: the client's state payload broadcast to the channel. */
  state?: unknown;
}

async function verifyTokenForWS(token: string, jwtSecret: string): Promise<WSAuth | null> {
  const ctx = await verifyAuthToken(token, jwtSecret);
  if (!ctx) return null;
  if (ctx.type !== "user" && ctx.type !== "admin") return null;
  const out: WSAuth = { id: ctx.id, type: ctx.type };
  if (ctx.email) out.email = ctx.email;
  return out;
}

/**
 * True if `origin` may open a realtime (WS/SSE) connection.
 *
 * A *present* Origin must appear in the `cors.origins` allowlist (Admin →
 * Settings → CORS, the same key the HTTP CORS layer reads; `*` permits any).
 * Browsers always send Origin, so this blocks cross-site browser connections.
 *
 * A *missing* Origin is allowed: non-browser clients (server-side SDK, native
 * / mobile apps, CLIs) don't send one, and they can't mount a cross-site
 * hijack anyway — realtime auth is an explicit `{type:"auth", token}` bearer
 * message, never an ambient cookie, so there's no session for a foreign page
 * to ride. Requiring Origin only broke every legitimate non-browser client.
 */
export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true;
  const settings = getAllSettings();
  const raw = settings["cors.origins"] ?? "";
  if (!raw) return false;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(origin) || list.includes("*");
}

/**
 * Prune `cogworks_file_token_uses` rows older than 24h once per hour. Runs
 * once at boot (delayed) so a long-running process never accumulates more
 * than ~1 day of replay-guard state, which is itself capped by the file-token
 * window (default 1h) — so the table can't grow without bound.
 */
function startFileTokenUsesPrune(): void {
  const HOUR_MS = 60 * 60 * 1000;
  setTimeout(() => {
    void pruneFileTokenUses();
  }, 60 * 1000).unref?.();
  setInterval(() => {
    void pruneFileTokenUses();
  }, HOUR_MS).unref?.();
}

/**
 * API-token usage telemetry. Runs after the handler so it never adds latency.
 * Records last_used_at + IP + UA for any request bearing a `cwat_`- (or legacy `vbat_`-) prefixed
 * token. Pure observability — failures never block a request. (Was an Elysia
 * global `onAfterHandle`; now called from the Hono root `core` middleware.)
 */
function recordApiTokenTelemetry(request: Request): void {
  const auth = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(?:cwat_|vbat_)([A-Za-z0-9._-]+)/i.exec(auth);
  if (!m) return;
  // Decode the JWT payload (no signature verify — that already happened on the
  // request path; we only need the jti for keying).
  const jwt = m[1] ?? "";
  const mid = jwt.split(".")[1] ?? "";
  let jti = "";
  try {
    const padded = mid
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(mid.length / 4) * 4, "=");
    const json = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))),
    ) as Record<string, unknown>;
    if (typeof json.jti === "string") jti = json.jti;
  } catch {
    /* malformed — skip */
  }
  if (!jti) return;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = request.headers.get("user-agent");
  recordApiTokenUsage(jti, ip, ua);
}

export function createServer(config: Config) {
  setLogsDir(config.logsDir);
  setUploadDir(config.uploadDir);
  setPublicDir(config.publicDir, config.publicSpa);
  setSandboxDir(`${config.dataDir}/sandboxes`);
  // Built-in `_notify` queue worker — must register BEFORE startQueueScheduler
  // so the first scheduler tick finds it. Idempotent on re-call (cluster
  // workers each call createServer).
  registerNotificationsWorker();
  registerMailWorker();

  // ── Per-worker background loops (safe / required in every cluster worker) ──
  // The queue scheduler competes for jobs via an atomic claim (claimAndRun), so
  // running it everywhere just adds throughput. The API-token usage flusher
  // drains a PER-WORKER in-memory buffer, so it must run in every worker.
  startQueueScheduler();
  startWorkflowScheduler();
  startApiTokenUsageFlusher();
  // Realtime presence: clears this worker's stale rows on boot, then heartbeats
  // its live connections + reaps a crashed worker's leftovers past the TTL.
  startPresenceScheduler();
  // Cross-worker realtime bus: every worker tails the shared event table so a
  // record written on a sibling worker reaches this worker's WS/SSE subscribers.
  // No-op in single-process mode (self-gated on COGWORKS_WORKER_ID).
  startRealtimeTail({
    onRecord: (collection, event, opts, seq) =>
      deliverRecordLocal(
        collection,
        event as RealtimeEvent,
        opts as BroadcastOpts | undefined,
        seq,
      ),
    onSystem: (topic, message, seq) => deliverSystemLocal(topic, message as object, seq),
  });
  // Sweep idle SQL sandboxes hourly. `_sandboxes` is a PER-WORKER in-memory map
  // of open bun:sqlite handles, so every worker must prune its own or it leaks
  // connections (not a shared-DB op — must NOT be leader-gated).
  setInterval(
    () => {
      try {
        pruneStaleSandboxes();
      } catch {
        /* swallow */
      }
    },
    60 * 60 * 1000,
  ).unref?.();

  // ── Singleton background loops (leader only) ──────────────────────────────
  // Cluster mode spawns N worker processes with no IPC; they coordinate only
  // through the shared DB. These loops have NO atomic claim, so running them in
  // every worker fires them N times (N× cron runs, N× webhook deliveries, N×
  // prunes/update-checks). Gate them to a single leader — worker 0 under cluster,
  // and always-true for the single-process deployment (no COGWORKS_WORKER_ID).
  const workerId = process.env.COGWORKS_WORKER_ID;
  const isSchedulerLeader = !workerId || workerId === "0";
  if (isSchedulerLeader) {
    startScheduler();
    startUpdateCheckScheduler();
    startWebhookDispatcher();
    startFileTokenUsesPrune();
    // Prune the realtime event log (now also the SSE resume buffer, so this runs
    // single-process too). `realtime.retention_sec` (default 30) bounds both the
    // table size AND how far back a reconnecting client can resume; it
    // comfortably exceeds the cluster tail poll interval so no worker misses an
    // event it hasn't yet read.
    setInterval(() => {
      const n = parseInt(getAllSettings()["realtime.retention_sec"] ?? "30", 10);
      pruneRealtimeEvents(Number.isFinite(n) && n > 0 ? n : 30);
    }, 30_000).unref?.();
    // Prune expired/long-revoked API token rows once a day.
    setTimeout(
      () => {
        void pruneExpiredApiTokens();
      },
      5 * 60 * 1000,
    ).unref?.();
    setInterval(
      () => {
        void pruneExpiredApiTokens();
      },
      24 * 60 * 60 * 1000,
    ).unref?.();
  }
  // Every route (records, auth, files, admin SPA, auth pages, realtime, health,
  // …) is now native Hono — Elysia has been fully removed. Cross-cutting
  // concerns that used to be Elysia global hooks (perf timer, CORS, custom
  // routes, rate limit, security headers, access log, audit log, API-token
  // telemetry) run on the Hono root `app` (see `coreMiddleware` + the
  // `app.use(...)` chain below).
  //
  // ponytail: the `/openapi` docs endpoint (was `@elysiajs/openapi`) was dropped
  // with Elysia — it auto-generated from Elysia routes and would document zero
  // now. Re-add native OpenAPI (e.g. hono-openapi) deliberately if/when routes
  // carry response schemas worth publishing.

  // ── Hono root ──────────────────────────────────────────────────────────
  // Hono owns Bun.serve + the WebSocket and serves every route natively.
  const app = new Hono();

  // ── Root cross-cutting pipeline ────────────────────────────────────────
  // These `app.use` middlewares wrap EVERYTHING below — the native `api`
  // sub-app and the WS route — so every request gets the same lifecycle. This
  // replaces the old Elysia global hooks. Registration order = onion order:
  // `core` (outermost) → access log → audit → rate limit (innermost).
  app.use("*", async (c, next) => {
    const request = c.req.raw;
    // Phase 0: per-request timer, WeakMap-keyed by Request so any handler /
    // records-core call site can record steps via `timeFor`.
    attachTimer(request, new RequestTimer());
    // CORS preflight short-circuit — before any normal route.
    const pre = handleCorsPreflight(request);
    if (pre) {
      detachTimer(request)?.finish();
      return pre;
    }
    // Custom user routes fire before built-in route resolution so they can't
    // collide with /api/:collection or any other built-in pattern.
    const custom = await tryDispatchCustom(request, config.jwtSecret);
    if (custom) {
      detachTimer(request)?.finish();
      return custom;
    }

    await next();

    // A WebSocket upgrade (101) response must be returned untouched.
    const status = resStatus(c);
    if (status !== 101) {
      const isApi = new URL(request.url).pathname.startsWith("/api/");
      for (const [k, v] of Object.entries(securityHeaders({ isApi }))) {
        if (!c.res.headers.has(k)) c.res.headers.set(k, v);
      }
      // CORS response headers on every request — same envelope as security.
      // Seed the shim with any `Vary` the handler already set so
      // `applyCorsHeaders` merges (rather than clobbers) it.
      const corsSet = {
        headers: { Vary: c.res.headers.get("Vary") ?? undefined } as Record<
          string,
          string | undefined
        >,
      };
      applyCorsHeaders(request, corsSet);
      for (const [k, v] of Object.entries(corsSet.headers)) {
        if (v !== undefined) c.res.headers.set(k, v);
      }
      recordApiTokenTelemetry(request);
    }
    const timer = detachTimer(request);
    if (timer) {
      timer.finish();
      if (status !== 101) {
        const route = c.req.routePath ?? new URL(request.url).pathname;
        exportRequestTrace(timer, { method: c.req.method, route, status });
      }
    }
  });
  // Access + audit logging are registered OUTER to the rate limiter so their
  // `finally` blocks still run when `rateLimitMiddleware` short-circuits a 429
  // without calling next() — otherwise blocked requests (exactly the traffic an
  // operator wants to see during abuse) would vanish from /admin/logs + audit.
  app.use("*", accessLogMiddleware(config.jwtSecret));
  app.use("*", auditLogMiddleware(config.jwtSecret));
  app.use("*", rateLimitMiddleware());
  app.onError((error, c) => {
    const request = c.req.raw;
    const timer = detachTimer(request);
    timer?.finish();
    const errStatus = error instanceof HTTPException ? error.status : 500;
    if (timer) {
      const route = c.req.routePath ?? new URL(request.url).pathname;
      exportRequestTrace(timer, { method: request.method, route, status: errStatus });
    }
    // Client errors raised as HTTPException — notably the body validator's 400
    // on malformed JSON — render at their real status and are NOT error-logged
    // (mirrors the old Elysia onError skipping NOT_FOUND/VALIDATION/PARSE).
    // Without this, every jsonBody route answers malformed JSON with a 500.
    if (error instanceof HTTPException) {
      return c.json({ error: error.message, code: error.status }, error.status);
    }
    log.error("request error", {
      method: request.method,
      path: new URL(request.url).pathname,
      err: error,
    });
    return c.json({ error: "Internal Server Error", code: 500 }, 500);
  });

  // Static-site fallback (opt-in COGWORKS_PUBLIC_DIR): a GET/HEAD that matched
  // no route is served from the public dir. Reserved prefixes keep their JSON
  // 404s — we never hijack an unmatched API/admin/auth/realtime path.
  app.notFound((c) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD") {
      const path = new URL(c.req.url).pathname;
      const reserved =
        path.startsWith("/api") ||
        path.startsWith("/_/") ||
        path.startsWith("/auth/") ||
        path === "/realtime";
      if (!reserved) {
        const res = servePublicFile(path);
        if (res) return res;
      }
    }
    return c.json({ error: "Not found", code: 404 }, 404);
  });

  // Every route below is native Hono (no Elysia mount remains). Matched in
  // static-over-dynamic priority within this one router — see the records note.
  const api = new Hono();
  // F-9 control-plane RBAC: enforce admin operator-role tiers before any route
  // handler. No-ops for non-gated paths (records, auth, files, observability).
  api.use("*", roleGateMiddleware(config.jwtSecret));
  api.route("/api/v1", makeOpenApiPlugin());
  api.route("/api/v1", makeThemePlugin());
  api.route("/api/v1", makeMetricsPlugin(config.jwtSecret));
  api.route("/api/v1", makeBackupPlugin(config.jwtSecret, config.dbPath));
  api.route("/api/v1", makeSecurityPlugin(config.jwtSecret, config.encryptionKey));
  api.route("/api/v1", makeMcpAdminPlugin(config.jwtSecret));
  api.route("/api/v1", makeRealtimeAdminPlugin(config.jwtSecret));
  api.route("/api/v1", makeIndexesPlugin(config.jwtSecret));
  api.route("/api/v1", makeCsvPlugin(config.jwtSecret));
  api.route("/api/v1", makeMcpPlugin(config.jwtSecret));
  api.route("/api/v1", makeMigrationsPlugin(config.jwtSecret));
  api.route("/api/v1", makeJobsPlugin(config.jwtSecret));
  api.route("/api/v1", makeAdminsPlugin(config.jwtSecret));
  api.route("/api/v1", makeSettingsPlugin(config.jwtSecret));
  api.route("/api/v1", makeHooksPlugin(config.jwtSecret));
  api.route("/api/v1", makeRoutesPlugin(config.jwtSecret));
  api.route("/api/v1", makeBatchPlugin(config.jwtSecret));
  api.route("/api/v1", makeWebhooksPlugin(config.jwtSecret));
  api.route("/api/v1", makeApiTokensPlugin(config.jwtSecret));
  api.route("/api/v1", makeQueuesPlugin(config.jwtSecret));
  api.route("/api/v1", makeCollectionsPlugin(config.jwtSecret));
  api.route("/api/v1", makeFlagsPlugin(config.jwtSecret));
  api.route("/api/v1", makeNotificationsPlugin(config.jwtSecret));
  api.route("/api/v1", makeSqlPlugin(config.jwtSecret, config.dbPath));
  api.route("/api/v1", makeFilesPlugin(config.uploadDir, config.jwtSecret));
  api.route("/api/v1", makeAuthPlugin(config.jwtSecret));
  api.route("/api/v1", makeLogsPlugin(config.jwtSecret));
  api.route("/api/v1", makeAuditLogPlugin(config.jwtSecret));
  // ── Health + realtime SSE (native Hono) ────────────────────────────────
  // Registered on `api` (same router as records) BEFORE records so Hono's
  // static-over-dynamic priority makes these win over records' `/:collection`
  // catch-all. (Registering them on the root `app` instead fails: `app.route`
  // creates a separate router boundary and records shadows them.)
  api.get("/api/health", (c) => c.json({ data: { status: "ok", version: COGWORKS_VERSION } }));
  // Cluster health probe — admin proxies / load-balancers hit this. Worker id
  // (if running under cluster mode) helps debug which worker answered.
  api.get("/_/health", (c) =>
    c.json({
      data: {
        status: "ok",
        worker_id: process.env.COGWORKS_WORKER_ID ?? null,
        pid: process.pid,
        uptime_s: Math.floor(process.uptime()),
      },
    }),
  );
  // Readiness probe — distinct from liveness (`/_/health`). Ready = the DB is
  // reachable AND migrations have stamped `cogworks_schema`. Lets a k8s / LB
  // readiness gate hold traffic off a pod whose DB isn't migrated/available yet
  // (e.g. mid rolling deploy), while liveness stays green so it isn't killed.
  // 503 (not 500) on failure so probes read it as "not ready", not "crashed".
  api.get("/_/ready", (c) => {
    try {
      const row = getRawClient()
        .query("SELECT version FROM cogworks_schema WHERE id = 1")
        .get() as { version: string } | null;
      if (!row) {
        return c.json({ data: { ready: false, reason: "migrations not applied" } }, 503);
      }
      return c.json({
        data: {
          ready: true,
          schema_version: row.version,
          readonly:
            process.env.COGWORKS_READONLY === "1" || process.env.COGWORKS_READONLY === "true",
          worker_id: process.env.COGWORKS_WORKER_ID ?? null,
          uptime_s: Math.floor(process.uptime()),
        },
      });
    } catch (e) {
      // DB not initialized / connection gone → not ready.
      return c.json({ data: { ready: false, reason: (e as Error).message } }, 503);
    }
  });
  // Presence snapshot (read-only) — a full `key → [meta]` map for a channel.
  // Handy for SSE observers (which can't track over the one-way stream) and for
  // any client that wants the current roster over plain HTTP.
  api.get("/api/v1/realtime/presence/:channel", (c) => {
    const origin = c.req.header("origin") ?? null;
    if (!isOriginAllowed(origin)) {
      return c.json({ error: "Origin not allowed", code: 403 }, 403);
    }
    return c.json({ data: presenceState(c.req.param("channel")) });
  });
  // SSE fallback for clients that can't open WebSockets. Pairs with
  // `POST /api/v1/realtime` for setting subscriptions.
  api.get("/api/v1/realtime", (c) => {
    const origin = c.req.header("origin") ?? null;
    // Present Origin must be allowlisted (blocks cross-site browsers); absent
    // Origin (non-browser EventSource clients) is allowed.
    if (!isOriginAllowed(origin)) {
      return c.json({ error: "Origin not allowed", code: 403 }, 403);
    }
    // Browsers auto-send Last-Event-ID on EventSource reconnect; a `?lastEventId=`
    // query param covers non-browser clients. Present → replay missed events.
    const rawLei = c.req.header("last-event-id") ?? c.req.query("lastEventId");
    const lei = rawLei !== undefined ? parseInt(rawLei, 10) : Number.NaN;
    const { response } = openSSEStream(Number.isFinite(lei) && lei >= 0 ? lei : undefined);
    response.headers.set("content-type", "text/event-stream; charset=utf-8");
    return response;
  });
  api.post(
    "/api/v1/realtime",
    jsonBody(
      t.Object({
        clientId: t.String(),
        topics: t.Optional(t.Array(t.String())),
        subscriptions: t.Optional(t.Array(t.String())), // PB-compat alias
        collections: t.Optional(t.Array(t.String())), // legacy alias
        token: t.Optional(t.String()),
        filter: t.Optional(t.String()), // E-2: subscription filter expression
      }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      const adapter = getSSEClient(body.clientId);
      if (!adapter) {
        return c.json(
          { error: "Unknown clientId — open GET /api/v1/realtime first", code: 404 },
          404,
        );
      }
      // Optional fresh auth (parallel to WS `{type:"auth"}`).
      if (body.token) {
        const auth = await verifyTokenForWS(body.token, config.jwtSecret);
        setWSAuth(adapter, auth);
      }
      const topics = body.topics ?? body.subscriptions ?? body.collections ?? [];
      setSSESubscriptions(body.clientId, topics, body.filter);
      return c.json({ data: { clientId: body.clientId, topics } });
    },
  );
  api.delete("/api/v1/realtime/:clientId", (c) => {
    unregisterSSEClient(c.req.param("clientId"));
    return c.json({ data: null });
  });
  // Admin SPA (`/_/*`) + auth HTML pages (`/auth/reset|verify|otp`) — the
  // non-`/api` surface. Static `/_/health` above out-prioritises `/_/*`.
  api.route("/", makeAdminPlugin());
  api.route("/", makeAuthPagesPlugin());
  // Records LAST: its greedy `/:collection` + `/:collection/:id` catch-alls
  // must not shadow any static route. Hono prioritises static routes over
  // params, so the sibling plugins/routes above win.
  api.route("/api/v1", makeRecordsPlugin(config.jwtSecret));
  app.route("/", api);

  // The realtime manager keys subscriptions by `ws.data.connId` on a `WSLike
  // {send}`. Hono hands a fresh WSContext per event, so we key a stable adapter
  // off the underlying Bun socket (`ws.raw`) and pass THAT to the manager.
  const wsAdapters = new WeakMap<object, { send: (d: string) => void; data: { connId: string } }>();
  const rawKey = (ws: { raw?: unknown }): object => (ws.raw ?? ws) as object;

  app.get(
    "/realtime",
    upgradeWebSocket((c) => {
      // Browsers always send Origin on WS upgrades; absent Origin = non-browser
      // client (allowed — they auth by bearer token, can't do cross-site hijack).
      const origin = c.req.header("origin") ?? null;
      return {
        onOpen(_evt, ws) {
          const adapter = {
            send: (d: string) => ws.send(d),
            data: { connId: crypto.randomUUID() },
          };
          wsAdapters.set(rawKey(ws), adapter);
          if (!isOriginAllowed(origin)) {
            ws.send(JSON.stringify({ type: "error", reason: "origin_not_allowed" }));
            ws.close();
            return;
          }
          ws.send(JSON.stringify({ type: "connected" }));
        },
        async onMessage(evt, ws) {
          const adapter = wsAdapters.get(rawKey(ws));
          if (!adapter) return;
          let msg: ClientMessage;
          try {
            const data = typeof evt.data === "string" ? evt.data : "";
            msg = JSON.parse(data) as ClientMessage;
          } catch {
            return;
          }
          // Auth ad-hoc — lets clients refresh credentials over an open connection.
          if (msg.type === "auth") {
            if (typeof msg.token !== "string") return;
            const auth = await verifyTokenForWS(msg.token, config.jwtSecret);
            setWSAuth(adapter, auth);
            return;
          }
          if (msg.type === "list-subs") {
            ws.send(JSON.stringify({ type: "subs", topics: listSubsFor(adapter) }));
            return;
          }
          // ── Presence (Supabase-style ephemeral "who's here") ──
          if (
            msg.type === "presence-track" ||
            msg.type === "presence-untrack" ||
            msg.type === "presence-state"
          ) {
            if (typeof msg.channel !== "string" || !msg.channel) {
              ws.send(JSON.stringify({ type: "error", code: "invalid_channel" }));
              return;
            }
            const connId = adapter.data.connId;
            if (msg.type === "presence-untrack") {
              untrackPresence(connId, msg.channel);
              return;
            }
            // track + state both make this connection an observer of the channel.
            subscribe(adapter, [presenceTopic(msg.channel)]);
            if (msg.type === "presence-track") {
              const auth = getWSAuth(adapter);
              const identity = auth ? { id: auth.id, type: auth.type } : null;
              // Grouping key: client's choice, else the (trustworthy) auth id, else conn id.
              const key = typeof msg.key === "string" && msg.key ? msg.key : (auth?.id ?? connId);
              const r = trackPresence(connId, msg.channel, key, msg.state ?? {}, identity);
              if (r === null) {
                ws.send(JSON.stringify({ type: "error", code: "invalid_presence" }));
                return;
              }
            }
            ws.send(
              JSON.stringify({
                type: "presence-state",
                channel: msg.channel,
                state: presenceState(msg.channel),
              }),
            );
            return;
          }
          const topics = msg.topics ?? msg.collections;
          if (!Array.isArray(topics)) {
            ws.send(
              JSON.stringify({
                type: "error",
                code: "invalid_topics",
                message: "topics must be a string array",
              }),
            );
            return;
          }
          if (msg.type === "subscribe") {
            const accepted = subscribe(adapter, topics, msg.filter);
            ws.send(JSON.stringify({ type: "subscribed", topics: accepted }));
          } else if (msg.type === "unsubscribe") {
            const removed = unsubscribe(adapter, topics);
            ws.send(JSON.stringify({ type: "unsubscribed", topics: removed }));
          }
        },
        onClose(_evt, ws) {
          const adapter = wsAdapters.get(rawKey(ws));
          if (adapter) {
            dropConnPresence(adapter.data.connId); // emit `leave` on every channel
            disconnectAll(adapter);
            wsAdapters.delete(rawKey(ws));
          }
        },
      };
    }),
  );

  return { fetch: app.fetch, websocket: bunWebsocket };
}
