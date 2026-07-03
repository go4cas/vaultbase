# Vaultbase (fork) — Server Roadmap

Status audit + prioritized improvement roadmap for the **server** (vaultbase repo), generated from a review of the post-Hono-migration codebase. `sdk` and `mcp` to follow once the server is done.

Legend — **Confidence**: ✅ verified in code · ⚠️ review-flagged, needs verify before fix. **Effort**: S (<½ day) · M (1–2 days) · L (multi-day). Most items marked *(pre-existing)* were inherited from upstream `vaultbase-sh`, not introduced by the Hono migration — candidates to also contribute upstream.

---

## P0 — Bugs & security (do before any features)

The enhancement review surfaced several items that are actually **correctness/security bugs**. These should be fixed first.

| # | Sev | Item | Evidence | Confidence | Effort |
|---|-----|------|----------|-----------|--------|
| P0-1 | 🔴 Sec | **Collections admin gate skips token revocation.** `isAdmin` uses raw `jose.jwtVerify` instead of the centralized `verifyAuthToken`, so a revoked/logged-out admin token still passes create/patch-schema/import/**delete-collection**. | `src/api/collections.ts:23` vs `src/core/sec.ts` `verifyAuthToken` (does `isRevoked(jti)`) | ✅ | S |
| P0-2 | 🔴 Sec | **7 auth endpoints bypass jti-revocation + `password_reset_at`.** TOTP setup/confirm/disable, recovery regen/status, request-verify, promote decode the bearer with raw `jwtVerify`. A logged-out or reset-invalidated token can still enable/disable MFA or promote the account. | `src/api/auth.ts:734,767,815,1131,1180,1226,1335` | ⚠️ (lines from review) | M |
| P0-3 | 🔴 Sec | **Password reset does not revoke existing sessions.** `confirm-password-reset` writes only `password_hash`/`updated_at` — never bumps `password_reset_at`, so every pre-reset JWT stays valid. The revocation mechanism exists (`sec.ts` checks `password_reset_at > iat`); the reset path just doesn't trip it. | `src/api/auth.ts:942` (cf. setup at `:310` which *does* set it) | ✅ | S |
| P0-4 | 🟠 Correctness | **Realtime broadcast is not cross-worker.** `subs` is a process-local `Map`; `cluster.ts` spawns N workers via `reusePort`. A write on worker A never reaches a WS/SSE client on worker B → realtime delivery ≈ 1/N in cluster mode. | `src/realtime/manager.ts:58,188` + `src/cluster.ts:43,81` | ✅ | L |
| P0-5 | 🟠 Correctness | **Cron/scheduler runs in every worker with no atomic claim → N× duplicate runs.** `startScheduler()` runs in each worker; inline cron `runJob` has no `UPDATE…WHERE next_run_at<=now RETURNING` claim (queue jobs *do* claim). Also affects webhook dispatcher + prune loops. | `src/core/jobs.ts:195-211` (cf. `queues.ts:271` claim) | ⚠️ | M |
| P0-6 | 🟠 Security | **Rate limiter state is per-process → cluster multiplies every limit ×N.** In-memory token buckets per worker; "10/3s" becomes "10×N/3s", weakening brute-force protection as you scale. | `src/api/ratelimit.ts:58` | ✅ | M |
| P0-7 | 🟠 DoS | **Image decode has no source-dimension cap (decompression-bomb OOM).** `MAX_DIM` bounds only the requested thumb; `Image.decode()` runs on the full untrusted source first — a crafted 20000×20000 image allocates ~1.6 GB and OOM-kills the worker. `SECURITY.md:98` already flags this. | `src/core/image.ts:262` | ⚠️ | S–M |
| P0-8 | 🟡 Correctness | **Weak ETag same-second lost-update window.** ETag derives from `updated_at` in whole seconds; two PATCHes within one second get identical tags, so `If-Match` optimistic concurrency has a 1s blind spot. | `src/api/records.ts:37-44,575` | ✅ | S (add `version` col) |

---

## Category 1 — Technical improvements (no feature change)

### Already done (verified) ✅
| Item | Evidence |
|------|----------|
| Biome lint + format enforced in CI | `biome.json`, `.github/workflows/ci.yml` runs `lint` + `typecheck` |
| Structured JSON logging (not ad-hoc console) | `src/core/log.ts`; remaining `console.*` are legit CLI/boot output only |
| GIF/image test flakiness resolved | `image-formats.test.ts` uses `it.skipIf(!gifEncoderAvailable)` |
| No phantom deps | all imports map to `package.json` (fixed `@sinclair/typebox` this session) |

### Outstanding
| # | Item | Evidence | Effort |
|---|------|----------|--------|
| T-1 | **Consolidate ~20 copy-pasted admin-auth helpers** into one `requireAdmin`/`getAdmin` in `core/sec.ts`. The duplication isn't cosmetic — it *caused* P0-1's revocation gap. | 20 files: `routes.ts:12`, `sql.ts:44`, `collections.ts:23`, … | M |
| T-2 | **Test the root middleware pipeline.** No test asserts the load-bearing invariant that a 429 still produces access-log + audit rows, or that security/CORS headers land. Only `server-error-handling.test.ts` drives the assembled `createServer`. | `server.ts:273-279` | M |
| T-3 | **Re-add API docs** (dropped with Elysia) — see F-2 (generate from collection defs, not routes). | `server.ts:209` ponytail note | M |
| T-4 | **Purge stale "Elysia" comments;** one is actively wrong (`routes.ts:28` "Wired into the main Elysia app's onRequest hook" — now `tryDispatchCustom` in Hono root). | `routes.ts:28` + ~10 cleanup-only | S |
| T-5 | **Author `ARCHITECTURE.md` + `CONTRIBUTING.md`.** The `server.ts` middleware/plugin block is effectively the arch doc already — lift it out. | — | S |
| T-6 | **Split `auth.ts` (1470 lines)** into cohesive sub-plugins (setup / user-auth / MFA-recovery / impersonation) along existing route-group seams. Mechanical, no behavior change. | `src/api/auth.ts:268` | M |
| T-7 | **Co-locate DB indexes with schema** (all ~25 indexes live as raw SQL in `migrate.ts`, zero in `schema.ts`) — maintainability, not a missing-index bug. | `src/db/schema.ts`, `migrate.ts` | S |
| T-8 | **Factor `try { c.res.status } catch {}`** (3 sites) into a `resStatus(c)` helper — bundle with T-1. | `server.ts:246`, `logs.ts:183`, `audit-log.ts:34` | S |

---

## Category 2 — Enhancements to existing features (non-bug)

| # | Item | Current limitation | Effort |
|---|------|--------------------|--------|
| E-1 | **Keyset/cursor pagination** for the hot list path | OFFSET pagination + unconditional `COUNT(*)` per list → deep pages are O(offset) (`records.ts:367,377`) | M |
| E-2 | **Realtime subscription filters** (`posts?filter=status='published'`) | `normalizeTopic` only supports collection/id/event/`*`; clients over-subscribe (`manager.ts:98`) | M |
| E-3 | **SSE/WS resume** (emit `id:`, replay from `Last-Event-ID`) | no event id, no replay on reconnect → gaps lost (`realtime/sse.ts:16`) | M |
| E-4 | **S3 presigned URLs / public redirects for downloads** | S3 files are proxied through the server (full object into RAM); `publicUrlFor` is dead code (`storage.ts:203,221`) | M |
| E-5 | **Stream uploads to storage** instead of `await file.arrayBuffer()` buffering whole file in RAM | `files.ts:413` | S (+M for resumable) |
| E-6 | **Hook/job execution timeout** (`Promise.race` budget) | user code runs with no timeout; a hung before-hook blocks the request/event loop (`hooks.ts:156`) | M |
| E-7 | **Consistent backup snapshot** (`VACUUM INTO` / WAL checkpoint) | HTTP backup streams the live DB file — may miss un-checkpointed WAL commits or read torn (`backup.ts:20`) | S |
| E-8 | **Durable after-hooks + transactional emails** (route through the queue for at-least-once) | after-hooks + verify/reset emails are fire-and-forget; a crash/SMTP blip drops them (`hooks.ts:228`, `auth.ts:198`) | S–M |
| E-9 | **Reverse-relation expand** (`comments_via_post`) | `expandRelations` only follows forward relations (`records.ts:829`) | M |
| E-10 | **`sqlite-vec` ANN index** for vector search (see F-5 — an enhancement of the existing vector feature) | in-process cosine scan, silent 10K cap, per-query re-parse (`records.ts:197`, `vector.ts:60`) | L |

---

## Category 3 — Net-new features

**Already shipped (verified — do NOT rebuild):** row-level realtime auth, S3/R2/B2 file storage, CSV import+export, email templates, per-collection webhooks, record history + audit log, deferred/scheduled queue jobs, field-level encryption, TOTP/MFA/OTP/OAuth2/impersonation, MCP server, feature flags, notifications, SQL sandbox, metrics.

| # | Feature | Why / fit | Effort |
|---|---------|-----------|--------|
| F-1 | **Full-text search (SQLite FTS5)** — biggest capability gap; today only `LIKE` via `~`. Opt-in `searchable` field flag → contentless FTS5 table synced on write; `search=` param in `core/filter.ts`. Zero new deps. | `filter.ts:192` | M |
| F-2 | **OpenAPI spec + embedded docs** (`/api/docs`) — generate from **collection defs** (field types → JSON Schema), not routes. New `api/openapi.ts`. Shares its generator core with F-3. | — | M |
| F-3 | **Typed client-SDK generator** (`/api/v1/sdk/types.ts` or `vaultbase gen-sdk`) — field defs → TS interfaces + thin typed client. Highest DX leverage; pairs with F-2. | beside `csv.ts` | M |
| F-4 | **WebAuthn / passkeys** — table stakes for modern auth; TOTP exists but no passkeys. New `webauthn_credentials` table; ceremonies beside TOTP; `@simplewebauthn/server` (1 dep). | `api/auth.ts` | M–L |
| F-5 | **`sqlite-vec` ANN vector index** (also E-10) — drop-in for the existing swappable `VectorSearchInput` seam; removes 10K ceiling. | `records.ts:135`, `vector.ts` | M |
| F-6 | **OpenTelemetry/OTLP trace export** — the per-request span tree is *already built* by `RequestTimer`/`timeFor`; just export it from the root `finish()` path, gated by `otel.endpoint`. | `core/perf-metrics.ts`, `server.ts:271` | M |
| F-7 | **Readiness endpoint** `/_/ready` (DB writable + migrations done) distinct from liveness `/_/health` — for k8s/LB gating during migrations. | beside health routes `server.ts:332` | S |
| F-8 | **One-off "run at" job scheduling in admin UI** — the `scheduled_at`/`enqueue({delay})` primitive exists; just expose a one-off from the admin (mostly UI). | `api/jobs.ts`, `queues.ts:172` | S–M |

**Considered & recommend skip (YAGNI):** GraphQL layer (REST+filter/expand covers it), DB branching (SQL sandbox already gives scratch copies), multi-tenancy/orgs (large blast radius; the rule engine covers single-tenant — revisit only if targeting multi-tenant SaaS).

---

## Recommended build order

1. **P0 security cluster** — P0-1, P0-3 (both S, verified), then P0-2 (M). Do these first; they're small and real. Fold in **T-1** (shared admin-auth helper) since it's the root cause of P0-1/P0-2.
2. **P0 cluster-mode correctness** — P0-4 (realtime bus) + P0-5 (cron claim) + P0-6 (shared rate-limit) together; they share a "shared state across workers" theme. P0-4 is the big one (L).
3. **P0-7 image OOM**, **P0-8 ETag**, **E-7 backup snapshot** — cheap correctness/safety wins.
4. **F-1 FTS5** — biggest feature gap, self-contained.
5. **F-2 + F-3** (OpenAPI + SDK gen) — share one generator; restores the docs surface too (T-3).
6. **T-2 pipeline tests**, **T-4/T-5 docs/cleanup** — bank the hardening.
7. Then the remaining enhancements (E-*) and features (F-4 WebAuthn, F-6 OTel, F-7 readiness) by appetite.

> Note: most P0 items are **pre-existing upstream bugs**, not migration regressions. Worth fixing in the fork and optionally upstreaming (P0-1/P0-3 especially are small, clear security PRs).
