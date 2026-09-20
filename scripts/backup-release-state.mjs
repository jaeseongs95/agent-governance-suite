import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

/** Snapshot WAL-backed state without opening it through a migrating application store. */
export function backupReleaseState(source, destination) {
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);
  if (!existsSync(sourcePath)) throw new Error("The source database does not exist.");
  if (existsSync(destinationPath)) throw new Error("The backup destination must not exist.");
  mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  // VACUUM INTO accepts an empty file; exclusive creation preserves no-overwrite
  // and prevents a POSIX umask from exposing the snapshot during the write.
  closeSync(openSync(destinationPath, "wx", 0o600));
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.prepare("VACUUM INTO ?").run(destinationPath);
  } finally {
    database.close();
  }
  const backup = new DatabaseSync(destinationPath, { readOnly: true });
  try {
    const integrity = backup.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") throw new Error("Backup integrity check failed.");
    return { source: sourcePath, backup: destinationPath, integrity: "ok" };
  } finally {
    backup.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, destination, ...extra] = process.argv.slice(2);
  if (!source || !destination || extra.length) {
    throw new Error("Usage: node scripts/backup-release-state.mjs <source.sqlite3> <new-backup.sqlite3>");
  }
  console.log(JSON.stringify(backupReleaseState(source, destination)));
}
