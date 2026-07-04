/**
 * E-2 — realtime subscription filters. A subscriber can attach a filter
 * expression to its topics; an event is delivered only if the record also
 * matches the filter (AND-combined with the collection's view_rule). Unlike a
 * view rule, the filter is the client's own choice, so admins are not exempt.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { subscribe, broadcast, setWSAuth, _reset } from "../realtime/manager.ts";

interface MockWS {
  sent: string[];
  send(data: string): void;
  data: { connId: string };
}
let _id = 0;
function mockWs(): MockWS {
  return {
    sent: [],
    send(data) {
      this.sent.push(data);
    },
    data: { connId: `flt-${++_id}` },
  };
}

function rec(status: string) {
  const raw = { id: "rec1", status, title: "hi" };
  const record = { collectionId: "c1", collectionName: "posts", created: 0, updated: 0, ...raw };
  return { record: record as never, raw };
}

function fire(status: string) {
  const r = rec(status);
  broadcast(
    "posts",
    { type: "create", collection: "posts", record: r.record },
    { viewRule: null, record: r.raw },
  );
}

describe("E-2 subscription filters", () => {
  beforeEach(() => _reset());

  it("delivers only records matching the filter", () => {
    const a = mockWs();
    subscribe(a, ["posts"], "status = 'published'");
    fire("published");
    expect(a.sent).toHaveLength(1);
    fire("draft");
    expect(a.sent).toHaveLength(1); // draft filtered out
  });

  it("no filter → receives everything", () => {
    const b = mockWs();
    subscribe(b, ["posts"]);
    fire("published");
    fire("draft");
    expect(b.sent).toHaveLength(2);
  });

  it("a filter is per-topic — a broader unfiltered subscription still delivers", () => {
    const c = mockWs();
    subscribe(c, ["posts"], "status = 'published'");
    subscribe(c, ["*"]); // no filter on the wildcard
    fire("draft"); // fails the posts filter, but the `*` subscription has none
    expect(c.sent).toHaveLength(1);
  });

  it("admins are NOT exempt from their own filter", () => {
    const d = mockWs();
    subscribe(d, ["posts"], "status = 'published'");
    setWSAuth(d, { id: "admin1", type: "admin" });
    fire("draft");
    expect(d.sent).toHaveLength(0); // filtered even though admin
    fire("published");
    expect(d.sent).toHaveLength(1);
  });

  it("filter AND view_rule both apply", () => {
    const e = mockWs();
    setWSAuth(e, { id: "u1", type: "user" });
    subscribe(e, ["posts"], "status = 'published'");
    const r = rec("published");
    // view_rule requires ownership the user lacks → not delivered despite the filter matching
    broadcast(
      "posts",
      { type: "create", collection: "posts", record: r.record },
      { viewRule: "owner = @request.auth.id", record: { ...r.raw, owner: "someone-else" } },
    );
    expect(e.sent).toHaveLength(0);
  });
});
