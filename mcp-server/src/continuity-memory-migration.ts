import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { ContinuityMemoryBodyV1, LegacyContinuitySnapshotV1 } from "../../contracts/types.js";
import { WorkflowContractError } from "../../contracts/types.js";
import { convergenceDigest } from "./convergence-logic.js";
import { serializeContinuityMemory } from "./continuity-memory.js";
import { SqliteContinuityStore, continuityUnavailableReason, type ContinuityMemoryMigration } from "./continuity-store.js";
import { failureReason } from "./failure-diagnostics.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

class MigrationCliError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function existingDatabase(input: string): string {
  if (!path.isAbsolute(input)) throw new MigrationCliError("DATABASE_PATH_NOT_ABSOLUTE");
  const resolved = realpathSync(input);
  if (!statSync(resolved).isFile()) throw new MigrationCliError("DATABASE_NOT_FILE");
  return resolved;
}

/** This preflight cannot create a missing database or read migrated memory/history. */
function legacyDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON; BEGIN;");
    const { user_version: version } = database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version === 4) throw new MigrationCliError("ALREADY_MIGRATED");
    if (![1, 2, 3].includes(version)) throw new MigrationCliError("UNSUPPORTED_SCHEMA");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function validateMemory(value: unknown, allowOversized: boolean): ContinuityMemoryBodyV1 {
  try {
    serializeContinuityMemory(value as ContinuityMemoryBodyV1);
  } catch (error) {
    // Export preserves a valid large body for human optimization; apply never truncates or empties it.
    const oversized = error instanceof WorkflowContractError && error.details?.reasonCode === "CONTINUITY_MEMORY_TOO_LARGE";
    if (!oversized) throw new MigrationCliError("INVALID_MEMORY");
    if (!allowOversized) throw new MigrationCliError("MEMORY_TOO_LARGE");
  }
  return value as ContinuityMemoryBodyV1;
}

function readMappings(file: string): ContinuityMemoryMigration[] {
  const raw = readFileSync(file, "utf8");
  let input: unknown;
  try { input = JSON.parse(raw) as unknown; }
  catch { throw new MigrationCliError("INVALID_MAPPING_JSON"); }
  if (!Array.isArray(input)) throw new MigrationCliError("INVALID_MAPPING");
  const seen = new Set<string>();
  return input.map((item: unknown) => {
    if (!exactObject(item, ["taskCorrelation", "expectedSnapshotDigest", "memory"])
      || typeof item.taskCorrelation !== "string" || item.taskCorrelation.length === 0 || item.taskCorrelation.length > 256
      || typeof item.expectedSnapshotDigest !== "string" || !DIGEST.test(item.expectedSnapshotDigest)) {
      throw new MigrationCliError("INVALID_MAPPING");
    }
    if (seen.has(item.taskCorrelation)) throw new MigrationCliError("DUPLICATE_MAPPING");
    seen.add(item.taskCorrelation);
    return { taskCorrelation: item.taskCorrelation, expectedSnapshotDigest: item.expectedSnapshotDigest,
      memory: validateMemory(item.memory, false) };
  });
}

/** One-time administrative export. The file becomes historical after apply and must leave agent access then. */
function exportCurrent(databasePath: string, output: string): number {
  const database = legacyDatabase(databasePath);
  let mappings: ContinuityMemoryMigration[];
  try {
    const rows = database.prepare(`
      SELECT snapshots.task_correlation, snapshots.epoch, snapshots.revision,
             snapshots.snapshot_digest, snapshots.snapshot_json
      FROM continuity_snapshots snapshots
      JOIN continuity_tasks tasks ON tasks.task_correlation = snapshots.task_correlation
        AND tasks.current_epoch = snapshots.epoch
      ORDER BY snapshots.task_correlation
    `).all() as Array<{ task_correlation: string; epoch: number; revision: number; snapshot_digest: string; snapshot_json: string }>;
    mappings = rows.map(row => {
      let snapshot: LegacyContinuitySnapshotV1;
      try { snapshot = JSON.parse(row.snapshot_json) as LegacyContinuitySnapshotV1; }
      catch { throw new MigrationCliError("INVALID_LEGACY_CURRENT"); }
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new MigrationCliError("INVALID_LEGACY_CURRENT");
      const { snapshotDigest, ...base } = snapshot;
      if (snapshot.schemaVersion !== "1.0.0" || snapshot.source !== "direct"
        || snapshot.taskCorrelation !== row.task_correlation || snapshot.epoch !== row.epoch || snapshot.revision !== row.revision
        || !DIGEST.test(row.snapshot_digest) || snapshotDigest !== row.snapshot_digest || convergenceDigest(base) !== snapshotDigest) {
        throw new MigrationCliError("INVALID_LEGACY_CURRENT");
      }
      return { taskCorrelation: row.task_correlation, expectedSnapshotDigest: row.snapshot_digest,
        memory: validateMemory({ status: snapshot.status, core: snapshot.core, evidenceRefs: snapshot.evidenceRefs }, true) };
    });
  } finally {
    database.close();
  }
  writeFileSync(output, `${JSON.stringify(mappings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return mappings.length;
}

/** No default database path: every mutation needs an explicit existing file and prepared bounded mappings. */
export function runContinuityMemoryMigrationCli(args: string[]): { ok: true; code: string; count: number } {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true,
      options: { database: { type: "string" }, output: { type: "string" }, mapping: { type: "string" } } });
  } catch { throw new MigrationCliError("INVALID_ARGUMENTS"); }
  const [operation] = parsed.positionals;
  const { database, output, mapping } = parsed.values;
  if (parsed.positionals.length !== 1 || typeof database !== "string" || !database
    || (operation !== "export-current" && operation !== "apply")
    || (operation === "export-current" ? typeof output !== "string" || !output || mapping !== undefined
      : typeof mapping !== "string" || !mapping || output !== undefined)) throw new MigrationCliError("INVALID_ARGUMENTS");
  const databasePath = existingDatabase(database);
  if (operation === "export-current") {
    return { ok: true, code: "EXPORTED_CURRENT", count: exportCurrent(databasePath, output as string) };
  }
  const migrations = readMappings(mapping as string);
  const preflight = legacyDatabase(databasePath);
  preflight.close();
  // Hosts must be stopped by the operator. Recheck existence before the constructor's migration transaction.
  existingDatabase(databasePath);
  const store = new SqliteContinuityStore(databasePath, migrations);
  try {
    if (store.getSchemaVersion() !== 4) throw new MigrationCliError("MIGRATION_INCOMPLETE");
  } finally {
    store.close();
  }
  return { ok: true, code: "MIGRATED", count: migrations.length };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(runContinuityMemoryMigrationCli(process.argv.slice(2)))}\n`);
  } catch (error) {
    // Administrative files, memory contents and raw errors must never appear in console output.
    const reason = error instanceof MigrationCliError ? error.reason
      : failureReason(error).reason ?? continuityUnavailableReason(error);
    process.stdout.write(`${JSON.stringify({ ok: false, code: "MIGRATION_CLI_FAILED", reason })}\n`);
    process.exitCode = 1;
  }
}
