/**
 * F-4 WebAuthn / passkeys. Tests the server-owned surface: RP-config resolution,
 * the credential registry, ticket (challenge) lifecycle, endpoint guards +
 * contracts, account-enumeration safety, and clean rejection of bogus responses.
 *
 * The attestation/assertion cryptography itself is delegated to
 * `@simplewebauthn/server` (its own suite covers COSE/CBOR/signature checks);
 * here we assert we drive it correctly and never 500 on malformed input. A full
 * positive ceremony needs a real/virtual authenticator (browser-side) — noted
 * as a manual/e2e follow-up.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createCollection } from "../core/collections.ts";
import { insertUser } from "../core/users-table.ts";
import { signAuthToken } from "../core/sec.ts";
import { setSetting } from "../api/settings.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import {
  getRpConfig,
  insertCredential,
  listCredentials,
  getCredentialByCredId,
  touchCredential,
  deleteCredential,
  bytesToBase64url,
  base64urlToBytes,
} from "../core/webauthn.ts";

const SECRET = "test-secret-webauthn";
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cogworks-webauthn-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  setSetting("app.url", "https://example.com");
});

afterEach(() => {
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* swallow */
  }
});

/** Create an auth collection + one user, return {col, user, bearer token}. */
async function seedUser(email = "a@b.com") {
  const col = await createCollection({ name: "users", type: "auth", fields: "[]" } as never);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await insertUser(col, {
    id,
    email,
    password_hash: "x",
    created_at: now,
    updated_at: now,
  } as never);
  const { token } = await signAuthToken({
    payload: { id, email, collection: "users" },
    audience: "user",
    expiresInSeconds: 3600,
    jwtSecret: SECRET,
  });
  return { col, userId: id, email, token };
}

const app = () => makeAuthPlugin(SECRET);
const req = (path: string, init?: RequestInit) =>
  app().request(new Request(`http://localhost${path}`, init));
const authed = (token: string, body?: unknown, method = "POST") =>
  ({
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }) as RequestInit;

describe("WebAuthn — RP config", () => {
  it("derives rpID + origin from app.url", () => {
    const rp = getRpConfig();
    expect(rp).toEqual({
      rpID: "example.com",
      rpName: "Cogworks",
      origins: ["https://example.com"],
    });
  });

  it("returns null when nothing is configured", () => {
    setSetting("app.url", "");
    expect(getRpConfig()).toBeNull();
  });

  it("honors explicit webauthn.* overrides", () => {
    setSetting("webauthn.rp_id", "auth.example.com");
    setSetting("webauthn.origins", "https://a.example.com, https://b.example.com");
    setSetting("webauthn.rp_name", "MyApp");
    expect(getRpConfig()).toEqual({
      rpID: "auth.example.com",
      rpName: "MyApp",
      origins: ["https://a.example.com", "https://b.example.com"],
    });
  });
});

describe("WebAuthn — credential store", () => {
  it("round-trips a public key through base64url", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    expect(Array.from(base64urlToBytes(bytesToBase64url(bytes)))).toEqual(Array.from(bytes));
  });

  it("insert / list / lookup / touch / delete with owner scoping", async () => {
    const { col, userId } = await seedUser();
    insertCredential({
      id: "cred-row-1",
      userId,
      collectionId: col.id,
      credentialId: "AAAA",
      publicKey: "PUBKEY",
      counter: 0,
      transports: ["internal", "hybrid"],
      deviceName: "Test Key",
    });
    const list = listCredentials(userId, col.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.credential_id).toBe("AAAA");
    expect(list[0]!.transports).toBe('["internal","hybrid"]');

    expect(getCredentialByCredId("AAAA")?.id).toBe("cred-row-1");
    expect(getCredentialByCredId("nope")).toBeNull();

    touchCredential("cred-row-1", 5);
    expect(getCredentialByCredId("AAAA")?.counter).toBe(5);
    expect(getCredentialByCredId("AAAA")?.last_used_at).toBeGreaterThan(0);

    // Wrong owner can't delete.
    expect(deleteCredential("cred-row-1", "other-user", col.id)).toBe(false);
    expect(deleteCredential("cred-row-1", userId, col.id)).toBe(true);
    expect(listCredentials(userId, col.id)).toHaveLength(0);
  });
});

describe("WebAuthn — registration options", () => {
  it("401 without a bearer token", async () => {
    await seedUser();
    const res = await req("/auth/users/webauthn/register/options", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("422 on a non-auth collection", async () => {
    const { token } = await seedUser();
    await createCollection({ name: "posts", type: "base", fields: "[]" } as never);
    const res = await req("/auth/posts/webauthn/register/options", authed(token));
    expect(res.status).toBe(422);
  });

  it("422 when WebAuthn is disabled", async () => {
    const { token } = await seedUser();
    setSetting("auth.webauthn.enabled", "0");
    const res = await req("/auth/users/webauthn/register/options", authed(token));
    expect(res.status).toBe(422);
  });

  it("422 when app.url / rp is not configured", async () => {
    const { token } = await seedUser();
    setSetting("app.url", "");
    const res = await req("/auth/users/webauthn/register/options", authed(token));
    expect(res.status).toBe(422);
  });

  it("returns options + stores a single-use challenge ticket", async () => {
    const { token, email } = await seedUser();
    const res = await req("/auth/users/webauthn/register/options", authed(token));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        options: { challenge: string; rp: { id: string }; user: { name: string } };
        ticket: string;
      };
    };
    expect(data.options.rp.id).toBe("example.com");
    expect(data.options.user.name).toBe(email);
    expect(data.options.challenge.length).toBeGreaterThan(0);
    expect(data.ticket).toMatch(/^[0-9a-f]{64}$/);

    // The challenge was persisted as a webauthn_reg ticket.
    const row = getRawClient()
      .prepare(`SELECT purpose, code, used_at FROM cogworks_auth_tokens WHERE id = ?`)
      .get(data.ticket) as { purpose: string; code: string; used_at: number | null };
    expect(row.purpose).toBe("webauthn_reg");
    expect(row.code).toBe(data.options.challenge);
    expect(row.used_at).toBeNull();
  });
});

describe("WebAuthn — registration verify", () => {
  it("rejects a bogus response cleanly (400, not 500) and consumes the ticket", async () => {
    const { token } = await seedUser();
    const optRes = await req("/auth/users/webauthn/register/options", authed(token));
    const { data } = (await optRes.json()) as { data: { ticket: string } };

    const bogus = {
      ticket: data.ticket,
      response: { id: "x", rawId: "x", type: "public-key", response: {} },
    };
    const res = await req("/auth/users/webauthn/register/verify", authed(token, bogus));
    expect(res.status).toBe(400);

    // Ticket is now consumed — reuse is rejected.
    const reuse = await req("/auth/users/webauthn/register/verify", authed(token, bogus));
    expect(reuse.status).toBe(400);
    const row = getRawClient()
      .prepare(`SELECT used_at FROM cogworks_auth_tokens WHERE id = ?`)
      .get(data.ticket) as { used_at: number | null };
    expect(row.used_at).not.toBeNull();
  });

  it("400 on an unknown/invalid ticket", async () => {
    const { token } = await seedUser();
    const res = await req(
      "/auth/users/webauthn/register/verify",
      authed(token, { ticket: "deadbeef", response: {} }),
    );
    expect(res.status).toBe(400);
  });
});

describe("WebAuthn — login", () => {
  it("login/options is uniform for known and unknown emails (no enumeration)", async () => {
    await seedUser("known@b.com");
    const loginOptions = (email: string) =>
      req("/auth/users/webauthn/login/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
    const known = await loginOptions("known@b.com");
    const unknown = await loginOptions("ghost@b.com");
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    const k = (await known.json()) as { data: { ticket: string } };
    const u = (await unknown.json()) as { data: { ticket: string } };
    expect(typeof k.data.ticket).toBe("string");
    expect(typeof u.data.ticket).toBe("string");
  });

  it("login/verify rejects an unrecognized credential (401) and consumes the ticket", async () => {
    await seedUser();
    const optRes = await req("/auth/users/webauthn/login/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com" }),
    });
    const { data } = (await optRes.json()) as { data: { ticket: string } };
    const res = await req("/auth/users/webauthn/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: data.ticket, response: { id: "unknown-cred" } }),
    });
    expect(res.status).toBe(401);
    const row = getRawClient()
      .prepare(`SELECT used_at FROM cogworks_auth_tokens WHERE id = ?`)
      .get(data.ticket) as { used_at: number | null };
    expect(row.used_at).not.toBeNull();
  });

  it("login/verify rejects a passkey from a different collection", async () => {
    const { col } = await seedUser();
    const other = await createCollection({ name: "staff", type: "auth", fields: "[]" } as never);
    // Credential belongs to `staff`, not `users`.
    insertCredential({
      id: "row-x",
      userId: "u-x",
      collectionId: other.id,
      credentialId: "CREDX",
      publicKey: "K",
      counter: 0,
      transports: undefined,
      deviceName: null,
    });
    const optRes = await req("/auth/users/webauthn/login/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com" }),
    });
    const { data } = (await optRes.json()) as { data: { ticket: string } };
    const res = await req("/auth/users/webauthn/login/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: data.ticket, response: { id: "CREDX" } }),
    });
    // Cross-collection credential is not recognized here.
    expect(res.status).toBe(401);
    expect(col.name).toBe("users");
  });
});

describe("WebAuthn — credential management", () => {
  it("list requires auth and never leaks the public key", async () => {
    const { col, userId, token } = await seedUser();
    insertCredential({
      id: "row-1",
      userId,
      collectionId: col.id,
      credentialId: "C1",
      publicKey: "SECRET_KEY_MATERIAL",
      counter: 0,
      transports: ["internal"],
      deviceName: "My Phone",
    });
    expect((await req("/auth/users/webauthn/credentials", { method: "GET" })).status).toBe(401);

    const res = await req("/auth/users/webauthn/credentials", authed(token, undefined, "GET"));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { id: string; device_name: string; transports: string[] }[];
    };
    expect(data).toHaveLength(1);
    expect(data[0]!.device_name).toBe("My Phone");
    expect(data[0]!.transports).toEqual(["internal"]);
    expect(JSON.stringify(data)).not.toContain("SECRET_KEY_MATERIAL");
  });

  it("delete removes an owned credential and 404s otherwise", async () => {
    const { col, userId, token } = await seedUser();
    insertCredential({
      id: "row-1",
      userId,
      collectionId: col.id,
      credentialId: "C1",
      publicKey: "K",
      counter: 0,
      transports: undefined,
      deviceName: null,
    });
    expect(
      (await req("/auth/users/webauthn/credentials/row-1", authed(token, undefined, "DELETE")))
        .status,
    ).toBe(200);
    expect(listCredentials(userId, col.id)).toHaveLength(0);
    // Second delete → 404.
    expect(
      (await req("/auth/users/webauthn/credentials/row-1", authed(token, undefined, "DELETE")))
        .status,
    ).toBe(404);
  });
});
