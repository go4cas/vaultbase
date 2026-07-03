import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { Hono } from "hono";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { requireAdmin } from "../core/sec.ts";
import { snapshotDb } from "../core/backup-snapshot.ts";

// SQLite magic header — used to verify uploads
const SQLITE_MAGIC = "SQLite format 3\0";

export function makeBackupPlugin(jwtSecret: string, dbPath: string) {
  return (
    new Hono()
      .get("/admin/backup", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }
        if (!existsSync(dbPath)) {
          return c.json({ error: "Database file not found", code: 404 }, 404);
        }
        // Consistent snapshot via VACUUM INTO (WAL merged, never torn) rather
        // than streaming the live file. Stream the temp snapshot straight from
        // disk (bounded memory) and delete it once the response finishes.
        let snap: string;
        try {
          snap = await snapshotDb(dbPath);
        } catch (e) {
          return c.json({ error: `Snapshot failed: ${(e as Error).message}`, code: 500 }, 500);
        }
        let size = 0;
        try {
          size = statSync(snap).size;
        } catch {
          /* stat best-effort */
        }
        const cleanup = () => {
          try {
            rmSync(snap);
          } catch {
            /* already gone / removed by a later sweep */
          }
        };
        const reader = Bun.file(snap).stream().getReader();
        const stream = new ReadableStream<Uint8Array>({
          async pull(ctrl) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                ctrl.close();
                cleanup();
                return;
              }
              ctrl.enqueue(value);
            } catch (e) {
              cleanup();
              ctrl.error(e);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } catch {
              /* ignore */
            }
            cleanup();
          },
        });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const headers: Record<string, string> = {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="cogworks-backup-${stamp}.db"`,
        };
        if (size > 0) headers["Content-Length"] = String(size);
        return new Response(stream, { headers });
      })

      // Restore from uploaded SQLite file
      .post("/admin/restore", async (c) => {
        if (!(await requireAdmin(c.req.raw, jwtSecret))) {
          return c.json({ error: "Unauthorized", code: 401 }, 401);
        }

        const formData = await c.req.raw.formData();
        const file = formData.get("file");
        if (!(file instanceof File)) {
          return c.json(
            { error: "No file uploaded (expected multipart 'file' field)", code: 400 },
            400,
          );
        }

        // Magic header check
        const sliced = file.slice(0, SQLITE_MAGIC.length);
        const header = sliced instanceof Blob ? await sliced.text() : String(sliced);
        if (header !== SQLITE_MAGIC) {
          return c.json({ error: "File is not a valid SQLite database", code: 422 }, 422);
        }

        // Write to a staging path next to the live DB
        const staging = `${dbPath}.restore`;
        await Bun.write(staging, file);

        // Close current DB so we can replace the file on Windows
        try {
          closeDb();
        } catch {
          /* ignore */
        }

        try {
          // Replace live DB with uploaded copy
          if (existsSync(dbPath)) {
            // remove sidecar files (WAL/SHM) so SQLite doesn't get confused
            for (const sfx of ["-shm", "-wal"]) {
              const sidecar = `${dbPath}${sfx}`;
              if (existsSync(sidecar)) {
                try {
                  (await import("node:fs")).rmSync(sidecar);
                } catch {
                  /* ignore */
                }
              }
            }
            renameSync(dbPath, `${dbPath}.bak.${Date.now()}`);
          }
          renameSync(staging, dbPath);
        } catch (e) {
          // Re-init the original DB to keep the server alive
          initDb(`file:${dbPath}`);
          await runMigrations();
          return c.json(
            {
              error: `Restore failed: ${e instanceof Error ? e.message : String(e)}`,
              code: 500,
            },
            500,
          );
        }

        // Re-open and verify schema
        initDb(`file:${dbPath}`);
        await runMigrations();

        return c.json({ data: { message: "Restore complete. Existing tokens are still valid." } });
      })
  );
}
