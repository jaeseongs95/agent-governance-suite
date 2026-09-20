import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { backupReleaseState } from "../scripts/backup-release-state.mjs";

it("backs up a live WAL database and refuses to overwrite an existing backup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-release-backup-"));
  const source = path.join(directory, "source.sqlite3");
  const destination = path.join(directory, "backup.sqlite3");
  const database = new DatabaseSync(source);
  try {
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO records VALUES (1, 'preserved')");
    expect(backupReleaseState(source, destination).integrity).toBe("ok");
    database.exec("INSERT INTO records VALUES (2, 'after-backup')");
    const restored = new DatabaseSync(destination, { readOnly: true });
    try {
      expect(restored.prepare("SELECT * FROM records").all()).toEqual([{ id: 1, value: "preserved" }]);
    } finally { restored.close(); }
    expect(() => backupReleaseState(source, destination)).toThrow(/must not exist/u);
    expect(database.prepare("SELECT count(*) AS count FROM records").get().count).toBe(2);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
