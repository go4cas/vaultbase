---
title: Introduction
description: Cogworks is a self-hosted REST + realtime backend compiled into a single binary.
sidebar:
  order: 1
---

Cogworks turns a SQLite database into a full REST + realtime backend — collections, auth, file storage, rules, hooks, and an admin UI — compiled to one executable with no external services to run.

Cogworks is a fork of [vaultbase-sh/vaultbase](https://github.com/vaultbase-sh/vaultbase) by Khalid M. Sheet. Its main divergence is a server rewrite from Elysia to [Hono](https://hono.dev), plus the feature set documented here.

#### Real SQL tables

Every collection is a native SQLite table — fast queries, real indexes, no JSON-blob soup.

#### Batteries-included auth

Password, TOTP, passkeys, OAuth2, email OTP, anonymous, API tokens — all built in.

#### Realtime

WebSocket + SSE with per-record rule filtering and reconnect resume.

#### Extensible

Hooks, custom routes, cron, and queue workers in sandboxed-ish JS with a rich helper API.
