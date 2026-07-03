/**
 * Full-text search via SQLite FTS5.
 *
 * Each base/auth collection with one or more `searchable` text fields gets a
 * companion **external-content** FTS5 table `cw_<name>_fts` plus AFTER
 * INSERT/UPDATE/DELETE triggers on the `cw_<name>` base table. External-content
 * + triggers is the canonical FTS5 pattern:
 *   - the index stores no copy of the text (it reads from the base table),
 *   - sync is atomic with the row write (triggers fire in the same statement),
 *   - it catches EVERY write path — HTTP, batch, CSV, MCP, cascade — with zero
 *     record-layer code.
 *
 * Search is exposed as a `search=` param on the list endpoint, mapped to an
 * FTS5 `MATCH` in `listRecords` (see `ftsMatchPredicate` / `sanitizeFtsQuery`).
 *
 * `searchable` is a brand-new opt-in field flag, so no existing collection has
 * it set — the FTS companion is created/torn down purely at the collection
 * lifecycle points (create/update/delete) in `collections.ts`. No boot-time
 * reconciler is needed.
 */
import type { Database } from "bun:sqlite";
import { getDb } from "../db/client.ts";
import { type FieldDef, userTableName, assertSqlIdent } from "./collections.ts";

/** Field types whose text is worth indexing for full-text search. */
const FTS_INDEXABLE_TYPES = new Set<string>(["text", "email", "url", "editor"]);

/** Cap on distinct search terms per query — bounds MATCH cost. */
const MAX_SEARCH_TERMS = 32;

function rawClient(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

/** SQLite identifier quoting that escapes embedded `"` (DDL-safe). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** SQLite string-literal quoting that escapes embedded `'`. */
function quoteStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The searchable text fields on a collection (opt-in flag ∧ indexable type). */
export function searchableFields(fields: FieldDef[]): FieldDef[] {
  return fields.filter(
    (f) => !f.system && f.options?.searchable === true && FTS_INDEXABLE_TYPES.has(f.type),
  );
}

/** Whether a collection has any full-text-searchable fields. */
export function hasSearchable(fields: FieldDef[]): boolean {
  return searchableFields(fields).length > 0;
}

/** Companion FTS5 table name for a collection. */
export function ftsTableName(collectionName: string): string {
  return `cw_${collectionName}_fts`;
}

/** Drop the FTS table + its sync triggers (idempotent, safe on views). */
export function dropFts(collectionName: string): void {
  assertSqlIdent(collectionName, "collection");
  const client = rawClient();
  const base = userTableName(collectionName);
  for (const suffix of ["ai", "au", "ad"]) {
    client.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(`${base}_fts_${suffix}`)}`);
  }
  client.exec(`DROP TABLE IF EXISTS ${quoteIdent(ftsTableName(collectionName))}`);
}

/**
 * Reconcile the FTS companion for a collection to match its current searchable
 * fields. Always drops any existing FTS table + triggers first, then — if there
 * are searchable fields and this isn't a view — recreates the table + triggers
 * and backfills existing rows via the FTS5 `'rebuild'` command.
 *
 * Idempotent and cheap enough to call on every schema change; recreating beats
 * diffing the FTS column set. Views tear the index down only (no base table to
 * trigger on).
 *
 * NOTE: callers that also run `ALTER TABLE ... DROP COLUMN` must call `dropFts`
 * BEFORE the ALTER — SQLite refuses to drop a column a trigger references.
 */
export function syncFts(collectionName: string, fields: FieldDef[], type: string): void {
  assertSqlIdent(collectionName, "collection");
  dropFts(collectionName);
  if (type === "view") return;
  const cols = searchableFields(fields);
  if (cols.length === 0) return;

  const client = rawClient();
  const base = userTableName(collectionName);
  const baseRef = quoteIdent(base);
  const ftsRef = quoteIdent(ftsTableName(collectionName));
  const colIdents = cols.map((f) => quoteIdent(f.name));
  const colList = colIdents.join(", ");
  const newList = colIdents.map((c) => `new.${c}`).join(", ");
  const oldList = colIdents.map((c) => `old.${c}`).join(", ");

  // External-content FTS5: the index reads text from the base table;
  // content_rowid defaults to the base table's implicit rowid. `unicode61`
  // with diacritic folding gives accent-insensitive matching.
  client.exec(
    `CREATE VIRTUAL TABLE ${ftsRef} USING fts5(` +
      `${colList}, content=${quoteStr(base)}, tokenize='unicode61 remove_diacritics 2')`,
  );
  // Keep the index in lockstep. For external-content tables the 'delete'
  // command retracts the OLD row's terms (it needs the old column values).
  client.exec(
    `CREATE TRIGGER ${quoteIdent(`${base}_fts_ai`)} AFTER INSERT ON ${baseRef} BEGIN\n` +
      `  INSERT INTO ${ftsRef}(rowid, ${colList}) VALUES (new.rowid, ${newList});\n` +
      `END`,
  );
  client.exec(
    `CREATE TRIGGER ${quoteIdent(`${base}_fts_ad`)} AFTER DELETE ON ${baseRef} BEGIN\n` +
      `  INSERT INTO ${ftsRef}(${ftsRef}, rowid, ${colList}) VALUES ('delete', old.rowid, ${oldList});\n` +
      `END`,
  );
  client.exec(
    `CREATE TRIGGER ${quoteIdent(`${base}_fts_au`)} AFTER UPDATE ON ${baseRef} BEGIN\n` +
      `  INSERT INTO ${ftsRef}(${ftsRef}, rowid, ${colList}) VALUES ('delete', old.rowid, ${oldList});\n` +
      `  INSERT INTO ${ftsRef}(rowid, ${colList}) VALUES (new.rowid, ${newList});\n` +
      `END`,
  );
  // Backfill existing rows straight from the content table.
  client.exec(`INSERT INTO ${ftsRef}(${ftsRef}) VALUES ('rebuild')`);
}

/**
 * SQL predicate + bound param for a full-text `search=` query, or null when the
 * collection has no searchable fields (caller decides what "no index" means).
 *
 * Returns a `rowid IN (SELECT rowid FROM <fts> WHERE <fts> MATCH ?)` fragment —
 * co-located by rowid with the base table, parameterized, and composable with
 * the existing filter/rule WHERE parts + pagination.
 */
export function ftsMatchPredicate(
  collectionName: string,
  fields: FieldDef[],
  tableRef: string,
  rawQuery: string,
): { sql: string; param: string } | null {
  if (!hasSearchable(fields)) return null;
  const ftsRef = quoteIdent(ftsTableName(collectionName));
  return {
    sql: `${tableRef}.rowid IN (SELECT rowid FROM ${ftsRef} WHERE ${ftsRef} MATCH ?)`,
    param: sanitizeFtsQuery(rawQuery),
  };
}

/**
 * Turn arbitrary user input into a safe FTS5 MATCH string.
 *
 * Splits into terms and wraps each as a double-quoted phrase (AND-combined by
 * whitespace). This neutralizes ALL FTS5 operator syntax — column filters
 * (`col:x`), boolean ops, `-`/`^`/`*`, parens, stray quotes — so arbitrary
 * input can never raise an FTS syntax error (→ 500) or reach across columns.
 */
export function sanitizeFtsQuery(input: string): string {
  const terms = input.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}
