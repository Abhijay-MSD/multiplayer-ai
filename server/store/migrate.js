// Schema versions for the SQLite file. The version lives in the file itself
// (PRAGMA user_version). On open:
//
//   * a new file gets every migration; there is nothing to back up;
//   * a file already at the newest version is left alone;
//   * a file older than the code is copied to a backup first (VACUUM INTO, a
//     consistent snapshot even while another process writes), then migrated one
//     version at a time, each in its own transaction. A migration that fails is
//     rolled back and the backup stays;
//   * a file NEWER than the code is refused. Opening it with older code could
//     lose data, so nothing is changed.
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);
export const BACKUPS_KEPT = 3;

/** The built-in migrations: [{ version, name, sql }] in order. */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .map((f) => /^(\d+)_.+\.sql$/.exec(f))
    .filter(Boolean)
    .map((m) => ({ version: Number(m[1]), name: m[0], sql: fs.readFileSync(new URL(m[0], dir), "utf8") }))
    .sort((a, b) => a.version - b.version);
}

const userVersion = (db) => db.prepare("PRAGMA user_version").get().user_version;

export class MigrationError extends Error {}

/**
 * Brings `db` (an open node:sqlite DatabaseSync) up to the newest of `migrations`.
 * `file` is its path, or ":memory:". Returns { from, to, backup } (backup is a path or null).
 */
export function migrate(db, { file, migrations = loadMigrations(), stamp = () => new Date(), keep = BACKUPS_KEPT } = {}) {
  const newest = migrations.at(-1)?.version ?? 0;
  const from = userVersion(db);

  if (from > newest) {
    throw new MigrationError(
      `This data file was written by a newer version of Multiplayer AI (schema ${from}; this copy understands up to ${newest}). ` +
        "Nothing was changed. Update Multiplayer AI, or point MULTIPLAYER_AI_DATA_DIR at a different folder."
    );
  }
  const hasTables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0;
  if (from === 0 && hasTables) {
    throw new MigrationError("This file already has tables but no Multiplayer AI schema version, so it is not a Multiplayer AI data file. Nothing was changed.");
  }
  const pending = migrations.filter((m) => m.version > from);
  if (!pending.length) return { from, to: from, backup: null };

  let backup = null;
  if (from > 0 && file && file !== ":memory:") {
    backup = backupFile(db, file, from, stamp(), keep);
  }

  for (const m of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Another copy of the app may have opened the same new file a moment ago and
      // applied this one while we waited for the lock. Look again, now that we hold it.
      if (userVersion(db) >= m.version) {
        db.exec("COMMIT");
        continue;
      }
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${Number(m.version)}`);
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // the transaction was already gone
      }
      throw new MigrationError(
        `Updating the data file to schema ${m.version} (${m.name}) failed: ${e.message}. ` +
          (backup ? `Nothing was changed; your data from before is in ${backup}.` : "Nothing was changed.")
      );
    }
  }
  return { from, to: newest, backup };
}

function backupFile(db, file, version, when, keep) {
  const stampText = when.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const target = `${file}.bak-v${version}-${stampText}`;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);

  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-v`;
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return target;
}
