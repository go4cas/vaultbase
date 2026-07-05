/**
 * Auth-collection user storage helpers.
 *
 * Each auth collection gets a per-collection `cw_<name>` table with the auth
 * columns inline + typed custom-field columns (custom fields are real columns,
 * not a JSON blob). The old v0.10 shared `cogworks_users` table was dropped in
 * the v0.11 migration; these helpers read/write `cw_<name>` only.
 *
 * Every helper is keyed by `collectionName` so the SQL targets the right
 * per-collection table.
 */

import type { Database } from "bun:sqlite";
import { getRawClient } from "../db/client.ts";
import { userTableName } from "./collections.ts";
import type { Collection } from "../db/schema.ts";

/** Auth-system columns guaranteed to exist on every `cw_<auth-col>`. */
export const AUTH_USER_COLUMNS = [
  "id",
  "email",
  "password_hash",
  "email_verified",
  "totp_secret",
  "totp_enabled",
  "is_anonymous",
  "password_reset_at",
  "created_at",
  "updated_at",
] as const;

/**
 * Shape returned by user-row reads. Custom fields appear as additional
 * keys; consumers should access them via the row's untyped record shape
 * since field names are user-defined.
 */
export interface AuthUserRow {
  id: string;
  email: string;
  password_hash: string;
  email_verified: number;
  totp_secret: string | null;
  totp_enabled: number;
  is_anonymous: number;
  password_reset_at: number;
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

function rawClient(): Database {
  return getRawClient();
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Find a user by id, scoped to a collection. Reads `cw_<name>` only —
 * `cogworks_users` was dropped in v0.11 phase 4.
 */
export function findUserById(col: Collection, id: string): AuthUserRow | null {
  const tname = quoteIdent(userTableName(col.name));
  try {
    const row = rawClient().prepare(`SELECT * FROM ${tname} WHERE id = ?`).get(id) as
      | AuthUserRow
      | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** Find a user by email within a collection. */
export function findUserByEmail(col: Collection, email: string): AuthUserRow | null {
  const tname = quoteIdent(userTableName(col.name));
  try {
    const row = rawClient().prepare(`SELECT * FROM ${tname} WHERE email = ?`).get(email) as
      | AuthUserRow
      | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Pull the canonical column list for an auth-collection table.
 * Recomputed each call — PRAGMA table_info is cheap and caching across
 * test-suite DB resets caused stale-table errors.
 */
export function tableColumns(collectionName: string): string[] {
  const rows = rawClient()
    .prepare(`PRAGMA table_info(${quoteIdent(userTableName(collectionName))})`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

interface InsertInput {
  id: string;
  email: string;
  password_hash: string;
  email_verified?: number;
  totp_secret?: string | null;
  totp_enabled?: number;
  is_anonymous?: number;
  password_reset_at?: number;
  /** Custom-field values keyed by field name (typed per the collection schema). */
  custom?: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

/**
 * Insert into `cw_<name>` only. Custom fields land as real columns
 * whitelisted against the per-collection table schema.
 */
export async function insertUser(col: Collection, input: InsertInput): Promise<void> {
  const tname = quoteIdent(userTableName(col.name));
  const cols = tableColumns(col.name);

  const insertCols: string[] = [];
  const placeholders: string[] = [];
  const values: unknown[] = [];

  const known: Record<string, unknown> = {
    id: input.id,
    email: input.email,
    password_hash: input.password_hash,
    email_verified: input.email_verified ?? 0,
    totp_secret: input.totp_secret ?? null,
    totp_enabled: input.totp_enabled ?? 0,
    is_anonymous: input.is_anonymous ?? 0,
    password_reset_at: input.password_reset_at ?? 0,
    created_at: input.created_at,
    updated_at: input.updated_at,
  };
  for (const [k, v] of Object.entries(known)) {
    if (cols.includes(k)) {
      insertCols.push(quoteIdent(k));
      placeholders.push("?");
      values.push(v as never);
    }
  }
  // Custom fields — only those present in the table schema.
  if (input.custom) {
    for (const [k, v] of Object.entries(input.custom)) {
      if (cols.includes(k)) {
        insertCols.push(quoteIdent(k));
        placeholders.push("?");
        values.push(v as never);
      }
    }
  }

  rawClient()
    .prepare(`INSERT INTO ${tname} (${insertCols.join(", ")}) VALUES (${placeholders.join(", ")})`)
    .run(...(values as never[]));
}

/**
 * Update by id on `cw_<name>`. Whitelists keys against the per-collection
 * table schema; unknown keys are silently ignored.
 */
export async function updateUserById(
  col: Collection,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const tname = quoteIdent(userTableName(col.name));
  const cols = tableColumns(col.name);

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (cols.includes(k)) {
      sets.push(`${quoteIdent(k)} = ?`);
      vals.push(v as never);
    }
  }
  if (sets.length > 0) {
    rawClient()
      .prepare(`UPDATE ${tname} SET ${sets.join(", ")} WHERE id = ?`)
      .run(...(vals as never[]), id);
  }
}

/** Delete a user from `cw_<name>` by id. */
export function deleteUserById(col: Collection, id: string): void {
  const tname = quoteIdent(userTableName(col.name));
  try {
    rawClient().prepare(`DELETE FROM ${tname} WHERE id = ?`).run(id);
  } catch {
    /* table missing or row absent */
  }
}
