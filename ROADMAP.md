# Cogworks (fork) — Server Roadmap

Status audit + prioritized improvement roadmap for the **server** (cogworks repo), generated from a review of the post-Hono-migration codebase. `sdk` and `mcp` to follow once the server is done.

Legend — **Confidence**: ✅ verified in code · ⚠️ review-flagged, needs verify before fix. **Effort**: S (<½ day) · M (1–2 days) · L (multi-day). Most items marked *(pre-existing)* were inherited from upstream `vaultbase-sh`, not introduced by the Hono migration — candidates to also contribute upstream.

---

## ✅ Progress

**P0 — all cleared.** P0-1/2/3 admin+user token-revocation bypasses (#12); P0-4 cross-worker realtime bus (#16); P0-5 cluster singleton schedulers (#14); P0-6 per-worker rate-limit documented (#15); P0-7 image decompression-bomb cap (this PR); P0-8 ETag same-second lost-update guard (this PR). **T-1** centralized admin gate / removed ~16 duplicate helpers (#13). Plus the CI/`@sinclair/typebox` fix + Hono/fork README (#11).

**Shipped since the last audit** (were "planned" here, now verified in code — see the ledger below): F-1 FTS5, F-2 OpenAPI + `/docs`, F-4 passkeys/WebAuthn, F-6 OTLP tracing, F-7 `/_/ready`, plus enhancements E-1 cursor pagination, E-3 SSE/WS resume, E-6 hook timeout, E-7 `VACUUM INTO` backup, E-9 reverse-relation expand.

**Just shipped:** **F-3** typed SDK generator (`GET /api/v1/sdk/types.ts` — server-side, emits TS types + a thin typed client from the live collections; not the sibling `@cogworks/sdk` repo).

**RBAC sprint — ✅ complete (~~F-9~~ → ~~F-10~~ → ~~P1-3~~).** The all-root admin model is gone: control-plane operator roles (F-9), per-collection token scopes (F-10), and an honest hook threat-model gated to developer/owner (P1-3). **Queue hardening — ✅ complete (~~P1-1~~ reaper + ~~P1-2~~ global concurrency + ~~E-12~~ dead-letter replay UI).** **Durability/ops — ~~F-13~~ ✅ key rotation · ~~E-8~~ ✅ durable transactional emails · F-14 ◐ email drivers (SMTP + Resend HTTP done; SES/Postmark + bounce webhooks = F-14b follow-up).** **L differentiators — ~~F-11~~ ◐ durable-workflow engine landed (waitForEvent + authoring UI = F-11b); F-12 PITR/WAL replication remains.** Full order at the bottom. `sdk` + `mcp` sibling repos come **after** the whole server order.

> Scope note: this roadmap is **server-only**. The standalone `sdk`/`mcp` repos are sequenced last.

---

## ✅ Shipped since last audit

Reconciles status drift — these were tracked as planned but are live in the tree (verified this pass). Rows kept in their category tables below are annotated `✅`.

| ID | What | Evidence |
|----|------|----------|
| P0-4 | Cross-worker realtime bus (SQLite pub/sub + 200ms tail) | `src/realtime/cluster-bus.ts`, `manager.ts:189` |
| E-1 | Keyset/cursor pagination on list | `src/api/records.ts:134,151` |
| E-3 | SSE/WS resume — `id:` per event + `Last-Event-ID` replay from a durable event log | `server.ts:444`, `realtime/sse.ts:19`, `cluster-bus.ts:68` |
| E-6 | Hook/job execution timeout (async `Promise.race`) | `src/core/user-code.ts:26` |
| E-7 | Consistent backup snapshot (`VACUUM INTO`) | `src/scripts/backup.ts`, `index.ts:357` |
| E-9 | Reverse-relation expand (`comments_via_post`) | `src/core/records.ts` (reverse-relation block) |
| F-1 | Full-text search (SQLite FTS5, opt-in `searchable`) | `src/core/fts.ts` |
| F-2 | OpenAPI 3.0 spec + Scalar `/docs` from collection defs | `src/api/openapi.ts`, `core/openapi.ts` |
| F-4 | WebAuthn / passkeys | `src/core/webauthn.ts`, `api/auth-webauthn.ts` |
| F-6 | OpenTelemetry / OTLP trace export | `src/core/otel.ts`, `perf-metrics.ts` |
| F-7 | Readiness `/_/ready` (distinct from liveness) | `src/server.ts:410` |

**Also verified already-present** (external reviews flagged these as gaps — they are not): CI runs `bun test` + typecheck + lint on push/PR (`.github/workflows/ci.yml`); `LICENSE` + `package.json` `"license":"MIT"`; schema-as-code snapshot with additive/sync apply + `--apply-snapshot` (`src/core/migrations.ts`).

---

## P0 — Bugs & security (do before any features) — ✅ DONE

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

## P1 — Security & correctness hardening (bug-adjacent, do after P0)

Surfaced by two external reviews and verified against the current tree. Not P0-critical, but each is a real correctness/security gap rather than a feature.

| # | Sev | Item | Evidence | Confidence | Effort |
|---|-----|------|----------|-----------|--------|
| P1-1 ✅ | 🟠 Correctness | **Queue reaper / visibility timeout** (done). A throttled sweep in the scheduler reclaims jobs stuck `running` past `queues.visibility_timeout_sec` (default 300) — re-queuing them (bump attempt) or dead-lettering once `retry_max` is hit. Atomic `WHERE status='running'` guard for cluster safety; unblocks the `uniqueKey` dedup a dead job was holding. At-least-once (documented). | `core/queues.ts` (`reapStuckJobs`, `runReaperOnce`) | ✅ | S–M |
| P1-2 ✅ | 🟡 Correctness | **Global queue concurrency** (done). Slot accounting now derives from a DB `COUNT(*) WHERE queue=? AND status='running'` instead of an in-memory per-process `inFlight` map, so a worker's `concurrency` cap holds across cluster processes (and excludes reclaimed jobs). Transient overshoot under simultaneous ticks documented (a hard cap would need row locks). | `core/queues.ts` (`countRunning`) | ✅ | S |
| P1-3 ✅ | 🟠 Security | **Hook threat-model honesty + role-gate** (done). `SECURITY.md` + the docs site now state plainly that hook/route/job authoring is host-RCE-equivalent and that the egress guard is **not** a sandbox (raw `fetch`/`Bun`/`process` bypass it — it only reduces *accidental* SSRF from `helpers.http`). Authoring is gated to `owner`/`developer` via **F-9** (`/admin/hooks\|routes\|jobs\|sql` → developer), so `editor`/`viewer` get content/read access without RCE. No global-shadowing (leaky, low payoff). | `SECURITY.md`, `cogworks-docs.html`, `core/admin-roles.ts` | ✅ | S (docs) |
| P1-4 ✅ | 🟠 Security | **MCP write-tool safety** (done). Per-tool sliding-window rate limit in the dispatcher (`tools.ts` — write-class 30/min, reads 240/min) + a `dry_run` on `cogworks.run_sql` that returns `EXPLAIN QUERY PLAN` without executing. `allow_write:true` remains the explicit per-call opt-in. | `mcp/tools.ts`, `mcp/admin-write-tools.ts` | ✅ | S–M |
| P1-5 ✅ | 🟡 Credibility | **Release integrity verified; repo docs consistent.** Confirmed `v0.11.5` (and prior) publish full cosign `.sig` + `.pem` + `SHA256SUMS` + SBOM `.cdx.json` for every target — the reviewer's API just couldn't see them; `install.sh --verify-sig` deps are present. Repo field-type docs are consistent at 15. **Owner action (external, not in repo):** the landing-page "14 vs 15" Numbers block + site OAuth list; and release assets are still named `vaultbase-*` (rebrand of the release pipeline is a separate effort). | GitHub releases, `README.md` | ✅ | S |

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
| T-2 ✅ | **Test the root middleware pipeline.** `pipeline-invariants.test.ts` drives `createServer` and asserts the security/CORS envelope (nosniff, X-Frame, Referrer-Policy, Retry-After) lands even on a short-circuited 429. | `__tests__/pipeline-invariants.test.ts` | M |
| T-3 ✅ | **Re-add API docs** — done via **F-2** (`/api/v1/openapi.json` + `/docs`) + **F-3** SDK types. | `api/openapi.ts` | M |
| T-4 ✅ | **Purge stale "Elysia" comments** — fixed the one actively-wrong claim (`routes.ts` "Elysia onRequest hook" → Hono root middleware). The remaining "(replaces the Elysia …)" notes are accurate migration context, deliberately kept. | `api/routes.ts` | S |
| T-5 ✅ | **`ARCHITECTURE.md` + `CONTRIBUTING.md`** authored — pipeline, data model, subsystem map, trust model; setup + quality gates + conventions. | `ARCHITECTURE.md`, `CONTRIBUTING.md` | S |
| T-6 | **Split `auth.ts` (~1500 lines)** into cohesive sub-plugins (setup / user-auth / MFA-recovery / impersonation) along existing route-group seams. Mechanical, no behavior change. | `src/api/auth.ts` | M |
| T-7 ⏸ | **Co-locate DB indexes with schema** — deferred. This repo hand-writes `migrate.ts` (no drizzle-kit), so Drizzle `index()` defs in `schema.ts` wouldn't actually run — co-locating would be cosmetic and could mislead. Revisit only if adopting drizzle-kit. | `db/migrate.ts` | S |
| T-8 ✅ | **`resStatus(c)` helper** — factored the 3 `try { c.res.status } catch {}` sites into `api/http-util.ts`. | `api/http-util.ts` | S |
| T-9 ✅ | **Release-on-tag re-gates tests** — added a `test` job (lint+typecheck+`bun test`) that the `build` job `needs`, so a tag can't ship red. | `.github/workflows/release.yml` | S |
| T-10 | **Extract the rule engine into a reusable `core/rules/` primitive** — *pulled by a concrete second consumer, not built speculatively.* The evaluator already has the two backends that matter (SQL-pushdown for list filtering + in-memory eval); factor it so ACL, feature flags, and future consumers share one DSL/evaluator instead of bespoke mini-languages. **Trigger:** land this when **F-11** (workflow `waitForEvent` predicates) or a webhook-condition feature needs it. See the architecture note below. | `core/filter.ts` (rule compile/eval), `core/flags.ts` (its own rule fmt) | M |

---

## Category 2 — Enhancements to existing features (non-bug)

| # | Item | Current limitation | Effort |
|---|------|--------------------|--------|
| E-1 ✅ | **Keyset/cursor pagination** for the hot list path | OFFSET pagination + unconditional `COUNT(*)` per list → deep pages are O(offset) (`records.ts:367,377`) | M |
| E-2 | **Realtime subscription filters** (`posts?filter=status='published'`) | `normalizeTopic` only supports collection/id/event/`*`; clients over-subscribe (`manager.ts:98`) | M |
| E-3 ✅ | **SSE/WS resume** (emit `id:`, replay from `Last-Event-ID`) | no event id, no replay on reconnect → gaps lost (`realtime/sse.ts:16`) | M |
| E-4 | **S3 presigned URLs / public redirects for downloads** | S3 files are proxied through the server (full object into RAM); `publicUrlFor` is dead code (`storage.ts:203,221`) | M |
| E-5 | **Stream uploads to storage** instead of `await file.arrayBuffer()` buffering whole file in RAM | `files.ts:413` | S (+M for resumable) |
| E-6 ✅ | **Hook/job execution timeout** (`Promise.race` budget) | user code runs with no timeout; a hung before-hook blocks the request/event loop (`hooks.ts:156`) | M |
| E-7 ✅ | **Consistent backup snapshot** (`VACUUM INTO` / WAL checkpoint) | HTTP backup streams the live DB file — may miss un-checkpointed WAL commits or read torn (`backup.ts:20`) | S |
| E-8 ✅ | **Durable transactional emails** (route through the queue for at-least-once) | System emails (verify/reset/OTP) now go through the built-in `_mail` queue (`enqueueEmail`) → retry + backoff + dead-letter + reaper. Generic after-hook side-effect durability is already expressible via `helpers.enqueue`; not force-wrapped. | `core/mail-queue.ts`, `api/auth.ts` | S–M |
| E-9 ✅ | **Reverse-relation expand** (`comments_via_post`) | `expandRelations` only follows forward relations (`records.ts:829`) | M |
| E-10 | **`sqlite-vec` ANN index** for vector search (see F-5 — an enhancement of the existing vector feature) | in-process cosine scan, silent 100K cap, per-query re-parse (`records.ts:515`, `vector.ts:128`) | L |
| E-11 ◐ | **Per-hook timing + slow-query log** | Per-hook timing done: `runHookTimed` wraps every before/after hook and logs a `slow hook` warning past `hooks.slow_ms` (default 1000). **Remaining:** the slow-query log needs a central DB-exec wrapper (no chokepoint today — `getRawClient` is used directly across the codebase); larger, deferred. | `core/hooks.ts` | M |
| E-12 ✅ | **Queue/job ops UI** — depth, retries, **dead-letter replay** | The Jobs-log tab already had per-queue depth (queued/running/dead), status/queue filters, and per-job retry+discard. Added **bulk dead-letter replay**: `retryDeadJobs(queue?)` + `POST /admin/queues/jobs/retry-dead` + a "Replay dead (N)" button scoped to the current queue filter. | `core/queues.ts`, `api/queues.ts`, `admin/.../Hooks.tsx` (JobsLogTab) | M |
| E-13 ✅ | **User/token-keyed rate limits** (in addition to per-IP) | Authenticated requests now bucket by a hash of the bearer token, so users sharing an egress IP (NAT/carrier) get independent budgets; guests stay IP-keyed. | `api/ratelimit.ts` | S–M |
| E-14 ⏸ | **Roles sugar on auth collections** (`@request.auth.roles ~ "editor"`) | **Not sugar** — deferred. `@request.auth.<field>` resolves only `id`/`type`/`email` today (`rules.ts:215`); `roles` needs enriching the auth context with user fields across BOTH the in-memory eval and the SQL-compile paths — a security-sensitive change to the hot path. Reclassify as M. | `rules.ts`, `filter.ts` | M |

---

## Category 3 — Net-new features

**Already shipped (verified — do NOT rebuild):** row-level realtime auth, S3/R2/B2 file storage, CSV import+export, email templates, per-collection webhooks, record history + audit log, deferred/scheduled queue jobs, field-level encryption, TOTP/MFA/OTP/OAuth2/impersonation, MCP server, feature flags, notifications, SQL sandbox, metrics.

| # | Feature | Why / fit | Effort |
|---|---------|-----------|--------|
| F-1 ✅ | **Full-text search (SQLite FTS5)** — opt-in `searchable` field flag → contentless FTS5 table synced on write; `search=` param. | `core/fts.ts` | M |
| F-2 ✅ | **OpenAPI spec + embedded docs** (`/api/v1/openapi.json` + Scalar `/docs`) — generated from **collection defs**. Shares its generator core with F-3. | `api/openapi.ts`, `core/openapi.ts` | M |
| F-3 ✅ | **Typed client-SDK generator** — `GET /api/v1/sdk/types.ts` emits per-collection record/create/update interfaces, a `CogworksSchema` registry, and a thin typed `Cogworks` client. Server-side generator (not the sibling `@cogworks/sdk` repo); gated by `docs.enabled`. | `core/sdk-types.ts`, route in `api/openapi.ts` | M |
| F-4 ✅ | **WebAuthn / passkeys** — passwordless registration + login beside TOTP. | `core/webauthn.ts`, `api/auth-webauthn.ts` | M–L |
| F-5 | **`sqlite-vec` ANN vector index** (also E-10) — drop-in for the existing swappable vector seam; removes the brute-force ceiling. | `records.ts:515`, `vector.ts:128` | M |
| F-6 ✅ | **OpenTelemetry/OTLP trace export** — per-request span tree exported from the root `finish()` path, gated by `otel.endpoint`. | `core/otel.ts`, `perf-metrics.ts` | M |
| F-7 ✅ | **Readiness endpoint** `/_/ready` (DB writable + migrations done) distinct from liveness. | `server.ts:410` | S |
| F-8 | **One-off "run at" job scheduling in admin UI** — the `scheduled_at`/`enqueue({delay})` primitive exists; just expose a one-off from the admin (mostly UI). | `api/jobs.ts`, `queues.ts:172` | S–M |
| F-9 ✅ | **Admin operator roles** (owner/developer/editor/viewer) — `role` on `cogworks_admin` (defaults `owner`, so no one loses access on upgrade); a single audited classification map + role-gate middleware enforces the **control plane** (schema/code/ops → developer; settings/backup/tokens/admins/security → owner). Admins CRUD manages roles with a last-owner guard; demotions take effect immediately. **Deferred (pass 2):** per-record data-plane enforcement for viewer/editor (admins still bypass collection rules — tracked with E-14) + admin-UI role editor. | `core/admin-roles.ts`, `api/role-gate.ts`, `api/admins.ts` | M–L |
| F-10 ✅ | **Per-collection token scopes** — `collection:<name>:<read\|write\|*>` (with `*` wildcards); `read`/`write` stay a global superset. `hasScope` now resolves the grammar, `isValidScope` gates minting. **Also closed a latent gap:** API tokens now actually authenticate on the REST records/batch surface (prefix was never stripped there) *and* are enforced per-collection — so a `["read"]` token can no longer write, and `collection:posts:read` touches nothing but posts. **Remaining:** split `mcp:write` (records vs hooks vs settings) — a smaller MCP-catalog follow-up; files/csv API-token access unchanged. | `core/api-tokens.ts`, `api/records.ts`, `api/batch.ts` | M |
| F-11 ◐ | **Code-first durable workflows** — engine landed: `defineWorkflow` + `step.run` (memoized — side effects fire once across sleeps/restarts) + `step.sleep`, persisted to `cogworks_workflow_runs`, **resumable across process restarts** (verified). Memoized-steps model (DBOS/Inngest), not Temporal replay. Scheduler wakes sleeping runs + sweeps crash-stranded ones. **Remaining (F-11b):** `step.waitForEvent` (on the realtime event-log), admin-authored definitions (compiled like workers), per-run versioning, retry/timeout policy, ops UI. | `core/workflows.ts`, `db/schema.ts` (`workflow_runs`) | L |
| **F-12** | **Opt-in PITR / streaming WAL replication** — litestream-style continuous WAL shipping to S3/R2; closes the point-in-time-recovery gap without leaving the single-file model. Keeps SQLite the source of truth (chosen over adding Postgres). | `scripts/backup.ts` seam | L |
| F-13 ✅ | **Encryption key rotation** — multi-key trial-decrypt via `COGWORKS_ENCRYPTION_KEY_OLD` (AES-GCM's tag rejects wrong keys, so **no wire-format key-id needed** — existing `vbenc:1:` data stays readable) + `cogworks rotate-key` CLI re-encrypting all fields + settings under the new key in one transaction. Idempotent/resumable; history relies on old-key retention (documented). | `core/encryption.ts`, `core/key-rotation.ts`, `scripts/rotate-key.ts` | M |
| F-14 ◐ | **Transactional-email provider drivers** — a `mail.transport` seam (`smtp` \| `http`) with an HTTP driver (**Resend**) beside SMTP; all sends dispatch through it and ride the durable `_mail` queue (E-8). **Remaining (F-14b):** more HTTP providers (SES/Postmark — same shape) + inbound **bounce webhooks** & a suppression list (provider-specific; separate sub-feature). | `core/email.ts` (`sendViaHttp`, `mailTransport`) | M |

**Considered & recommend skip (YAGNI):**
- **Postgres/MySQL backend** — breaks the single-binary thesis; SQLite stays first-class. Durability/read-scale come from **F-12** (replication), not a second engine. *(Owner decision: SQLite-only.)*
- **Redis as the *default* queue/rate-limit backend** — an opt-in driver at most, never the default upgrade; reaching for it concedes the thing that makes the product different. Fix the queue with **P1-1/P1-2** instead.
- **Visual automation builder (Zapier/n8n-style)** — wrong product; competes with "logic is just code," and hooks+cron+queues already cover it imperatively. Durable multi-step needs go to **F-11**, not a canvas.
- **Parallel RBAC/ACL table for app data** — don't duplicate the rule engine; use **E-14** roles sugar over the existing expression rules. (See the rules-engine note below the build order.)
- **KMS/HSM key storage** — defer; folds into **F-13** later. **tus resumable uploads / ClamAV scanning** — defer (**E-5** covers streaming). **Extra-language SDKs (Py/Go/Swift) + plugin system** — defer until **F-3** proves the generator. **Realtime presence/broadcast channels** — no strong pull yet.
- Retained prior skips: **GraphQL/gRPC** (REST+filter/expand covers it), **DB branching** (SQL sandbox gives scratch copies), **multi-tenancy/orgs** (large blast radius; rule engine covers single-tenant).

---

## Recommended build order

P0 is done; the sequence below is what's left, **server-only**. The `sdk`/`mcp` sibling repos come after all of it.

1. **Finish in-flight** — **F-3** typed SDK generator (docs are done).
2. **RBAC sprint (next)** — **F-9** admin roles → **F-10** per-collection/MCP token scopes → **P1-3** hook threat-model docs + role-gate. Ends the all-root admin model; both external reviews' #1.
3. **Queue hardening** — **P1-1** reaper/visibility-timeout, **P1-2** global concurrency, **E-12** dead-letter replay UI. Cheap, high crash-safety.
4. **Credibility/safety cleanup** — **P1-4** MCP write safety, **P1-5** drift + release-integrity, **T-9** release-on-tag test gate.
5. **Durability/ops** — **F-13** key rotation, **F-14** email drivers + **E-8** durable emails.
6. **Search/observability** — **F-5/E-10** `sqlite-vec` ANN, **E-11** hook metrics + slow-query log, **E-13** user/token-keyed limits.
7. **Big differentiators (L)** — **F-12** PITR/WAL replication, then **F-11** durable workflows (rides the event-log spine).
8. Remaining **T-*** debt (T-2/T-4/T-5/T-6/T-7/T-8) by appetite.

> Note: most P0 items were **pre-existing upstream bugs**, not migration regressions — worth upstreaming (P0-1/P0-3 especially). The new **P1** tier came from two external reviews; the bulk of what those reviews flagged was already shipped (see the ledger up top) — P1 is only what survived verification.

---

## Architecture note — a generic rules engine? (T-10)

**Yes, there's a real case — but as a *pulled* refactor, not a speculative rebuild, and not a user-facing "rules product."**

The rule engine already *is* the ACL: `list/view/create/update/delete` rules in one expression DSL (`@request.auth.*`, `@collection.*`, comparisons, string/date fns), evaluated per request and **compiled to SQL for row-level list filtering** where possible. That SQL-pushdown is the valuable, hard-won part and is intrinsically tied to the record context.

Meanwhile several features quietly reinvent conditional logic: **feature flags** ship their own ordered-rule format, **webhooks** have event filters, **rate limits** match path+action+audience. That duplication — three mini-languages — is the actual argument for extracting one engine that ACL is merely the first consumer of.

Why it's a **refactor (T-10)**, not a feature:
- **Don't build it speculatively.** The evaluator already has both backends it needs (SQL-compile + in-memory eval). Extraction pays off only when a *second real consumer* lands. The strongest puller is **F-11 durable workflows** (`step.waitForEvent(predicate)` + branching wants exactly this DSL); a webhook-condition feature is the runner-up.
- **This is the *unify* move, not the *fork* move.** The reviews warned against a **parallel** ACL/RBAC table (don't duplicate the rule engine) — see the F-9/E-14 skip rationale. Making the engine generic is the complement: one DSL, more consumers.
- **Security widens with reach.** Each new context must sanitise its own variable bindings (`@request.*` injection is audited for ACL today; a flags/webhook/workflow context each needs the same care). More reason to centralise on one hardened evaluator rather than N.

**Recommendation:** keep ACL exactly as-is now; when F-11 or webhook-conditions need predicates, extract the evaluator into `core/rules/` (SQL backend + interpreter backend) and migrate flags onto it. Track as **T-10**, triggered by that consumer. Do **not** expose a standalone "generic rules engine" as a product surface — that's framework-building ahead of need.
