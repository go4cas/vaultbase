# Contributing to Cogworks

Thanks for helping out. Cogworks is a fork of
[vaultbase-sh/vaultbase](https://github.com/vaultbase-sh/vaultbase); its main
divergence is the Elysia→Hono server rewrite plus the roadmap in `ROADMAP.md`.

## Setup

```bash
bun install
bun run dev         # backend on :8091
bun run dev:admin   # admin SPA on :5173 (proxies /api → backend)
```

Read `ARCHITECTURE.md` first — it maps the request pipeline and the core modules.

## Quality gates (must pass before a PR)

```bash
bun run lint        # biome check (format + lint)
bun run typecheck   # tsc --noEmit
bun test            # full suite
```

CI runs all three on every push to `main` and every PR (`.github/workflows/ci.yml`),
and the release workflow re-gates them on the tagged commit.

## Conventions

- **Tests live in `src/__tests__/`.** Every non-trivial change ships a test.
  Use `:memory:` SQLite + `runMigrations()` (see any existing test for the
  `beforeEach`/`afterEach` harness). Prefer driving a plugin via `app.request(...)`
  or a core function directly over end-to-end server boot.
- **Migrations are hand-written + idempotent** in `src/db/migrate.ts`
  (`CREATE TABLE IF NOT EXISTS`, guarded `addColumn`). Add the typed mirror to
  `src/db/schema.ts`. Never assume a fresh DB — migrations run on every boot.
- **Security-critical paths** (auth, rules, encryption, RBAC) get extra care and
  explicit tests. Route admin auth through `getAdmin`/`requireAdmin` in
  `core/sec.ts` — never call `jose.jwtVerify` directly (it skips revocation).
- **User-facing code strings** name things by what people recognize, and errors
  say what went wrong + how to fix it.
- Keep the single-binary thesis: no new runtime services (Redis/Postgres/etc.)
  as a *default*. Opt-in drivers only, and only when a real need is measured.

## Pull requests

- Branch off `main`; keep the diff focused.
- Describe what changed and why; link the `ROADMAP.md` item if applicable.
- Update `ROADMAP.md` / `SECURITY.md` / docs when behavior or the security model
  changes.

## Reporting security issues

Please do **not** open a public issue for a vulnerability. See `SECURITY.md` for
the threat model and disclosure guidance.
