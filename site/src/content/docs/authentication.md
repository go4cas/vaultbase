---
title: Authentication
description: Auth collections, JWT sessions, passwords, MFA, passkeys, OAuth2, OTP, anonymous users, API tokens, admin roles, and impersonation.
sidebar:
  order: 6
---

## Authentication overview

Users belong to an **auth collection**. On login Cogworks issues a signed JWT (`HS256`, issuer `cogworks`). Tokens carry an audience and are checked on every request against a revocation list and the account's `password_reset_at` — resetting a password invalidates every prior token.

| Audience | Used for | Default lifetime | Setting |
| --- | --- | --- | --- |
| `user` | End-user sessions | 7 days | `auth.user.window_seconds` |
| `admin` | Admin console | 7 days | `auth.admin.window_seconds` |
| `api` | Long-lived API tokens (`cwat_`) | 90 days | — |
| `file` | Signed file-download URLs | 1 hour | `auth.file.window_seconds` |

A successful login returns the token plus a minimal record. Send the token as a bearer header on subsequent requests; it also decodes to standard claims:

```js title="Login response & decoded claims"
// response body
{ "data": { "token": "eyJhbGciOiJIUzI1NiI…",
           "record": { "id": "usr_9", "email": "alice@example.com" } } }

// the JWT payload
{ "id": "usr_9", "email": "alice@example.com", "collection": "users",
  "iss": "cogworks", "aud": "user", "jti": "…", "iat": 1751500000, "exp": 1752104800 }
```

Every request re-verifies the signature, issuer, audience, expiry, the `jti` revocation list, and that `password_reset_at ≤ iat`. Refresh a session with `POST` `/auth/refresh`; end it with `POST` `/auth/logout` (revokes the `jti` and clears the auth cookies). `GET` `/auth/me` returns `{ id, email, aud, exp }` for the current token.

Several auth methods are gated by feature flags (toggle via `auth.<feature>.enabled`); a disabled one returns `422`:

- `mfa` · on
- `webauthn` · on
- `impersonation` · on
- `otp` · off
- `anonymous` · off

## Password & MFA

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/auth/:collection/register` | Create a user |
| `POST` | `/auth/:collection/login` | Password login |
| `POST` | `/auth/:collection/login/mfa` | Second factor |
| `POST` | `/auth/:collection/request-password-reset` | Email a reset link |
| `POST` | `/auth/:collection/confirm-password-reset` | Set a new password |

### Register

Body is `{ email, password }` plus any custom fields on the collection. Passwords are hashed with argon2id and checked against your [password policy](#ops-settings).

```bash title="POST /api/v1/auth/users/register"
curl -X POST .../api/v1/auth/users/register \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-battery","name":"Ada"}'

→ { "data": { "id": "usr_9", "email": "alice@example.com" } }
```

:::note[No account enumeration]
Register, password-reset request, and OTP request always return the same success shape whether or not the email exists — they never reveal which addresses are registered. If SMTP is configured, register also sends a verification email.
:::

### Login & MFA

If the account has TOTP enabled, login returns an `mfa_token` instead of a session; exchange it (plus a code or a recovery code) at `/login/mfa`. The MFA ticket is single-use and burns after 5 wrong attempts.

```bash title="Two-step login"
curl -X POST .../api/v1/auth/users/login \
  -d '{"email":"alice@example.com","password":"…"}'
→ { "data": { "token": "<jwt>", "record": { "id": "usr_9", "email": "…" } } }
→ or, with MFA:  { "data": { "mfa_required": true, "mfa_token": "T" } }
→ bad creds:     { "error": "Invalid credentials", "code": 401 }

curl -X POST .../api/v1/auth/users/login/mfa \
  -d '{"mfa_token":"T","code":"123456"}'   # or "recovery_code":"XXXX-XXXX"
→ { "data": { "token": "<jwt>", "record": { … } } }
```

### Password reset

Request a reset link, then confirm with the emailed token. Confirming bumps `password_reset_at`, which invalidates every existing session for that account.

```http title="Reset flow"
POST /auth/users/request-password-reset   { "email": "alice@example.com" }
→ { "data": { "sent": true } }   // always, regardless of existence

POST /auth/users/confirm-password-reset   { "token": "…", "password": "new-pass" }
→ { "data": { "reset": true } }
```

### TOTP (authenticator apps)

RFC-6238, 6 digits, 30-second step, ±1 step drift tolerance. All endpoints require a user token.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/auth/:collection/totp/setup` | Generate a pending secret |
| `POST` | `/auth/:collection/totp/confirm` | Verify a code to enable |
| `POST` | `/auth/:collection/totp/disable` | Requires a current code |
| `POST` | `/auth/:collection/totp/recovery/regenerate` | Replace recovery codes |
| `GET` | `/auth/:collection/totp/recovery/status` | `{ total, remaining }` |

```http title="Setup → confirm"
POST /auth/users/totp/setup            # Bearer user token
→ { "data": {
     "secret": "JBSWY3DPEHPK3PXP",
     "otpauth_url": "otpauth://totp/App:alice?secret=JBSWY…&issuer=App" } }

POST /auth/users/totp/confirm  { "code": "123456" }
→ { "data": { "enabled": true } }
```

Recovery codes are issued as ten `XXXX-XXXX` strings, shown once at regeneration and each usable a single time. An admin can clear a locked-out user's MFA via `POST /admin/users/:collection/:id/disable-mfa`.

## Passkeys (WebAuthn)

FIDO2 passwordless auth. Registration happens while signed in; login is a passwordless ceremony. The relying party is derived from your `app.url` (override with `webauthn.rp_id` / `webauthn.origins`).

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/auth/:collection/webauthn/register/options` | → options + ticket (auth) |
| `POST` | `/auth/:collection/webauthn/register/verify` | Store the credential (auth) |
| `POST` | `/auth/:collection/webauthn/login/options` | → options + ticket |
| `POST` | `/auth/:collection/webauthn/login/verify` | → user token |
| `GET` | `/auth/:collection/webauthn/credentials` | List my passkeys |
| `DELETE` | `/auth/:collection/webauthn/credentials/:id` | Remove one |

```js title="Passwordless login (browser)"
// 1. get options
const { data } = await api.post("/auth/users/webauthn/login/options", { email });
// 2. sign the challenge with the platform authenticator
const assertion = await navigator.credentials.get({ publicKey: data.options });
// 3. verify → session token
const res = await api.post("/auth/users/webauthn/login/verify",
  { ticket: data.ticket, response: assertion });
```

## OAuth2

Sign in with Google, GitHub, GitLab, Microsoft, Apple, Discord, and a dozen more — plus a generic `oidc` provider. The client owns the redirect and posts the authorization code back; there is no server callback route.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/auth/:collection/oauth2/providers` | Enabled providers |
| `GET` | `/auth/:collection/oauth2/authorize` | → authorize_url (+ PKCE) |
| `POST` | `/auth/:collection/oauth2/exchange` | Code → session |
| `POST` | `/auth/:collection/oauth2/merge-confirm` | Link to an existing account |
| `DELETE` | `/auth/:collection/oauth2/:provider/unlink` | Unlink a provider |

**Providers:** `google`, `github`, `gitlab`, `microsoft`, `apple`, `facebook`, `discord`, `twitch`, `spotify`, `linkedin`, `slack`, `bitbucket`, `notion`, `patreon`, `twitter` (PKCE-forced), and a generic `oidc`. Configure each with `oauth2.<provider>.enabled`, `.client_id`, `.client_secret`. Restrict return targets with `oauth2.<provider>.allowed_redirect_uris` (or the global `oauth2.allowed_redirect_uris`; supports `*` and trailing-`*` prefixes).

### The exchange flow

1. **Authorize** — `GET …/oauth2/authorize?provider=…&redirectUri=…&state=…` returns `{ authorize_url }`. Pass `use_pkce=1` (or a client-supplied `code_challenge`) for PKCE.
2. Redirect the user; they return to your `redirectUri` with a `code`.
3. **Exchange** — `POST …/oauth2/exchange` with `{ provider, code, redirectUri, state?, code_verifier? }`.

| Exchange outcome | Response |
| --- | --- |
| Provider already linked | `{ data: { token, record } }` — signed in |
| Verified email matches an existing account | `{ data: { merge_required: true, merge_token, … } }` — confirm the link rather than silently merging |
| New user | Creates the account (email pre-verified from the provider) and signs in |

Confirm a merge with `POST …/oauth2/merge-confirm` (the account's password or a session token proves ownership). Apple and OIDC need extra keys (`team_id`/`key_id`/`private_key`; authorization/token URLs).

## Email OTP

Passwordless login by emailed code or magic link (feature flag `otp`, off by default; requires SMTP).

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/auth/:collection/otp/request` | Email a 6-digit code + link |
| `POST` | `/auth/:collection/otp/auth` | Code or token → session |

One request issues a single token carrying _both_ a long magic-link `token` and a 6-digit `code`. Authenticate with either: `{ token }` alone, or `{ code, email }` — the code path needs the email, since a bare 6-digit code isn't unique. Codes expire in **10 minutes** with a **5-attempt cap** (the token burns after that). A successful OTP sets `email_verified` (it proves ownership). Request is no-enumeration — always `{ data: { sent: true } }` whether or not the email exists (anonymous accounts are skipped). If the account has TOTP enabled, OTP returns an `mfa_required` ticket instead of a session — OTP doesn't bypass the second factor.

## Anonymous users

Guest sessions (feature flag `anonymous`, off by default) let you attach state to a visitor before they sign up, then promote them in place.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/auth/:collection/anonymous` | Mint a guest session |
| `POST` | `/auth/:collection/promote` | Guest → real account (keeps the id) |

The guest is a real user row with a synthetic `anon_<hex>@anonymous.invalid` email, `is_anonymous=1`, and a 30-day token (`anonymous: true` claim). `promote` takes `{ email, password, …custom }` on the guest's own token, validates uniqueness (`409` if the email is taken) and the password policy, flips `is_anonymous=0`, and mints a fresh full session — every record the guest created stays attached. Only anonymous accounts can be promoted (checked from the DB, not the token → `422` otherwise).

## API tokens

Long-lived personal access tokens for scripts and integrations. They carry the `cwat_` prefix and a scope set that is read live from the database (so you can tighten a token after minting).

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/admin/api-tokens` | Mint (token shown once) |
| `GET` | `/admin/api-tokens` | List (metadata only) |
| `DELETE` | `/admin/api-tokens/:id` | Revoke |

```bash title="POST /api/v1/admin/api-tokens"
curl -X POST .../api/v1/admin/api-tokens \
  -H "authorization: Bearer <admin-jwt>" \
  -d '{"name":"ci-deploy","scopes":["read","write"],"ttl_seconds":7776000}'

→ 201 { "data": {
     "id": "tok_1",
     "token": "cwat_eyJhbGciOi…",   // shown ONCE — store it now
     "expires_at": 1759276000 } }
```

| Scope | Grants |
| --- | --- |
| `admin` | Everything (implies all other scopes) |
| `read` / `write` | Record reads / writes across _all_ collections (independent — neither implies the other) |
| `collection:<name>:<read\|write\|*>` | Scope a token to one collection (and action). `*` wildcards either segment — `collection:*:read`, `collection:posts:*` |
| `mcp:read` · `mcp:write` · `mcp:admin` · `mcp:sql` | MCP tool tiers (see [MCP](#feat-mcp)); `mcp:admin` implies all `mcp:*` |

:::tip[Least-privilege tokens for agents & integrations]
Per-collection scopes are enforced on the REST records _and_ batch surface: a token scoped `["collection:posts:read"]` can read `posts` and nothing else — no writes, no other collections (out-of-scope calls get `403 "Insufficient token scope"`). Global `read`/`write` are a superset (they satisfy any collection of the matching action), so hand automations the narrowest scope that works.
:::

Default lifetime is 90 days (max 10 years). Scopes are read **live from the database** at verify time, so you can tighten or revoke a token after it's minted. The token's principal is the minting admin — resetting that admin's password (or the admin's role) applies immediately; the token's power never exceeds that admin's. Revoke with `DELETE` `/admin/api-tokens/:id`.

:::note[CLI shortcut]
Mint without the HTTP API: `cogworks token mint --name ci --scope read --scope write --ttl 90d`.
:::

## Admin & setup

The first admin is created once, from the CLI or a guarded HTTP call.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/admin/setup/status` | Whether an admin exists |
| `POST` | `/admin/setup` | Create the first admin |
| `POST` | `/admin/auth/login` | Admin login |

Set `COGWORKS_SETUP_KEY` to require an `X-Setup-Key` header on `/admin/setup` — this closes the race where someone reaches setup before you on a public IP. Login lockout (`auth.lockout.max_attempts`) is off by default; when enabled it keys on email + client IP and returns `429` when tripped. Manage additional admins under `/admin/admins` and active sessions under `/admin/security/sessions`.

## Admin roles

Admins carry an operator **role** so you can add teammates without handing everyone the keys. The four roles are ascending — each includes the ones below it:

| Role | Can do |
| --- | --- |
| `viewer` | Read-only operator — view schema, logs, metrics, audit. |
| `editor` | + manage app data (records, users, files) through the admin UI. |
| `developer` | + author **code** and schema: hooks, custom routes, cron jobs, queue workers, the SQL runner, migrations, indexes, webhooks, feature flags, and collection schema. |
| `owner` | + the keys: settings, backup / restore, API-token minting, admin management, and security / sessions. |

A single classification map gates the **control plane** by `(method, path)`: the RCE-class surface (hooks/routes/jobs/queues/SQL/migrations/indexes/webhooks/flags/schema) requires `developer`; credentials/settings/backup/admins/security require `owner`. An insufficient role gets `403`.

:::caution[Why this exists — hooks are host code]
Authoring a hook (or route/job/SQL) is arbitrary code execution in the server process. Roles let you grant `editor`/`viewer` for content and read access _without_ that power. See the [hook trust model](#ext-limits).
:::

### Managing roles

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/admin/admins` | List admins (with roles) |
| `POST` | `/admin/admins` | `{ email, password, role? }` — defaults `editor` |
| `PATCH` | `/admin/admins/:id` | Change email / password / role |
| `DELETE` | `/admin/admins/:id` | Remove an admin |

The first admin (from setup) is always `owner`. On upgrade, existing admins default to `owner` so no one loses access. You can't grant a role above your own, and the **last owner** can't be demoted or deleted. Role changes take effect on the admin's very next request — no need to wait for their token to expire.

:::note[Scope of enforcement]
Roles gate the **control plane** (schema, code, ops, credentials). On the **data plane**, every admin still bypasses collection rules today — per-record enforcement for `editor`/`viewer` is a planned refinement. To restrict what an _integration_ can touch, use a scoped [API token](#auth-tokens) instead.
:::

## Impersonation

An admin can act as a user for support and debugging (feature flag `impersonation`, on by default — `422` when off). The minted user token carries an `impersonated_by: <adminId>` claim so any actions taken are attributable to the admin in logs, and is short-lived (1 hour).

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/admin/impersonate/:collection/:userId` | → `{ token, record, impersonated_by }` |
