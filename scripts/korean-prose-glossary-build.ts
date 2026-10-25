import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { tagProducerFailure } from "../mcp-server/src/failure-diagnostics.js";

type BuildIo = Pick<typeof fs, "mkdir" | "mkdtemp" | "rename" | "copyFile" | "rm" | "rmdir">
  & { lstat: (target: string) => Promise<{ isFile(): boolean }> };
function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/** Offline maintenance only. The lock serializes cooperating builders; stale locks require manual review. */
export async function buildGlossaryWithRecovery<T>(
  databasePath: string,
  buildAndCheck: (stagedPath: string) => T | Promise<T>,
  io: BuildIo = fs,
): Promise<T> {
  await io.mkdir(path.dirname(databasePath), { recursive: true });
  const lockPath = databasePath + ".build-lock";
  await io.mkdir(lockPath); // Exclusive: never remove a lock acquired by another invocation.
  let transactionPath: string | null = null;
  let stagedPath: string | null = null;
  let backupPath: string | null = null;
  let validated = false;
  let previousMoved = false;
  let published = false;
  let restored = false;
  let removed = false;
  const errors: unknown[] = [];
  let validatedResult!: T;
  try {
    transactionPath = await io.mkdtemp(databasePath + ".build-");
    stagedPath = path.join(transactionPath, "validated.sqlite3");
    backupPath = path.join(transactionPath, "previous.sqlite3");
    validatedResult = await buildAndCheck(stagedPath);
    validated = true;
    try {
      const previous = await io.lstat(databasePath);
      if (!previous.isFile()) throw new Error("Glossary build destination must be a regular file.");
      await io.rename(databasePath, backupPath);
      previousMoved = true;
      // Also reject a changed destination type captured between lstat and rename.
      if (!(await io.lstat(backupPath)).isFile()) throw new Error("Glossary backup must remain a regular file.");
    } catch (error) {
      if (previousMoved || !missing(error)) throw error;
    }
    await io.rename(stagedPath, databasePath);
    published = true;
  } catch (error) {
    errors.push(error);
    if (previousMoved && !published && backupPath) {
      try {
        // Exclusive restore leaves any newly created destination untouched and keeps the backup.
        await io.copyFile(backupPath, databasePath, constants.COPYFILE_EXCL);
        restored = true;
      } catch (recoveryError) {
        if (recoveryError instanceof Error) tagProducerFailure(recoveryError, "GLOSSARY_RESTORE_FAILED");
        errors.push(recoveryError);
      }
    }
  } finally {
    // Validated unpublished data is recovery material, including when moving the old file failed.
    if (transactionPath && (!validated || published)) {
      try { await io.rm(transactionPath, { recursive: true }); removed = true; }
      catch (cleanupError) {
        if (cleanupError instanceof Error) tagProducerFailure(cleanupError, "GLOSSARY_TRANSACTION_CLEANUP_FAILED");
        errors.push(cleanupError);
      }
    }
    try { await io.rmdir(lockPath); }
    catch (lockError) {
      if (lockError instanceof Error) tagProducerFailure(lockError, "GLOSSARY_LOCK_CLEANUP_FAILED");
      errors.push(lockError);
    }
  }
  if (errors.length) {
    throw Object.assign(new AggregateError(errors, published
      ? "Glossary database published; cleanup incomplete; inspect recovery metadata before retrying."
      : "Glossary build failed; inspect recovery metadata before retrying.", { cause: errors[0] }), {
      code: published ? "GLOSSARY_CLEANUP_INCOMPLETE" : "GLOSSARY_BUILD_FAILED",
      recovery: {
        lockPath,
        transactionPath: removed ? null : transactionPath,
        stagedPath: !removed && !published ? stagedPath : null,
        backupPath: !removed && previousMoved ? backupPath : null,
        validated, previousMoved, published, restored,
      },
    });
  }
  return validatedResult;
}
