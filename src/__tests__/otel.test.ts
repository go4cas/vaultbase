/**
 * F-6 OTLP trace export. The per-request timer's phase durations are turned into
 * an OTLP/JSON trace (root request span + child phase spans) and POSTed to
 * `otel.endpoint`. Dependency-free; gated on the setting; best-effort.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { RequestTimer } from "../core/perf-metrics.ts";
import {
  getOtelConfig,
  buildTracePayload,
  exportRequestTrace,
  type TraceInput,
} from "../core/otel.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});
afterEach(() => closeDb());

const SAMPLE: TraceInput = {
  method: "GET",
  route: "/api/v1/collections/:collection/records",
  status: 200,
  startWallNs: 1_700_000_000_000_000_000n,
  totalUs: 5000,
  steps: [
    ["db_exec", 3000],
    ["row_decode", 800],
  ],
};

type OtlpPayload = {
  resourceSpans: Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
    scopeSpans: Array<{
      spans: Array<{
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        kind: number;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
        status?: { code: number };
      }>;
    }>;
  }>;
};

describe("getOtelConfig", () => {
  it("is null when otel.endpoint is unset", () => {
    expect(getOtelConfig()).toBeNull();
  });

  it("parses endpoint, service name, and headers", () => {
    setSetting("otel.endpoint", "http://collector:4318");
    setSetting("otel.service_name", "my-svc");
    setSetting("otel.headers", "authorization=Bearer xyz, x-tenant=acme");
    expect(getOtelConfig()).toEqual({
      endpoint: "http://collector:4318",
      serviceName: "my-svc",
      headers: { authorization: "Bearer xyz", "x-tenant": "acme" },
    });
  });

  it("defaults the service name to cogworks", () => {
    setSetting("otel.endpoint", "http://c:4318");
    expect(getOtelConfig()?.serviceName).toBe("cogworks");
  });
});

describe("buildTracePayload", () => {
  it("emits a root SERVER span with http attributes", () => {
    const p = buildTracePayload(SAMPLE, "cogworks") as OtlpPayload;
    const rs = p.resourceSpans[0]!;
    expect(rs.resource.attributes[0]).toEqual({
      key: "service.name",
      value: { stringValue: "cogworks" },
    });
    const root = rs.scopeSpans[0]!.spans[0]!;
    expect(root.name).toBe("GET /api/v1/collections/:collection/records");
    expect(root.kind).toBe(2); // SERVER
    expect(root.parentSpanId).toBeUndefined();
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    const attrKeys = root.attributes.map((a) => a.key);
    expect(attrKeys).toContain("http.request.method");
    expect(attrKeys).toContain("http.route");
    expect(attrKeys).toContain("http.response.status_code");
    expect(root.status?.code).toBe(0); // UNSET for 200
    // end = start + total
    expect(BigInt(root.endTimeUnixNano) - BigInt(root.startTimeUnixNano)).toBe(5_000_000n);
  });

  it("emits one child span per recorded step, parented to the root, laid sequentially", () => {
    const p = buildTracePayload(SAMPLE, "cogworks") as OtlpPayload;
    const spans = p.resourceSpans[0]!.scopeSpans[0]!.spans;
    const root = spans[0]!;
    const children = spans.slice(1);
    expect(children.map((c) => c.name)).toEqual(["db_exec", "row_decode"]);
    for (const c of children) {
      expect(c.kind).toBe(1); // INTERNAL
      expect(c.parentSpanId).toBe(root.spanId);
      expect(c.traceId).toBe(root.traceId);
    }
    // db_exec: 3000µs → 3_000_000ns, starting at the root start
    const db = children[0]!;
    expect(BigInt(db.startTimeUnixNano)).toBe(SAMPLE.startWallNs);
    expect(BigInt(db.endTimeUnixNano) - BigInt(db.startTimeUnixNano)).toBe(3_000_000n);
    // row_decode starts where db_exec ended (sequential)
    expect(BigInt(children[1]!.startTimeUnixNano)).toBe(BigInt(db.endTimeUnixNano));
    expect(db.attributes.find((a) => a.key === "cogworks.step.duration_us")?.value.intValue).toBe(
      "3000",
    );
  });

  it("marks the root span ERROR for 5xx", () => {
    const p = buildTracePayload({ ...SAMPLE, status: 503 }, "cogworks") as OtlpPayload;
    expect(p.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.status?.code).toBe(2); // ERROR
  });
});

describe("exportRequestTrace", () => {
  it("does nothing when disabled (no fetch)", () => {
    const orig = globalThis.fetch;
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      return Promise.resolve(new Response(""));
    }) as unknown as typeof fetch;
    try {
      const timer = new RequestTimer();
      timer.add("db_exec", 1000);
      exportRequestTrace(timer, { method: "GET", route: "/x", status: 200 });
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("POSTs OTLP JSON to <endpoint>/v1/traces with configured headers when enabled", async () => {
    setSetting("otel.endpoint", "http://collector:4318");
    setSetting("otel.headers", "authorization=Bearer t");
    const orig = globalThis.fetch;
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(new Response("", { status: 200 }));
    }) as unknown as typeof fetch;
    try {
      const timer = new RequestTimer();
      timer.add("db_exec", 1200);
      exportRequestTrace(timer, { method: "POST", route: "/api/v1/x", status: 201 });

      expect(capturedUrl).toBe("http://collector:4318/v1/traces");
      const headers = capturedInit!.headers as Record<string, string>;
      expect(headers["content-type"]).toBe("application/json");
      expect(headers.authorization).toBe("Bearer t");
      const body = JSON.parse(capturedInit!.body as string) as OtlpPayload;
      const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
      expect(spans[0]!.name).toBe("POST /api/v1/x");
      expect(spans.some((s) => s.name === "db_exec")).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("does not append /v1/traces when the endpoint already ends with it", () => {
    setSetting("otel.endpoint", "http://collector:4318/v1/traces");
    const orig = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(new Response(""));
    }) as unknown as typeof fetch;
    try {
      const timer = new RequestTimer();
      exportRequestTrace(timer, { method: "GET", route: "/x", status: 200 });
      expect(capturedUrl).toBe("http://collector:4318/v1/traces");
    } finally {
      globalThis.fetch = orig;
    }
  });
});
