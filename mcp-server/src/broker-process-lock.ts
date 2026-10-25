import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface BrokerProcessLock {
  readonly path: string;
  readonly owner: string;
}
const OWNER = /^owner-([1-9][0-9]*)-([a-f0-9]{32})$/u;
const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

function unavailable(reason: string, cause?: unknown): never {
  throw Object.assign(new Error("Broker lock state requires inspection: " + reason + ".", { cause }),
    { code: "BROKER_LOCK_" + reason });
}

/** Only ESRCH proves absence. EPERM preserves a present/inaccessible contender. */
function definitelyGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if (code(error) === "ESRCH") return true;
    if (code(error) === "EPERM") return false;
    return unavailable("OWNER_UNVERIFIED", error);
  }
}

function retireObservedDeadOwner(lockPath: string): boolean {
  let info;
  try { info = lstatSync(lockPath); }
  catch (error) { if (code(error) === "ENOENT") return true; throw error; }
  // Unknown path state is preserved; it must not be reported as a running broker.
  if (!info.isDirectory() || info.isSymbolicLink()) return unavailable("UNSUPPORTED_PATH");
  let entries;
  try { entries = readdirSync(lockPath, { withFileTypes: true }); }
  catch (error) { if (code(error) === "ENOENT") return true; throw error; }
  if (entries.length === 0) return unavailable("EMPTY_DIRECTORY");
  if (entries.length !== 1) return unavailable("UNRECOGNIZED_OWNER");
  const entry = entries[0]!;
  const match = OWNER.exec(entry.name);
  if (!match || !entry.isDirectory() || entry.isSymbolicLink()) return unavailable("UNRECOGNIZED_OWNER");
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return unavailable("UNRECOGNIZED_OWNER");
  if (!definitelyGone(pid)) return false;
  const marker = path.join(lockPath, entry.name);
  // Exact, never-reused generation name is the removal witness. Losing observers
  // must not remove the parent after ENOENT or an unexpected/nonempty child.
  try { rmdirSync(marker); }
  catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(code(error) ?? "")) return unavailable("CHANGED", error);
    throw error;
  }
  try { rmdirSync(lockPath); return true; }
  catch (error) {
    if (code(error) === "ENOENT") return true;
    if (["ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) return unavailable("CHANGED", error);
    throw error;
  }
}

/**
 * Broker-specific lock for cooperating processes in a stable, user-owned parent.
 * Build the nonempty directory privately, then publish it with same-parent rename.
 * A live published owner is never empty, so another publisher cannot replace it.
 * This is not hostile same-user path isolation or crash durability.
 */
export function acquireBrokerProcessLock(lockPath: string): BrokerProcessLock | null {
  const owner = "owner-" + process.pid + "-" + randomBytes(16).toString("hex");
  const stage = mkdtempSync(lockPath + ".stage-");
  let markerCreated = false;
  let published = false;
  let result: BrokerProcessLock | null = null;
  let failure: { error: unknown } | null = null;
  try {
    mkdirSync(path.join(stage, owner), { mode: 0o700 });
    markerCreated = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Inspect first: a known empty/unknown pre-existing directory is preserved.
      // Under this protocol a competing published lock is always nonempty.
      if (!retireObservedDeadOwner(lockPath)) break;
      try {
        renameSync(stage, lockPath);
        published = true;
        result = Object.freeze({ path: lockPath, owner });
        break;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "ENOENT"].includes(code(error) ?? "")) throw error;
        if (attempt === 1) return unavailable("PUBLISH_" + (code(error) ?? "UNKNOWN"), error);
      }
    }
  } catch (error) {
    failure = { error };
  }
  if (!published) {
    const cleanup: unknown[] = [];
    for (const target of [...(markerCreated ? [path.join(stage, owner)] : []), stage]) {
      try { rmdirSync(target); }
      catch (error) { if (code(error) !== "ENOENT") cleanup.push(error); }
    }
    if (cleanup.length) {
      if (failure) throw Object.assign(new AggregateError([failure.error, ...cleanup],
        "Broker lock preparation and cleanup both failed.", { cause: failure.error }),
        { code: "BROKER_LOCK_PREPARATION_CLEANUP_FAILED" });
      if (cleanup.length === 1) throw cleanup[0];
      throw Object.assign(new AggregateError(cleanup, "Broker lock preparation cleanup failed.", { cause: cleanup[0] }),
        { code: "BROKER_LOCK_PREPARATION_CLEANUP_FAILED" });
    }
  }
  if (failure) throw failure.error;
  return result;
}

/** Reobserve short release/reclaim gaps; persistent unknown state is never deleted. */
export async function acquireBrokerProcessLockWhenReady(lockPath: string): Promise<BrokerProcessLock | null> {
  for (let attempt = 0; ; attempt++) {
    try { return acquireBrokerProcessLock(lockPath); }
    catch (error) {
      if (attempt >= 19 || ![
        "BROKER_LOCK_EMPTY_DIRECTORY", "BROKER_LOCK_CHANGED",
        "BROKER_LOCK_PUBLISH_EEXIST", "BROKER_LOCK_PUBLISH_ENOTEMPTY",
        "BROKER_LOCK_PUBLISH_EPERM", "BROKER_LOCK_PUBLISH_EACCES", "BROKER_LOCK_PUBLISH_ENOENT",
      ].includes(code(error) ?? "")) throw error;
      await delay(25);
    }
  }
}

/** Caller holds the lease until endpoint/socket/store cleanup has finished. */
export function ownsBrokerProcessLock(lock: BrokerProcessLock): boolean {
  try {
    const info = lstatSync(lock.path);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const entries = readdirSync(lock.path, { withFileTypes: true });
    return entries.length === 1 && entries[0]!.name === lock.owner
      && entries[0]!.isDirectory() && !entries[0]!.isSymbolicLink();
  } catch (error) { if (code(error) === "ENOENT") return false; throw error; }
}

export function releaseBrokerProcessLock(lock: BrokerProcessLock): void {
  try { rmdirSync(path.join(lock.path, lock.owner)); }
  catch (error) { if (code(error) === "ENOENT") return; throw error; }
  // A new nonempty owner can already have replaced the empty parent. Never recurse.
  try { rmdirSync(lock.path); }
  catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) throw error; }
}
