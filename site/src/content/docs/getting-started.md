---
title: Getting started
description: Install Cogworks, create the first admin, and learn how the single-process architecture fits together.
sidebar:
  order: 2
---

## Quick start

Install the binary, create the first admin, and you have a running backend.

```bash title="Install (Linux)"
# One-line installer — downloads the signed binary, creates a service
curl -fsSL https://get.cogworks.dev | sh

# Create the first admin (CLI — never exposes a public web wizard)
cogworks setup-admin --email you@example.com --password '<strong-password>'

# Or just run it locally from the binary
./cogworks                 # serves on :8091, admin UI at /_/
```

Open the admin UI at `http://localhost:8091/_/`, create a collection, and you can immediately read and write records over the REST API:

```bash title="First requests"
# List records (public collections need no auth)
curl http://localhost:8091/api/v1/posts

# Create a record
curl -X POST http://localhost:8091/api/v1/posts \
  -H 'content-type: application/json' \
  -d '{"title":"Hello","body":"First post"}'
# → {"data":{"id":"…","title":"Hello","created":1751,"updated":1751}}
```

From an app, it's plain `fetch` — log in, keep the token, send it as a bearer header:

```js title="From JavaScript"
const base = "http://localhost:8091/api/v1";

// sign in
const { data } = await fetch(`${base}/auth/users/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
}).then(r => r.json());
const token = data.token;

// authenticated write
await fetch(`${base}/posts`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ title: "Hello", status: "published" }),
});
```

:::tip[Next step]
Define access rules on your collection (see [Access rules](#rules)) before exposing it publicly — a `null` rule means _anyone_ can perform that action.
:::

## Architecture

Cogworks is one process. It bundles the HTTP server, the admin single-page app, and the database driver into a single compiled executable. There is nothing else to deploy.

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Bun | Fast startup, native SQLite & S3 clients, single-file `--compile` |
| HTTP | Hono | Small, fast router; the whole request pipeline is one middleware chain |
| Database | `bun:sqlite` (WAL) | Embedded, transactional, concurrent readers; no separate DB server |
| Admin UI | React SPA | Embedded into the binary at build time — served from `/_/` |

User collections are stored in tables prefixed `cw_<name>`; internal state lives in `cogworks_*` tables. The data directory (default `./cogworks_data`) holds `data.db`, `uploads/`, `logs/`, and the generated JWT secret.

:::note[Scaling]
A single process saturates one core. For more throughput run [cluster mode](#ops-cluster) — N worker processes sharing the same WAL database via `SO_REUSEPORT`. It does _not_ terminate TLS or compression — put nginx or Caddy in front (see [Reverse proxy](#deploy-proxy)).
:::
