// Holds a SQLite write lock (BEGIN IMMEDIATE) on the given DB for <ms>, then commits.
import { DatabaseSync } from "node:sqlite";
const [db, ms] = [process.argv[2], Number(process.argv[3])];
const d = new DatabaseSync(db); d.exec("PRAGMA busy_timeout = 10000"); d.exec("BEGIN IMMEDIATE");
process.stdout.write("LOCKED\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
d.exec("COMMIT"); d.close(); process.stdout.write("RELEASED\n");
