---
title: Operations
description: Environment configuration, the settings reference, rate limiting, backup/restore, migrations, cluster mode, and the security model.
sidebar:
  order: 12
---

## Configuration (env)

Boot-time configuration comes from `COGWORKS_*` environment variables. Everything else is a runtime
[setting](#ops-settings) editable in the admin UI.

| Variable | Purpose | Default |
| --- | --- | --- |
| `COGWORKS_DATA_DIR` | Data directory (db, uploads, logs, secrets) | `./cogworks_data` |
| `COGWORKS_PORT` | HTTP listen port | 8091 |
| `COGWORKS_JWT_SECRET` | Token signing key (auto-generated to `.secret` if unset) | generated |
| `COGWORKS_ENCRYPTION_KEY` | AES key for encrypted fields + secret settings (base64 / 64-hex / 32-char) | — |
| `COGWORKS_ENCRYPTION_KEY_OLD` | Previous key(s), comma-separated — accepted for decryption during a [key rotation](#feat-encryption) | — |
| `COGWORKS_SETUP_KEY` | Require `X-Setup-Key` on first-admin setup | — |
| `COGWORKS_MCP_TOKEN` | API token used by the `cogworks mcp` stdio bridge subcommand | — |
| `COGWORKS_ENV` / `NODE_ENV` | Production guardrail (e.g. `cogworks wipe` refuses on `production`) | — |
| `COGWORKS_TRUSTED_PROXIES` | Peer IPs/CIDRs trusted for `X-Forwarded-For` | `""` |
| `COGWORKS_WORKERS` | Worker count for `cogworks cluster` | CPU count |
| `COGWORKS_LOG_LEVEL` | `debug` · `info` · `warn` · `error` | `info` |
| `COGWORKS_RATE_ENABLED` | Global rate-limiter toggle | `1` |

:::note[Migrating from Vaultbase]
Legacy `VAULTBASE_*` variables are still honored as a fallback — each aliases to the
`COGWORKS_*` equivalent when the new name is unset. Update your env files at your convenience.
:::

## Settings reference

Runtime settings live in the `cogworks_settings` table and are edited through the admin UI or
`PATCH /api/v1/admin/settings`. Values are strings; booleans are `"1"`/`"0"`
(or `"true"`/`"false"`). Keys whose suffix looks like a secret —
`.password`, `.pass`, `.secret`, `.client_secret`,
`.api_key`, `.apikey`, `.token`, `.private_key`,
`.privatekey`, `.access_key`, `.accesskey`, `.service_account` —
are AES-GCM encrypted at rest when `COGWORKS_ENCRYPTION_KEY` is set.

#### App & access

| Key | Default | Meaning |
| --- | --- | --- |
| `app.url` | `""` | Public base URL — email links, OpenAPI server URL, WebAuthn RP |
| `docs.enabled` | on | Serve `/openapi.json` + `/docs` |
| `cors.origins` | `""` | Allowed browser origins (comma list; also gates WS/SSE) |
| `cors.credentials` | 0 | `Access-Control-Allow-Credentials` |
| `cors.methods` / `cors.headers` / `cors.max_age` | — | Preflight response config (max_age default 600) |
| `security.trusted_proxies` | `""` | Overrides the env var for `X-Forwarded-For` trust |

#### Auth

| Key | Default | Meaning |
| --- | --- | --- |
| `password.min_length` | 12 | Minimum length (hard floor 8) |
| `password.require_upper\|lower\|digit\|symbol` | 0 | Complexity requirements |
| `password.hibp_check` | 0 | Reject known-breached passwords (HaveIBeenPwned k-anonymity) |
| `auth.lockout.max_attempts` | 0 | Failed logins before lockout (0 = off) |
| `auth.lockout.duration_seconds` | 900 | Lockout duration (min 60) |
| `auth.otp\|mfa\|anonymous\|impersonation\|webauthn.enabled` | varies | Feature toggles (mfa/webauthn/impersonation on; otp/anonymous off) |
| `auth.user\|admin\|refresh.window_seconds` | 604800 | Token lifetimes — 7d |
| `auth.anonymous.window_seconds` | 2592000 | 30d |
| `auth.impersonate\|file.window_seconds` | 3600 | 1h (clamp 60s–365d) |
| `webauthn.rp_id` / `.origins` / `.rp_name` | derived | Passkey relying-party (defaults from `app.url`) |
| `oauth2.<provider>.enabled\|client_id\|client_secret` | off | Per-provider OAuth2 config (17 providers — see [OAuth2](#auth-oauth2)) |
| `oauth2.<provider>.allowed_redirect_uris` / `oauth2.allowed_redirect_uris` | allow all | Redirect allowlist (per-provider, else global). Entries support exact, `*`, and trailing-`*` prefix match |
| `oauth2.oidc.authorization_url\|token_url\|userinfo_url\|scopes\|display_name` | — | Generic OIDC provider endpoints (`scopes` default `"openid profile email"`) |
| `oauth2.apple.team_id|key_id|private_key` | — | Apple uses a signed ES256 JWT client-secret — no `client_secret` key |

#### Email, storage & delivery

| Key | Default | Meaning |
| --- | --- | --- |
| `mail.transport` | `smtp` | Delivery transport: `smtp` or `http` (Resend HTTP API) |
| `mail.http.api_key` / `mail.from` | — | HTTP-transport credentials (key encrypted; `mail.from` falls back to `smtp.from`) |
| `smtp.enabled` | 0 | Outbound email over SMTP (required for verify/reset/OTP unless HTTP transport) |
| `smtp.host` / `.port` / `.secure` / `.user` / `.pass` / `.from` | — | SMTP connection (port 587; `.pass` encrypted) |
| `storage.driver` | `local` | `local` or `s3` |
| `s3.endpoint` / `.bucket` / `.region` / `.access_key_id` / `.secret_access_key` / `.public_url` | — | Object storage target + credentials (secrets encrypted; `region` default `auto`) |
| `storage.redirect_downloads` | 0 | Offload S3 downloads: 302 to `public_url`/CDN or a short-lived presigned URL instead of proxying bytes |
| `notifications.providers.onesignal.*` / `.fcm.*` | off | Push provider credentials |

#### Engine & observability

| Key | Default | Meaning |
| --- | --- | --- |
| `vector.max_candidates` | 100000 | Vector search candidate cap |
| `realtime.retention_sec` | 30 | SSE resume / replay window |
| `execution.timeout_ms` | 5000 | Hook / route / job execution budget (0 = off) |
| `hooks.slow_ms` | 1000 | Log a warning when a hook runs longer than this |
| `queues.visibility_timeout_sec` | 300 | Reaper reclaims jobs stuck `running` past this (see [Queue workers](#ext-queues)) |
| `hooks.http.deny` / `hooks.http.allow` | RFC1918… | SSRF egress CIDR deny/allow (`"off"` disables) |
| `rate_limit.enabled` / `rate_limit.rules` | on | Rate limiter toggle + JSON rule array |
| `metrics.enabled` / `metrics.token` | 0 | Prometheus endpoint + optional bearer |
| `otel.endpoint` / `.service_name` / `.headers` | `""` | OTLP trace export |
| `update_check.enabled` | 1 | Poll GitHub for newer releases |

## Rate limiting

A per-rule token bucket runs as the innermost root middleware; tripping it returns `429`
with a `Retry-After` header. Turn it off globally with `COGWORKS_RATE_ENABLED=0` or the
`rate_limit.enabled` setting.

**Bucket key:** authenticated requests are keyed by a hash of the bearer token, so users sharing
one egress IP (corporate NAT, mobile carrier) get independent budgets; unauthenticated requests fall back to
per-IP. Buckets are per worker process — under [cluster mode](#ops-cluster) a client spread across
N workers can reach up to N× a rule's limit in aggregate (auth brute-force is separately capped by the
DB-backed login lockout).

Rules match on path prefix + action + audience. Defaults, when no
`rate_limit.rules` is set:

| Scope | Limit |
| --- | --- |
| Auth endpoints (`*:auth`) | 10 / 3s |
| Record creates (`*:create`) | 60 / 5s |
| All API (`/api/*`) | 300 / 10s |

```json title="Custom rules — rate_limit.rules"
[
  { "label": "*:auth",   "max": 5,   "windowMs": 3000 },
  { "label": "/api/*",  "max": 600, "windowMs": 10000 }
]
```

`/_/*`, `/realtime`, health, and admin-log endpoints are skipped. Buckets are
**per worker process** — under a cluster, a client spread across workers can reach up to N× a
limit. For strict cluster-wide limits, enforce them at the reverse proxy; brute-force protection is separately
backed by the DB-level [login lockout](#auth-admin).

## Backup & restore

Snapshots use SQLite's `VACUUM INTO`, so the result is a single self-contained `.db`
with WAL already merged in — consistent and never torn, even while the server is live.

```bash title="Backup (CLI + HTTP)"
# CLI — runs alongside the live server, no downtime
cogworks backup --to /var/backups/cogworks-$(date +%F).db
cogworks backup --to s3://my-bucket/db/snap.db --gzip

# HTTP — streams the same consistent snapshot
curl -H "authorization: Bearer <admin>" \
  https://api.example.com/api/v1/admin/backup -o snapshot.db
```

Restore uploads a snapshot to POST `/api/v1/admin/restore`: it
verifies the file, swaps it in (keeping a `.bak`), and re-migrates. Existing tokens stay valid.

## Migrations & indexes

Move schema changes between environments as portable snapshots — export the collection/field/rule definitions
from one instance, diff them against another, and apply.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin/migrations/snapshot` | Download the schema as JSON |
| POST | `/admin/migrations/diff` | Preview changes vs a snapshot |
| POST | `/admin/migrations/apply` | Apply (`mode: additive \| sync`) |

Snapshots can also be applied at boot: `cogworks --apply-snapshot schema.json --snapshot-mode additive`.
`additive` only creates/extends; `sync` also removes what's absent.

### Indexes

Add secondary indexes to a collection's backing table for query performance. Only user indexes
(prefixed `idx_` / `uniq_`) are managed here.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin/collections/:name/indexes` | List |
| POST | `/admin/collections/:name/indexes` | Create (`{ field, unique? }`) |
| DELETE | `/admin/collections/:name/indexes/:indexName` | Drop |

## Cluster mode

Run `cogworks cluster` to spawn N worker processes that all bind the same port via
`SO_REUSEPORT`; the kernel load-balances across them. All workers share one WAL database.

```bash title="Cluster"
COGWORKS_WORKERS=4 cogworks cluster
```

The parent supervises workers (respawning on crash) and drains gracefully on `SIGTERM`.
Read-heavy workloads scale near-linearly; write-heavy workloads contend on the single WAL writer.
Schedulers and the event-log pruner run only on the leader.

## Security model

- **Three principals:** anonymous, authenticated user (an auth-collection row), and admin
  (trusted with code execution on the host). Rules gate user access; admins bypass rules.
- **Tokens:** signed JWTs checked against a revocation list and `password_reset_at`
  on every request. Logout and password reset invalidate tokens immediately.
- **Admin-authored code** (hooks, routes, jobs) runs in-process with host reach — treat admin
  access as equivalent to shell access. Outbound `helpers.http` is SSRF-guarded; execution is
  time-boxed.
- **Transport:** Cogworks does not terminate TLS. Run it behind nginx/Caddy and restrict the
  data directory to the service user.
- **Secrets:** the JWT secret and encryption key live on disk (mode 0600), never in the
  database.

### Session management

The admin console exposes live sessions and kill-switches under `/api/v1/admin/security`:

| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin/security/sessions` | Active admin sessions |
| DELETE | `/admin/security/sessions/:jti` | Revoke one session |
| POST | `/admin/security/force-logout-all` | Invalidate every admin token |
| GET | `/admin/security/fingerprints` | JWT-secret / encryption-key fingerprints |

:::danger[Before going public]
Set access rules on every collection, put TLS in front, set `cors.origins`, and provide
`COGWORKS_ENCRYPTION_KEY` if you store secrets or encrypted fields.
:::
