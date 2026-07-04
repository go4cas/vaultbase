/**
 * F-9 admin operator roles. Two layers:
 *   1. `classifyRequiredRole` — pure control-plane classification (owner/dev/…).
 *   2. `roleGateMiddleware` — end-to-end: real admin rows + signed JWTs → the
 *      gate returns 401 (no token) / 403 (insufficient role) / passes through.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { signAuthToken } from "../core/sec.ts";
import { roleGateMiddleware } from "../api/role-gate.ts";
import {
  classifyRequiredRole,
  roleAtLeast,
  normalizeRole,
  isAdminRole,
  type AdminRole,
} from "../core/admin-roles.ts";

const SECRET = "test-secret-f9";

describe("classifyRequiredRole", () => {
  it("classifies owner-tier control-plane paths", () => {
    expect(classifyRequiredRole("GET", "/api/v1/admin/backup")).toBe("owner"); // full DB download!
    expect(classifyRequiredRole("POST", "/api/v1/admin/restore")).toBe("owner");
    expect(classifyRequiredRole("PATCH", "/api/v1/admin/settings")).toBe("owner");
    expect(classifyRequiredRole("POST", "/api/v1/admin/admins")).toBe("owner");
    expect(classifyRequiredRole("POST", "/api/v1/admin/api-tokens")).toBe("owner");
    expect(classifyRequiredRole("GET", "/api/v1/admin/security/sessions")).toBe("owner");
  });

  it("classifies developer-tier (RCE / schema) paths", () => {
    for (const p of [
      "/api/v1/admin/hooks",
      "/api/v1/admin/routes",
      "/api/v1/admin/jobs",
      "/api/v1/admin/queues/stats",
      "/api/v1/admin/sql/queries",
      "/api/v1/admin/migrations/snapshot",
      "/api/v1/admin/webhooks",
      "/api/v1/admin/flags",
      "/api/v1/admin/collections/stats",
    ]) {
      expect(classifyRequiredRole("GET", p)).toBe("developer");
    }
    // Schema writes are developer; reads are ungated.
    expect(classifyRequiredRole("POST", "/api/v1/collections")).toBe("developer");
    expect(classifyRequiredRole("DELETE", "/api/v1/collections/abc")).toBe("developer");
  });

  it("does NOT gate reads/records/auth/observability", () => {
    expect(classifyRequiredRole("GET", "/api/v1/collections")).toBeNull(); // schema read
    expect(classifyRequiredRole("GET", "/api/v1/collections/abc")).toBeNull();
    expect(classifyRequiredRole("POST", "/api/v1/posts")).toBeNull(); // record write (data plane)
    expect(classifyRequiredRole("POST", "/api/v1/auth/users/login")).toBeNull();
    expect(classifyRequiredRole("POST", "/api/v1/admin/setup")).toBeNull(); // setup must stay open
    expect(classifyRequiredRole("GET", "/api/v1/admin/logs")).toBeNull(); // observability read
  });
});

describe("role helpers", () => {
  it("ranks ascending and defaults unknown → owner", () => {
    expect(roleAtLeast("owner", "developer")).toBe(true);
    expect(roleAtLeast("developer", "owner")).toBe(false);
    expect(roleAtLeast("editor", "editor")).toBe(true);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
    expect(normalizeRole("bogus")).toBe("owner"); // pre-RBAC rows
    expect(normalizeRole("viewer")).toBe("viewer");
    expect(isAdminRole("developer")).toBe(true);
    expect(isAdminRole("root")).toBe(false);
  });
});

describe("roleGateMiddleware (end-to-end)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogworks-f9-"));
    setLogsDir(tmpDir);
    initDb(":memory:");
    await runMigrations();
  });
  afterEach(() => {
    closeDb();
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* swallow */
    }
  });

  async function makeAdmin(role: AdminRole): Promise<string> {
    const id = crypto.randomUUID();
    await getDb()
      .insert(admin)
      .values({ id, email: `${role}@x.com`, password_hash: "x", role, created_at: 0 });
    const { token } = await signAuthToken({
      payload: { id, email: `${role}@x.com` },
      audience: "admin",
      expiresInSeconds: 3600,
      jwtSecret: SECRET,
    });
    return token;
  }

  function app() {
    const a = new Hono();
    a.use("*", roleGateMiddleware(SECRET));
    a.all("*", (c) => c.json({ ok: true }));
    return a;
  }

  const call = (a: ReturnType<typeof app>, method: string, path: string, token?: string) =>
    a.request(path, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it("401s a gated path with no token", async () => {
    const res = await call(app(), "GET", "/api/v1/admin/hooks");
    expect(res.status).toBe(401);
  });

  it("developer can reach developer paths but not owner paths", async () => {
    const a = app();
    const dev = await makeAdmin("developer");
    expect((await call(a, "GET", "/api/v1/admin/hooks", dev)).status).toBe(200);
    expect((await call(a, "PATCH", "/api/v1/admin/settings", dev)).status).toBe(403);
    expect((await call(a, "GET", "/api/v1/admin/backup", dev)).status).toBe(403);
  });

  it("viewer is blocked from developer paths", async () => {
    const a = app();
    const viewer = await makeAdmin("viewer");
    expect((await call(a, "GET", "/api/v1/admin/hooks", viewer)).status).toBe(403);
    expect((await call(a, "POST", "/api/v1/collections", viewer)).status).toBe(403);
  });

  it("P1-3: authoring hooks/routes/jobs/SQL is gated to developer+ (host-RCE surface)", async () => {
    const a = app();
    const editor = await makeAdmin("editor");
    const dev = await makeAdmin("developer");
    // editor (content role) cannot author code = cannot get host RCE
    for (const p of [
      "/api/v1/admin/hooks",
      "/api/v1/admin/routes",
      "/api/v1/admin/jobs",
      "/api/v1/admin/sql/sandbox",
    ]) {
      expect((await call(a, "POST", p, editor)).status).toBe(403);
    }
    // developer can
    expect((await call(a, "POST", "/api/v1/admin/hooks", dev)).status).toBe(200);
  });

  it("owner reaches everything", async () => {
    const a = app();
    const owner = await makeAdmin("owner");
    expect((await call(a, "PATCH", "/api/v1/admin/settings", owner)).status).toBe(200);
    expect((await call(a, "GET", "/api/v1/admin/backup", owner)).status).toBe(200);
    expect((await call(a, "POST", "/api/v1/admin/admins", owner)).status).toBe(200);
  });

  it("ungated paths pass through for any admin", async () => {
    const a = app();
    const viewer = await makeAdmin("viewer");
    expect((await call(a, "POST", "/api/v1/posts", viewer)).status).toBe(200);
    expect((await call(a, "GET", "/api/v1/collections", viewer)).status).toBe(200);
  });

  it("a demotion takes effect immediately (role read fresh, not from the token)", async () => {
    const a = app();
    const id = crypto.randomUUID();
    await getDb()
      .insert(admin)
      .values({ id, email: "x@x.com", password_hash: "x", role: "owner", created_at: 0 });
    const { token } = await signAuthToken({
      payload: { id, email: "x@x.com" },
      audience: "admin",
      expiresInSeconds: 3600,
      jwtSecret: SECRET,
    });
    expect((await call(a, "PATCH", "/api/v1/admin/settings", token)).status).toBe(200);
    // Demote to developer — same token, now insufficient for the owner path.
    const { eq } = await import("drizzle-orm");
    await getDb().update(admin).set({ role: "developer" }).where(eq(admin.id, id));
    expect((await call(a, "PATCH", "/api/v1/admin/settings", token)).status).toBe(403);
  });
});
