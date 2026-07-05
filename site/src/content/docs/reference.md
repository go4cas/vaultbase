---
title: CLI & reference
description: The cogworks command-line subcommands, their flags, and boot-time snapshot options.
sidebar:
  order: 14
---

## CLI commands

Invoke as `cogworks <command>`. With no command it starts the HTTP server.

| Command | Purpose | Key flags |
| --- | --- | --- |
| `setup-admin` | Create or reset an admin from the CLI | `--email` `--password` `--force` |
| `cluster` | Spawn worker processes (SO_REUSEPORT) | env `COGWORKS_WORKERS` |
| `backup` | Consistent snapshot to file / S3 / R2 / B2 | `--to` `--gzip` `--quiet` `--no-verify` |
| `rotate-key` | Re-encrypt all fields + settings under the current key | set `COGWORKS_ENCRYPTION_KEY_OLD` first |
| `token` | Mint / list / revoke API tokens (direct DB) | `mint --name --scope --ttl` · `list` · `revoke <id>` |
| `mcp` | Run the MCP server over stdio for AI agents | `--token` `--read-only` |
| `doctor` | Read-only pre-flight / migration checks | — |
| `update` | Self-update to the latest signed release | `--check` `--yes` `--version` `--allow-downgrade` |
| `wipe` | Hard-reset the install (destructive) | `--yes` `--force` |

The server (no subcommand) also accepts `--apply-snapshot <file.json>` with
`--snapshot-mode additive|sync` to apply a [schema snapshot](#ops-migrations) before it
starts serving — handy for GitOps deploys.

:::tip[You're up to date]
This reference tracks the current codebase, including full-text and vector search, keyset pagination,
reverse-relation expand, passkeys, SSE resume, OTLP tracing, the readiness probe, and generated OpenAPI.
Questions or gaps? They're worth filing — the docs should always match the binary.
:::
