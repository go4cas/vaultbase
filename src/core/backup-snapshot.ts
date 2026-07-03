import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

/**
 * Consistent point-in-time SQLite snapshot via `VACUUM INTO`.
 *
 * Opens the source READ-ONLY and writes a fresh, self-contained `.db` holding
 * all *committed* state — including un-checkpointed WAL pages — with no
 * `-wal`/`-shm` sidecars. SQLite serialises VACUUM against the writer, so the
 * copy is never torn (unlike streaming the live `.db` file, which can miss
 * recent WAL commits or read a half-written page).
 *
 * A separate read-only connection is safe alongside the server's live
 * connection (WAL allows concurrent readers). Returns the temp snapshot path;
 * the CALLER is responsible for deleting it.
 */
export async function snapshotDb(dbPath: string): Promise<string> {
  if (!existsSync(dbPath)) throw new Error(`source DB not found: ${dbPath}`);
  // Temp beside the source → same filesystem (cheap rename / no cross-device copy).
  const tmp = `${dirname(dbPath)}/.cogworks-snap-${process.pid}-${Date.now()}.db`;
  const db = new Database(dbPath, { readonly: true });
  try {
    // SQLite escapes single quotes by doubling.
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return tmp;
}
