import type { Database } from "bun:sqlite";
import { getDb } from "./client.ts";
import { COGWORKS_VERSION } from "../core/version.ts";

/**
 * Apply the schema. Runs on every boot: `CREATE TABLE IF NOT EXISTS` +
 * `addColumn` (idempotent) + the v0.11 data migration (idempotent). Wrapped in
 * a single transaction by `runMigrations`, so a crash or an unexpected error
 * mid-migration rolls the whole thing back rather than leaving a half-applied
 * schema — the process fails to start instead of running on a broken DB.
 */
export async function runMigrations() {
  const db = getDb();
  const client = (db as unknown as { $client: Database }).$client;
  client.transaction(() => applySchema(client))();
}

/** `ALTER TABLE … ADD COLUMN`, swallowing ONLY the "column already exists"
 *  error. A genuine failure (disk full, bad DDL, constraint) propagates and
 *  aborts the migration transaction instead of being silently ignored. */
function addColumn(client: Database, ddl: string): void {
  try {
    client.exec(ddl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate column name/i.test(msg)) return;
    throw e;
  }
}

/**
 * One-time rebrand migration (Vaultbase → Cogworks): on a DB created under the
 * old names, rename every internal table `vaultbase_*` → `cogworks_*` and every
 * user table `vb_<col>` → `cw_<col>`, and drop the old-named indexes so the
 * `CREATE INDEX IF NOT EXISTS` statements below recreate them under new names.
 *
 * Safe because the schema has no triggers and no real foreign keys, so a bare
 * `ALTER TABLE … RENAME` has no dependency graph to fix up. Runs FIRST, before
 * any `CREATE TABLE IF NOT EXISTS` — otherwise a freshly-created empty new table
 * would make the "new doesn't exist" guard false and orphan the real data.
 * Guarded + idempotent: on a fresh or already-renamed DB every guard is false →
 * whole pass is a no-op. Wrapped (with everything else) in one transaction by
 * `runMigrations`, so a crash rolls back to the old names.
 */
function migrateBrandRename(client: Database): void {
  const exists = (name: string): boolean =>
    !!client
      .prepare(`SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
      .get(name);

  // 1. Internal tables (the 26 schema tables + the two created only in this
  //    file). `users`/`schema` may be absent depending on prior version — guarded.
  const internal = [
    "collections",
    "users",
    "admin",
    "admin_sessions",
    "api_tokens",
    "audit_log",
    "auth_tokens",
    "feature_flags",
    "file_token_uses",
    "files",
    "flag_segments",
    "hooks",
    "jobs",
    "jobs_log",
    "login_failures",
    "mfa_recovery_codes",
    "mfa_recovery_lookup",
    "oauth_links",
    "record_history",
    "routes",
    "settings",
    "sql_queries",
    "token_revocations",
    "webhook_deliveries",
    "webhooks",
    "workers",
    "realtime_events",
    "schema",
  ];
  for (const base of internal) {
    if (exists(`vaultbase_${base}`) && !exists(`cogworks_${base}`)) {
      client.exec(`ALTER TABLE "vaultbase_${base}" RENAME TO "cogworks_${base}"`);
    }
  }

  // 2. User tables `vb_<col>` → `cw_<col>`, enumerated from the now-renamed
  //    collections table. Base/auth tables: bare RENAME (byte-identical, atomic).
  //    Views: the stored `view_query` references the old table names by text, so
  //    rewrite it and recreate the view under the new name (base tables already
  //    renamed above, so its refs resolve). Two conceptual passes, but base
  //    tables are all done in step 1's sibling loop before any view is rebuilt.
  if (exists("cogworks_collections")) {
    const cols = client
      .prepare(`SELECT name, type, view_query FROM cogworks_collections`)
      .all() as Array<{ name: string; type: string; view_query: string | null }>;
    // 2a. non-view tables first. Recreate the auth email index under the new
    //     name here (not via ensureAuthColumns, which only runs on collection
    //     create) so the UNIQUE-on-email constraint is never lost — the old
    //     idx_vb_* index survives the RENAME and is dropped in step 3.
    for (const c of cols) {
      if (c.type === "view") continue;
      if (exists(`vb_${c.name}`) && !exists(`cw_${c.name}`)) {
        client.exec(`ALTER TABLE "vb_${c.name}" RENAME TO "cw_${c.name}"`);
      }
      if (c.type === "auth" && exists(`cw_${c.name}`)) {
        client.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS "idx_cw_${c.name}_email" ON "cw_${c.name}"(email)`,
        );
      }
    }
    // 2b. views (all base tables now exist under cw_ names)
    for (const c of cols) {
      if (c.type !== "view" || !c.view_query) continue;
      const rewritten = c.view_query.replace(/\bvb_/g, "cw_").replace(/\bvaultbase_/g, "cogworks_");
      if (rewritten !== c.view_query) {
        client
          .prepare(`UPDATE cogworks_collections SET view_query = ? WHERE name = ?`)
          .run(rewritten, c.name);
      }
      client.exec(`DROP VIEW IF EXISTS "vb_${c.name}"`);
      client.exec(
        `CREATE VIEW IF NOT EXISTS "cw_${c.name}" AS ${rewritten.trim().replace(/;\s*$/, "")}`,
      );
    }
  }

  // 3. Old-named indexes survive a table RENAME under their old names; drop them
  //    so there are no `idx_vaultbase_*` / `idx_vb_*` leftovers. The internal
  //    indexes are recreated under new names by the CREATE INDEX IF NOT EXISTS
  //    block below; the user auth email index was already recreated in step 2a.
  const oldIdx = client
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='index'
       AND (name LIKE 'idx_vaultbase_%' OR name LIKE 'idx_vb_%')`,
    )
    .all() as Array<{ name: string }>;
  for (const { name } of oldIdx) client.exec(`DROP INDEX IF EXISTS "${name}"`);
}

function applySchema(client: Database): void {
  // Rebrand rename FIRST (no-op on fresh / already-renamed DBs).
  migrateBrandRename(client);

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'base',
      fields TEXT NOT NULL DEFAULT '[]',
      view_query TEXT,
      list_rule TEXT,
      view_rule TEXT,
      create_rule TEXT,
      update_rule TEXT,
      delete_rule TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  addColumn(
    client,
    `ALTER TABLE cogworks_collections ADD COLUMN type TEXT NOT NULL DEFAULT 'base'`,
  );
  addColumn(client, `ALTER TABLE cogworks_collections ADD COLUMN view_query TEXT`);
  addColumn(
    client,
    `ALTER TABLE cogworks_collections ADD COLUMN history_enabled INTEGER NOT NULL DEFAULT 0`,
  );

  // Drop legacy single-table records (replaced by per-collection tables)
  client.exec(`DROP TABLE IF EXISTS vaultbase_records`);

  // v0.11: `cogworks_users` is no longer the source of truth for auth
  // users — each auth collection has its own `cw_<name>` table with auth
  // columns inline. The CREATE block stays here only so v0.10 → v0.11
  // upgrades have a table to read from in `v0_11PrepAuthTables`. Once
  // every row is mirrored, `v0_11FinalizeAuthMigration` drops it.
  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_users (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      is_anonymous INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_auth_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code TEXT,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  addColumn(client, `ALTER TABLE cogworks_auth_tokens ADD COLUMN code TEXT`);
  addColumn(
    client,
    `ALTER TABLE cogworks_auth_tokens ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_auth_tokens_user ON cogworks_auth_tokens(user_id, purpose)`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_auth_tokens_code ON cogworks_auth_tokens(code, purpose)`,
  );

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_token_revocations (
      jti TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_token_revocations_exp ON cogworks_token_revocations(expires_at)`,
  );

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_mfa_recovery_lookup (
      hmac TEXT PRIMARY KEY,
      recovery_id TEXT NOT NULL
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_mfa_recovery_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_mfa_recovery_codes_user ON cogworks_mfa_recovery_codes(user_id, collection_id)`,
  );

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_webauthn_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      device_name TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_used_at INTEGER
    )
  `);
  client.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_cogworks_webauthn_credentials_credid ON cogworks_webauthn_credentials(credential_id)`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_webauthn_credentials_user ON cogworks_webauthn_credentials(user_id, collection_id)`,
  );

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_oauth_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      provider_email TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_cogworks_oauth_links_provider ON cogworks_oauth_links(provider, provider_user_id)`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_oauth_links_user ON cogworks_oauth_links(user_id)`,
  );

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_admin (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_reset_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  addColumn(
    client,
    `ALTER TABLE cogworks_admin ADD COLUMN password_reset_at INTEGER NOT NULL DEFAULT 0`,
  );
  try {
    client.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_cogworks_admin_email ON cogworks_admin(email)`,
    );
  } catch {
    /* exists */
  }

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_files (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Logs are now stored as JSONL files (see core/file-logger.ts).
  // Drop legacy DB-backed logs table if upgrading from an older install.
  client.exec(`DROP TABLE IF EXISTS cogworks_logs`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_hooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      collection_name TEXT NOT NULL DEFAULT '',
      event TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  // Idempotent ADD COLUMN for existing DBs
  addColumn(client, `ALTER TABLE cogworks_hooks ADD COLUMN name TEXT NOT NULL DEFAULT ''`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_routes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      cron TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'inline',
      last_run_at INTEGER,
      next_run_at INTEGER,
      last_status TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  // Idempotent ALTER: pre-existing installs missing the mode column
  addColumn(client, `ALTER TABLE cogworks_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'inline'`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_workers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      queue TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      concurrency INTEGER NOT NULL DEFAULT 1,
      retry_max INTEGER NOT NULL DEFAULT 3,
      retry_backoff TEXT NOT NULL DEFAULT 'exponential',
      retry_delay_ms INTEGER NOT NULL DEFAULT 1000,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_cogworks_workers_queue ON cogworks_workers(queue)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_jobs_log (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      worker_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      unique_key TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      scheduled_at INTEGER NOT NULL DEFAULT (unixepoch()),
      enqueued_at INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at INTEGER,
      finished_at INTEGER
    )
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_jobs_log_status ON cogworks_jobs_log(queue, status, scheduled_at)`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_jobs_log_unique ON cogworks_jobs_log(unique_key, status)`,
  );

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_record_history (
      id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      op TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      actor_id TEXT,
      actor_type TEXT,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_record_history_lookup ON cogworks_record_history(collection, record_id, at)`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_record_history_at ON cogworks_record_history(at)`,
  );

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_audit_log (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      actor_email TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      status INTEGER NOT NULL,
      ip TEXT,
      summary TEXT,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_audit_log_actor ON cogworks_audit_log(actor_id, at)`,
  );
  client.exec(`CREATE INDEX IF NOT EXISTS idx_cogworks_audit_log_at ON cogworks_audit_log(at)`);
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_audit_log_action ON cogworks_audit_log(action, at)`,
  );

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_admin_sessions (
      jti TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      admin_email TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT
    )
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_admin_sessions_admin ON cogworks_admin_sessions(admin_id)`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_admin_sessions_exp ON cogworks_admin_sessions(expires_at)`,
  );

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_login_failures (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      at INTEGER NOT NULL
    )
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_login_failures_key ON cogworks_login_failures(key, at)`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_login_failures_at ON cogworks_login_failures(at)`,
  );

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_webhooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      secret TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      retry_max INTEGER NOT NULL DEFAULT 3,
      retry_backoff TEXT NOT NULL DEFAULT 'exponential',
      retry_delay_ms INTEGER NOT NULL DEFAULT 1000,
      timeout_ms INTEGER NOT NULL DEFAULT 30000,
      custom_headers TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      response_status INTEGER,
      response_body TEXT,
      error TEXT,
      scheduled_at INTEGER NOT NULL,
      delivered_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_webhook_deliveries_status ON cogworks_webhook_deliveries(status, scheduled_at)`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_webhook_deliveries_webhook ON cogworks_webhook_deliveries(webhook_id, created_at)`,
  );

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_flag_segments (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      conditions TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_feature_flags (
      key TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'bool',
      enabled INTEGER NOT NULL DEFAULT 1,
      default_value TEXT NOT NULL DEFAULT 'false',
      variations TEXT NOT NULL DEFAULT '[]',
      rules TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_file_token_uses (
      jti TEXT PRIMARY KEY,
      used_at INTEGER NOT NULL,
      ip TEXT
    )
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_file_token_uses_used_at ON cogworks_file_token_uses(used_at)`,
  );

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_api_tokens (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      scopes           TEXT NOT NULL DEFAULT '[]',
      created_by       TEXT NOT NULL,
      created_by_email TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      expires_at       INTEGER NOT NULL,
      revoked_at       INTEGER,
      last_used_at     INTEGER,
      last_used_ip     TEXT,
      last_used_ua     TEXT,
      use_count        INTEGER NOT NULL DEFAULT 0
    )
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_api_tokens_created_by ON cogworks_api_tokens(created_by)`,
  );
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_api_tokens_expires ON cogworks_api_tokens(expires_at)`,
  );

  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_sql_queries (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      sql                TEXT NOT NULL,
      description        TEXT,
      owner_admin_id     TEXT NOT NULL,
      owner_admin_email  TEXT NOT NULL,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      last_run_at        INTEGER,
      last_run_ms        INTEGER,
      last_row_count     INTEGER,
      last_error         TEXT
    )
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_sql_queries_owner ON cogworks_sql_queries(owner_admin_id, updated_at DESC)`,
  );

  // ── Cross-worker realtime bus (cluster mode only) ─────────────────────────
  // Under `vaultbase cluster`, workers are separate processes with no shared
  // memory. A record/system broadcast delivers to the originating worker's own
  // WS/SSE subscribers AND appends the event here; every worker tails this
  // table (seq > lastSeen) and re-delivers to its local subscribers. Rows are
  // ephemeral — pruned by the leader shortly after. In single-process mode the
  // table is never written to or read.
  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_realtime_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      origin TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS idx_cogworks_realtime_events_created_at ON cogworks_realtime_events(created_at)`,
  );

  // ── v0.11: auth users moved to per-collection `cw_<auth-col>` tables ──
  //
  // Old model: every auth user lived in shared `cogworks_users` keyed by
  // `collection_id`. New model: each auth collection gets a real
  // `cw_<name>` table with auth columns inline. Migration: ALTER+COPY
  // first run (idempotent), then DROP `cogworks_users` once every row
  // has a home in its per-collection table.
  v0_11PrepAuthTables(client);
  v0_11FinalizeAuthMigration(client);

  // Record the server version that last applied the schema — informational,
  // for diagnostics (`SELECT * FROM cogworks_schema`). Stamped inside the
  // same transaction so it only lands when the migration fully succeeds.
  client.exec(`
    CREATE TABLE IF NOT EXISTS cogworks_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client
    .prepare(
      `INSERT INTO cogworks_schema (id, version) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = unixepoch()`,
    )
    .run(COGWORKS_VERSION);
}

/**
 * Drop `cogworks_users` once every row has been mirrored to a
 * `cw_<auth-col>` table. Runs after `v0_11PrepAuthTables`. Idempotent —
 * if the table is already gone the function returns immediately.
 *
 * Safety: refuses to drop if any row in `cogworks_users` is missing
 * from the corresponding per-collection table. Operator must run
 * `vaultbase doctor` and reconcile before the next boot.
 */
function v0_11FinalizeAuthMigration(client: Database): void {
  const exists = client
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cogworks_users'`)
    .get() as { name: string } | undefined;
  if (!exists) return;

  const total = (client.prepare(`SELECT count(*) AS n FROM cogworks_users`).get() as { n: number })
    .n;
  if (total === 0) {
    client.exec(`DROP TABLE cogworks_users`);
    return;
  }

  // Verify every row was copied. If any are missing, leave the legacy
  // table in place so the operator can re-run migration / fix data.
  const authCols = client
    .prepare(`SELECT id, name FROM cogworks_collections WHERE type='auth'`)
    .all() as Array<{ id: string; name: string }>;
  let copied = 0;
  for (const c of authCols) {
    const tbl = `cw_${c.name}`;
    const quoted = `"${tbl.replace(/"/g, '""')}"`;
    try {
      const matched = (
        client
          .prepare(
            `SELECT count(u.id) AS n FROM cogworks_users u
         JOIN ${quoted} v ON v.id = u.id
         WHERE u.collection_id = ?`,
          )
          .get(c.id) as { n: number }
      ).n;
      copied += matched;
    } catch {
      /* per-table query failed — be conservative, don't drop */ return;
    }
  }
  if (copied >= total) {
    client.exec(`DROP TABLE cogworks_users`);
  } else {
    process.stderr.write(
      `[vaultbase] WARN: cogworks_users still has ${total - copied} row(s) not yet ` +
        `mirrored to per-collection cw_<auth-col> tables. Run \`vaultbase doctor\` and ` +
        `reconcile before the next boot — the legacy table will not be dropped until clean.\n`,
    );
  }
}

/** Per-auth-collection table prep. Exported for the doctor CLI to dry-run. */
function v0_11PrepAuthTables(client: Database): void {
  // Skip entirely if cogworks_users doesn't exist yet (fresh install).
  const usersTableExists = client
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='cogworks_users'`)
    .get() as { name: string } | undefined;
  if (!usersTableExists) return;

  const authCols = client
    .prepare(`SELECT id, name, fields FROM cogworks_collections WHERE type='auth'`)
    .all() as Array<{ id: string; name: string; fields: string }>;

  for (const col of authCols) {
    const tbl = `cw_${col.name}`;
    const quoted = `"${tbl.replace(/"/g, '""')}"`;

    // 1. ALTER ADD auth columns (idempotent).
    const authColumns = [
      ["email", "TEXT"],
      ["password_hash", "TEXT"],
      ["email_verified", "INTEGER NOT NULL DEFAULT 0"],
      ["totp_secret", "TEXT"],
      ["totp_enabled", "INTEGER NOT NULL DEFAULT 0"],
      ["is_anonymous", "INTEGER NOT NULL DEFAULT 0"],
      ["password_reset_at", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, sql] of authColumns) {
      addColumn(client, `ALTER TABLE ${quoted} ADD COLUMN "${name}" ${sql}`);
    }

    // 2. ALTER ADD custom-field columns from the collection's `fields` JSON
    // (skip implicit + autodate). Idempotent.
    let fields: Array<{ name?: unknown; type?: unknown; implicit?: unknown; system?: unknown }> =
      [];
    try {
      fields = JSON.parse(col.fields || "[]") as typeof fields;
    } catch {
      /* skip */
    }
    for (const f of fields) {
      if (typeof f.name !== "string") continue;
      if (f.implicit || f.system || f.type === "autodate") continue;
      // SQL ident safety: collections.ts validated these at create time.
      const colName = `"${f.name.replace(/"/g, '""')}"`;
      let sqlType: string;
      switch (f.type) {
        case "number":
          sqlType = "REAL";
          break;
        case "bool":
          sqlType = "INTEGER";
          break;
        case "date":
          sqlType = "INTEGER";
          break;
        default:
          sqlType = "TEXT";
          break;
      }
      addColumn(client, `ALTER TABLE ${quoted} ADD COLUMN ${colName} ${sqlType}`);
    }

    // 3. Copy rows from cogworks_users into cw_<name>. INSERT OR IGNORE so
    // re-running on already-migrated installs is a no-op. The custom-column
    // values are pulled from the row's `data` JSON via json_extract.
    const customColNames = fields
      .filter(
        (f) => typeof f.name === "string" && !f.implicit && !f.system && f.type !== "autodate",
      )
      .map((f) => f.name as string);

    const insertCols = [
      "id",
      "email",
      "password_hash",
      "email_verified",
      "totp_secret",
      "totp_enabled",
      "is_anonymous",
      "created_at",
      "updated_at",
      ...customColNames,
    ];
    const insertColsList = insertCols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");

    // Build SELECT list. Custom cols come from json_extract on `data`.
    const selectExprs = [
      `id`,
      `email`,
      `password_hash`,
      `email_verified`,
      `totp_secret`,
      `totp_enabled`,
      `is_anonymous`,
      `created_at`,
      `updated_at`,
      ...customColNames.map((c) => `json_extract(data, '$."${c.replace(/"/g, '""')}"')`),
    ];
    const selectList = selectExprs.join(", ");

    const sql =
      `INSERT OR IGNORE INTO ${quoted} (${insertColsList}) ` +
      `SELECT ${selectList} FROM cogworks_users WHERE collection_id = ?`;
    try {
      client.prepare(sql).run(col.id);
    } catch (e) {
      process.stderr.write(
        `[vaultbase] WARN: v0.11 auth-table prep failed for collection '${col.name}': ` +
          `${e instanceof Error ? e.message : String(e)}\n`,
      );
    }

    // 4. UNIQUE index on email — collection-local. Skip silently if
    // duplicates exist (doctor will flag them).
    try {
      client.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_${tbl}_email" ON ${quoted}(email) WHERE email IS NOT NULL`,
      );
    } catch {
      /* duplicate emails — operator must reconcile via doctor */
    }
  }
}
