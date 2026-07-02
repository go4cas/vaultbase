import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, getDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { VAULTBASE_VERSION } from "../core/version.ts";

function rawClient(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

describe("runMigrations", () => {
  beforeEach(() => initDb(":memory:"));
  afterEach(() => closeDb());

  it("runs twice without error (idempotent) and stamps the schema version", async () => {
    await runMigrations();
    // Second run must be a no-op — CREATE IF NOT EXISTS + addColumn (duplicate
    // column swallowed) + idempotent data migration — not throw.
    await runMigrations();

    const client = rawClient();
    const stamp = client.prepare(`SELECT version FROM vaultbase_schema WHERE id = 1`).get() as {
      version: string;
    } | null;
    expect(stamp?.version).toBe(VAULTBASE_VERSION);

    // A representative core table exists and is usable.
    const table = client
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get("vaultbase_collections");
    expect(table).toBeTruthy();
  });

  it("applies atomically — vaultbase_schema is only present after a full run", async () => {
    // Before migrating, the stamp table doesn't exist; after, it does. (The
    // whole apply runs in one transaction, so a failure would leave neither.)
    const client = rawClient();
    const before = client
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vaultbase_schema'`)
      .get();
    expect(before).toBeFalsy();

    await runMigrations();

    const after = client
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vaultbase_schema'`)
      .get();
    expect(after).toBeTruthy();
  });
});
