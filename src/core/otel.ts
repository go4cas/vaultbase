/**
 * OpenTelemetry trace export (OTLP/HTTP JSON) — dependency-free.
 *
 * The per-request `RequestTimer` already measures each phase's duration; this
 * turns that into an OTLP trace and POSTs it to an `otel.endpoint` collector.
 * No OpenTelemetry SDK — a single `fetch` of hand-built OTLP/JSON keeps the
 * single-binary / no-native-deps property.
 *
 * NOTE on fidelity: the timer records accumulated *durations* per phase, not
 * real per-phase start times. We emit a real root request span (accurate
 * start + total) with child spans laid out sequentially — the durations are
 * exact, the relative offsets are synthesized (a phase waterfall, not a
 * precisely-scheduled trace). Good enough to see where request time goes.
 */
import { getAllSettings } from "../api/settings.ts";
import { log } from "./log.ts";
import type { RequestTimer } from "./perf-metrics.ts";
import type { Step } from "./perf-metrics.ts";

interface OtelConfig {
  endpoint: string;
  serviceName: string;
  headers: Record<string, string>;
}

/** Resolve OTLP config from settings, or null when `otel.endpoint` is unset. */
export function getOtelConfig(): OtelConfig | null {
  const s = getAllSettings();
  const endpoint = (s["otel.endpoint"] ?? "").trim();
  if (!endpoint) return null;
  const serviceName = (s["otel.service_name"] ?? "").trim() || "cogworks";
  const headers: Record<string, string> = {};
  for (const pair of (s["otel.headers"] ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) headers[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return { endpoint, serviceName, headers };
}

function randHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function attr(key: string, value: string | number) {
  return typeof value === "number"
    ? { key, value: { intValue: String(value) } }
    : { key, value: { stringValue: value } };
}

export interface TraceInput {
  method: string;
  route: string;
  status: number;
  startWallNs: bigint;
  totalUs: number;
  steps: Array<[Step, number]>;
}

/** Build an OTLP/JSON `resourceSpans` payload for one request. Pure — unit-testable. */
export function buildTracePayload(input: TraceInput, serviceName: string): unknown {
  const traceId = randHex(16);
  const rootId = randHex(8);
  const startNs = input.startWallNs;
  const endNs = startNs + BigInt(Math.max(0, Math.round(input.totalUs * 1000)));

  const spans: unknown[] = [
    {
      traceId,
      spanId: rootId,
      name: `${input.method} ${input.route}`,
      kind: 2, // SPAN_KIND_SERVER
      startTimeUnixNano: startNs.toString(),
      endTimeUnixNano: endNs.toString(),
      attributes: [
        attr("http.request.method", input.method),
        attr("http.route", input.route),
        attr("http.response.status_code", input.status),
      ],
      status: { code: input.status >= 500 ? 2 : 0 }, // ERROR : UNSET
    },
  ];

  // Child spans: durations are exact; offsets are laid end-to-end from the start.
  let cursor = startNs;
  for (const [step, us] of input.steps) {
    if (us <= 0) continue;
    const s = cursor;
    const e = s + BigInt(Math.round(us * 1000));
    cursor = e;
    spans.push({
      traceId,
      spanId: randHex(8),
      parentSpanId: rootId,
      name: step,
      kind: 1, // SPAN_KIND_INTERNAL
      startTimeUnixNano: s.toString(),
      endTimeUnixNano: e.toString(),
      attributes: [attr("cogworks.step.duration_us", Math.round(us))],
    });
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", serviceName)] },
        scopeSpans: [{ scope: { name: "cogworks" }, spans }],
      },
    ],
  };
}

/**
 * Export a finished request's trace to the configured OTLP collector.
 * Best-effort + fire-and-forget: gated on `otel.endpoint`, never blocks or
 * throws into the request path, and only builds the payload when enabled.
 */
export function exportRequestTrace(
  timer: RequestTimer,
  meta: { method: string; route: string; status: number },
): void {
  const cfg = getOtelConfig();
  if (!cfg) return;
  const payload = buildTracePayload(
    {
      method: meta.method,
      route: meta.route,
      status: meta.status,
      startWallNs: timer.startWallNs,
      totalUs: timer.elapsedUs(),
      steps: timer.steps(),
    },
    cfg.serviceName,
  );
  const url = /\/v1\/traces$/.test(cfg.endpoint)
    ? cfg.endpoint
    : `${cfg.endpoint.replace(/\/$/, "")}/v1/traces`;
  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...cfg.headers },
    body: JSON.stringify(payload),
  }).catch((e) => {
    log.warn("otel trace export failed", { scope: "otel", err: String(e) });
  });
}
