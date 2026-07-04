# Cogworks Architecture

A single self-contained binary: **Bun** runtime, **Hono** HTTP, **SQLite**
(`bun:sqlite`, WAL) for all state, and a React admin SPA embedded at build time.
No external services are required to run it.

## Process shape

```
            ┌──────────────────────── one Bun process ────────────────────────┐
  client ──►│  Hono app  →  root middleware pipeline  →  route plugins         │
            │                                              │                    │
            │   background loops: queue scheduler · workflow scheduler ·        │
            │   cron scheduler · api-token usage flush · realtime tail          │
            │                                              │                    │
            │                         bun:sqlite (WAL) — the single source of truth
            └──────────────────────────────────────────────────────────────────┘
```

`cogworks cluster` runs N of these processes behind `SO_REUSEPORT`, all sharing
one WAL database (see `src/cluster.ts`). TLS/compression are a reverse proxy's
job (see the deployment docs) — the binary speaks plain HTTP.

## Request pipeline (`src/server.ts`)

Middlewares are registered outermost-first (onion order); a request passes down
through them, hits a route, and unwinds back up:

1. **core** — per-request timer (`perf-metrics`), CORS preflight short-circuit,
   custom-route dispatch (`tryDispatchCustom`), then security + CORS response
   headers + OTel trace export on the way out.
2. **access log** — one JSONL row per request (`api/logs.ts`).
3. **audit log** — state-changing admin calls (`api/audit-log.ts`).
4. **rate limit** — per-IP / per-token token bucket (`api/ratelimit.ts`).
5. **role gate** — control-plane RBAC (`api/role-gate.ts`, F-9): maps
   `(method, path)` → required admin role.
6. **route plugins** — one Hono sub-app per feature, mounted at `/api/v1`.
   The **records** plugin (`/:collection`) mounts LAST so explicit routes win
   over the dynamic collection catch-all.

Access + audit are registered *outside* the rate limiter so a 429 still produces
log + audit rows.

## Data model

- **Collections** are real SQL tables: base/auth → `cw_<name>`; internal tables
  are `cogworks_*`. Field defs live as JSON in `cogworks_collections.fields`
  (`core/collections.ts`), parsed per request.
- **Records** CRUD, filtering, sorting, expand (forward + reverse), keyset +
  offset pagination, FTS5 search, vector search — `core/records.ts`.
- **Rules** — a per-collection expression DSL (`list/view/create/update/delete`)
  that both compiles to SQL (`core/filter.ts`) for row filtering and evaluates
  in-memory (`core/rules.ts`). Admins bypass rules. Same DSL powers `filter=`.
- **Migrations** — hand-written idempotent DDL in `src/db/migrate.ts`
  (`CREATE TABLE IF NOT EXISTS` + guarded `addColumn`); Drizzle table defs in
  `src/db/schema.ts` are the typed mirror. No drizzle-kit.

## Key subsystems

| Area | Module(s) |
|------|-----------|
| Auth (password/TOTP/WebAuthn/OAuth2/OTP/anon/API-tokens/admin) | `api/auth*.ts`, `core/sec.ts`, `core/api-tokens.ts` |
| Admin operator roles (RBAC) | `core/admin-roles.ts`, `api/role-gate.ts` |
| Realtime (WS + SSE, resume, cross-worker) | `realtime/manager.ts`, `realtime/cluster-bus.ts` (SQLite pub/sub + event log) |
| Queues (retry, backoff, dead-letter, reaper) | `core/queues.ts` |
| Durable workflows (memoized steps) | `core/workflows.ts` |
| Server-side code (hooks/routes/cron/workers) | `core/hooks.ts`, `core/routes.ts`, `core/jobs.ts`, `core/queues.ts` — all `AsyncFunction(ctx)` in-process |
| Email (SMTP + HTTP drivers, durable) | `core/email.ts`, `core/mail-queue.ts` |
| Files (local + S3/R2) | `api/files.ts`, `core/storage.ts` |
| Encryption (AES-GCM, key rotation) | `core/encryption.ts`, `core/key-rotation.ts` |
| MCP server (AI agents) | `src/mcp/*` |
| Observability | `core/perf-metrics.ts` (metrics + OTel), `core/log.ts`, `api/audit-log.ts` |
| API surface generation | `core/openapi.ts` (F-2), `core/sdk-types.ts` (F-3) |

## Trust model

Hook/route/job authoring is **host-RCE-equivalent** (code runs in-process with
full JS globals reachable). It is gated behind the `owner`/`developer` admin
roles; the SSRF egress guard and execution timeout are guardrails against
*accidental* mistakes in trusted code, not a sandbox. See `SECURITY.md`.

## Where to look first

`src/server.ts` (the wiring) → `src/db/schema.ts` (the data) →
`src/core/records.ts` + `src/core/rules.ts` (the request hot path). The roadmap
(`ROADMAP.md`) tracks what's shipped vs. planned.
