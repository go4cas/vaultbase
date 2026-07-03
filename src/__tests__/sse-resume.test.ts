/**
 * E-3 SSE resume. Every broadcast is now persisted (single-process too) with a
 * monotonic seq; SSE events carry it as `id:`, and a client reconnecting with
 * `Last-Event-ID` replays the missed window (filtered by its topics + view_rule)
 * once it re-subscribes. Ordering: capture max seq → subscribe → replay ≤ max,
 * so live events are strictly newer than replayed ones (no dup, no gap).
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import {
  _reset,
  broadcast,
  registerSSEClient,
  setSSESubscriptions,
  setWSAuth,
  type RealtimeEvent,
  type WSLike,
} from "../realtime/manager.ts";
import { maxEventSeq, readEventsSince, resetRealtimeBus } from "../realtime/cluster-bus.ts";
import { openSSEStream } from "../realtime/sse.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(async () => {
  setLogsDir(mkdtempSync(join(tmpdir(), "cogworks-sse-")));
  initDb(":memory:");
  await runMigrations();
  _reset();
  resetRealtimeBus();
});
afterEach(() => {
  _reset();
  resetRealtimeBus();
  closeDb();
});

/** A fake SSE client that records every (data, id) it's sent. */
function fakeClient() {
  const received: Array<{ recordId: string; id: number | undefined }> = [];
  const adapter: WSLike & { data: { connId?: string } } = {
    data: {},
    send(d: string, id?: number) {
      const parsed = JSON.parse(d) as { record?: { id?: string }; id?: string };
      received.push({ recordId: parsed.record?.id ?? parsed.id ?? "?", id });
    },
  };
  return { adapter, received };
}

function createEvt(collection: string, id: string): RealtimeEvent {
  return {
    type: "create",
    collection,
    record: { id, collectionId: "c", collectionName: collection, created: 0, updated: 0 },
  } as RealtimeEvent;
}

describe("realtime event log (persist-always)", () => {
  it("persists every broadcast with a monotonic seq — single process", () => {
    broadcast("posts", createEvt("posts", "r1"), { viewRule: null });
    broadcast("posts", createEvt("posts", "r2"), { viewRule: null });
    expect(maxEventSeq()).toBe(2);
    const rows = readEventsSince(0, 10);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[0]!.kind).toBe("record");
  });
});

describe("SSE resume — replay on reconnect", () => {
  it("replays missed events for the subscribed topics, tagged with their seq", () => {
    broadcast("posts", createEvt("posts", "r1"), { viewRule: null });
    broadcast("posts", createEvt("posts", "r2"), { viewRule: null });
    broadcast("other", createEvt("other", "x"), { viewRule: null }); // different topic

    const { adapter, received } = fakeClient();
    registerSSEClient("cid", adapter, 0); // reconnect: Last-Event-ID = 0
    setSSESubscriptions("cid", ["posts"]);

    expect(received.map((r) => r.recordId)).toEqual(["r1", "r2"]); // not "x"
    expect(received.map((r) => r.id)).toEqual([1, 2]); // seq as id
  });

  it("only replays events after Last-Event-ID", () => {
    broadcast("posts", createEvt("posts", "r1"), { viewRule: null }); // seq 1
    broadcast("posts", createEvt("posts", "r2"), { viewRule: null }); // seq 2
    broadcast("posts", createEvt("posts", "r3"), { viewRule: null }); // seq 3

    const { adapter, received } = fakeClient();
    registerSSEClient("cid", adapter, 2); // already saw up to seq 2
    setSSESubscriptions("cid", ["posts"]);

    expect(received.map((r) => r.recordId)).toEqual(["r3"]);
    expect(received.map((r) => r.id)).toEqual([3]);
  });

  it("does not duplicate a replayed event against live delivery", () => {
    broadcast("posts", createEvt("posts", "r1"), { viewRule: null }); // seq 1

    const { adapter, received } = fakeClient();
    registerSSEClient("cid", adapter, 0);
    setSSESubscriptions("cid", ["posts"]); // replays r1
    expect(received.map((r) => r.recordId)).toEqual(["r1"]);

    // A NEW live event (seq 2 > captured max) → delivered live exactly once.
    broadcast("posts", createEvt("posts", "r2"), { viewRule: null });
    expect(received.map((r) => r.recordId)).toEqual(["r1", "r2"]);
    expect(received.map((r) => r.id)).toEqual([1, 2]);
  });

  it("re-applies view_rule on replay (no leak of admin-only events)", () => {
    broadcast("posts", createEvt("posts", "pub"), { viewRule: null }); // public
    broadcast("posts", createEvt("posts", "priv"), { viewRule: "" }); // admin-only

    const { adapter, received } = fakeClient();
    registerSSEClient("cid", adapter, 0);
    setWSAuth(adapter, null); // non-admin
    setSSESubscriptions("cid", ["posts"]);

    expect(received.map((r) => r.recordId)).toEqual(["pub"]); // "priv" filtered out
  });

  it("replays nothing when there is no missed window", () => {
    broadcast("posts", createEvt("posts", "r1"), { viewRule: null });
    const { adapter, received } = fakeClient();
    registerSSEClient("cid", adapter, 1); // already saw seq 1
    setSSESubscriptions("cid", ["posts"]);
    expect(received).toHaveLength(0);
  });
});

describe("SSE stream emits id:", () => {
  type AnyReader = {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
  };
  async function drain(reader: AnyReader, quietMs = 60) {
    const dec = new TextDecoder();
    let out = "";
    await new Promise((r) => setTimeout(r, 10));
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<{ done: true }>((res) => {
        timer = setTimeout(() => {
          void reader.cancel();
          res({ done: true });
        }, quietMs);
      });
      const result = await Promise.race([reader.read(), timeout]);
      if (timer) clearTimeout(timer);
      if (result.done) break;
      if (result.value) out += dec.decode(result.value, { stream: true });
    }
    return out;
  }

  it("writes an id: line carrying the event seq", async () => {
    const { response, clientId } = openSSEStream();
    const reader = response.body!.getReader();
    setSSESubscriptions(clientId, ["posts"]);
    broadcast("posts", createEvt("posts", "r1"), { viewRule: null });
    const text = await drain(reader);
    expect(text).toMatch(/\nid: \d+/); // SSE id line present
    expect(text).toContain('"id":"r1"'); // the record rode along
  });
});
