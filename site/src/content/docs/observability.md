---
title: Observability
description: Logs, Prometheus metrics, OTLP tracing, health probes, and generated OpenAPI for Cogworks.
sidebar:
  order: 11
---

## Logs

Structured request + hook logs are written as JSONL, one file per UTC day, under
`<dataDir>/logs/`. Console verbosity is set by `COGWORKS_LOG_LEVEL`
(`debug`/`info`/`warn`/`error`). Cogworks never rotates or deletes — that's your retention policy to run.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin/logs` | Browse (substring + date filters) |
| POST | `/admin/logs/search` | JSONPath query across entries |

## Metrics

A Prometheus endpoint exposes request rate, latency-per-pipeline-step summaries, and SQLite page stats. It's
off by default — enable with `metrics.enabled=1` (optionally guarded by a `metrics.token`).

```text title="GET /api/v1/metrics"
cogworks_uptime_seconds 43200
cogworks_requests_total 918234
cogworks_rps_1min 12.4
cogworks_step_duration_microseconds{step="db_exec",quantile="0.99"} 1840
cogworks_sqlite_wal_pages 128
```

Admin-only JSON snapshots are also available at `/api/v1/_/metrics`.

## Tracing (OTLP)

Set `otel.endpoint` to export per-request traces to any OpenTelemetry collector (Jaeger, Tempo,
Grafana). Each request becomes a root span with a child span per pipeline phase (`db_exec`,
`row_decode`, …). Dependency-free — OTLP/HTTP JSON over a single POST, no SDK.

| Setting | Meaning |
| --- | --- |
| `otel.endpoint` | Collector URL (`/v1/traces` appended if missing) |
| `otel.service_name` | `service.name` (default `cogworks`) |
| `otel.headers` | Comma-separated `key=value` headers (e.g. auth) |

## Health & readiness

Two distinct probes for orchestrators — liveness stays green during a migration while readiness holds traffic
off.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/_/health` | Liveness → status, worker_id, pid, uptime |
| GET | `/_/ready` | Readiness → 200 when DB + migrations ready, else 503 |

```yaml title="Kubernetes probes"
livenessProbe:  { httpGet: { path: /_/health, port: 8091 } }
readinessProbe: { httpGet: { path: /_/ready,  port: 8091 } }
```

## OpenAPI

Cogworks generates an OpenAPI 3.0 spec from your collections — field types become JSON Schema, and each
collection gets record CRUD paths (views are read-only). A rendered reference is served alongside it.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/openapi.json` | The generated spec |
| GET | `/api/v1/docs` | Rendered API reference |

Both honor the `docs.enabled` setting (on by default; set it off to hide the surface).
