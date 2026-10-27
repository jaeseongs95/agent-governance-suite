import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processStartToken, type ProcessIdentityBudget } from "./process-identity.js";
import { BROKER_LOCK_PUBLISH_RETRY_CODES, BROKER_LOCK_REASONS } from "./session-message-protocol.js";

export interface BrokerProcessLock {
  readonly path: string;
  readonly owner: string;
}
const OWNER = /^owner-([1-9][0-9]*)-([a-f0-9]{32})(?:-([a-f0-9]{64}))?$/u;
const PUBLISH_RETRY_CODES = BROKER_LOCK_PUBLISH_RETRY_CODES;
const REOBSERVE_CODES = ["BROKER_LOCK_" + BROKER_LOCK_REASONS.EMPTY_DIRECTORY, "BROKER_LOCK_" + BROKER_LOCK_REASONS.CHANGED,
  ...PUBLISH_RETRY_CODES.map(value => "BROKER_LOCK_PUBLISH_" + value)];
const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const startHash = (token: string) => createHash("sha256").update(token).digest("hex");
let ownStartHash: string | undefined;

type BrokerLockReason = typeof BROKER_LOCK_REASONS[keyof typeof BROKER_LOCK_REASONS] | `PUBLISH_${string}`;
function unavailable(reason: BrokerLockReason, cause?: unknown): never {
  throw Object.assign(new Error("Broker lock state requires inspection: " + reason + ".", { cause }),
    { code: "BROKER_LOCK_" + reason });
}

/** ESRCH or a verified different birth proves absence. EPERM/unknown preserve the contender. */
function remaining(budget?: ProcessIdentityBudget): number | undefined {
  if (!budget) return undefined;
  const value = Math.floor(budget());
  if (!Number.isFinite(value) || value < 1) return unavailable(BROKER_LOCK_REASONS.BUDGET_EXPIRED);
  return value;
}

function startToken(pid: number, budget?: ProcessIdentityBudget): string {
  let cause: unknown;
  const token = processStartToken(pid, process.platform, remaining(budget), error => { cause = error; });
  if (token === null) return unavailable(BROKER_LOCK_REASONS.OWNER_UNVERIFIED, cause);
  remaining(budget); // A late result cannot authorize a marker or a reclaim.
  return token;
}

function definitelyGone(pid: number, expectedStartHash?: string, budget?: ProcessIdentityBudget): boolean {
  remaining(budget);
  try { process.kill(pid, 0); }
  catch (error) {
    if (code(error) === "ESRCH") return true;
    if (code(error) === "EPERM") return false;
    return unavailable(BROKER_LOCK_REASONS.OWNER_UNVERIFIED, error);
  }
  if (expectedStartHash === undefined) return false; // Legacy PID-only markers fail closed.
  const actual = startToken(pid, budget);
  return startHash(actual) !== expectedStartHash;
}

function retireObservedDeadOwner(lockPath: string, budget?: ProcessIdentityBudget): boolean {
  remaining(budget);
  let info;
  try { info = lstatSync(lockPath); }
  catch (error) { if (code(error) === "ENOENT") return true; throw error; }
  // Unknown path state is preserved; it must not be reported as a running broker.
  if (!info.isDirectory() || info.isSymbolicLink()) return unavailable(BROKER_LOCK_REASONS.UNSUPPORTED_PATH);
  let entries;
  try { entries = readdirSync(lockPath, { withFileTypes: true }); }
  catch (error) { if (code(error) === "ENOENT") return true; throw error; }
  if (entries.length === 0) return unavailable(BROKER_LOCK_REASONS.EMPTY_DIRECTORY);
  if (entries.length !== 1) return unavailable(BROKER_LOCK_REASONS.UNRECOGNIZED_OWNER);
  const entry = entries[0]!;
  const match = OWNER.exec(entry.name);
  if (!match || !entry.isDirectory() || entry.isSymbolicLink()) return unavailable(BROKER_LOCK_REASONS.UNRECOGNIZED_OWNER);
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return unavailable(BROKER_LOCK_REASONS.UNRECOGNIZED_OWNER);
  if (!definitelyGone(pid, match[3], budget)) return false;
  const marker = path.join(lockPath, entry.name);
  // Exact, never-reused generation name is the removal witness. Losing observers
  // must not remove the parent after ENOENT or an unexpected/nonempty child.
  try { rmdirSync(marker); }
  catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(code(error) ?? "")) return unavailable(BROKER_LOCK_REASONS.CHANGED, error);
    throw error;
  }
  try { rmdirSync(lockPath); return true; }
  catch (error) {
    if (code(error) === "ENOENT") return true;
    if (["ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) return unavailable(BROKER_LOCK_REASONS.CHANGED, error);
    throw error;
  }
}

/** Stage names are never reused; reclaim only a recognizable, verified dead generation. */
function retireAbandonedStages(lockPath: string, budget?: ProcessIdentityBudget): void {
  const prefix = path.basename(lockPath) + ".stage-";
  for (const entry of readdirSync(path.dirname(lockPath), { withFileTypes: true })) {
    remaining(budget);
    if (!entry.name.startsWith(prefix) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const stage = path.join(path.dirname(lockPath), entry.name);
    // New stage names retain the witness even if the process dies before mkdir(marker).
    const namedOwner = entry.name.slice(prefix.length, -7);
    const namedMatch = /-[A-Za-z0-9]{6}$/u.test(entry.name) ? OWNER.exec(namedOwner) : null;
    let children;
    try { children = readdirSync(stage, { withFileTypes: true }); }
    catch (error) { if (code(error) === "ENOENT") continue; throw error; }
    const marker = children.length === 1 ? children[0]! : null;
    const owner = marker?.name ?? (children.length === 0 && namedMatch?.[3] ? namedOwner : "");
    const match = OWNER.exec(owner);
    if (!match || (marker && (!marker.isDirectory() || marker.isSymbolicLink()))
      || (namedMatch && owner !== namedOwner)) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid < 1) continue;
    try { if (!definitelyGone(pid, match[3], budget)) continue; }
    catch (error) { if (code(error) === "BROKER_LOCK_" + BROKER_LOCK_REASONS.OWNER_UNVERIFIED) continue; throw error; }
    try {
      if (marker) rmdirSync(path.join(stage, owner));
      rmdirSync(stage);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) throw error;
    }
  }
}

/**
 * Broker-specific lock for cooperating processes in a stable, user-owned parent.
 * Build the nonempty directory privately, then publish it with same-parent rename.
 * A live published owner is never empty, so another publisher cannot replace it.
 * This is not hostile same-user path isolation or crash durability.
 */
export function acquireBrokerProcessLock(lockPath: string, budget?: ProcessIdentityBudget): BrokerProcessLock | null {
  remaining(budget);
  if (ownStartHash === undefined) {
    const token = startToken(process.pid, budget);
    ownStartHash = startHash(token);
  }
  const owner = "owner-" + process.pid + "-" + randomBytes(16).toString("hex") + "-" + ownStartHash;
  retireAbandonedStages(lockPath, budget);
  remaining(budget);
  const stage = mkdtempSync(path.toNamespacedPath(lockPath + ".stage-" + owner + "-"));
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
      if (!retireObservedDeadOwner(lockPath, budget)) break;
      remaining(budget);
      try {
        renameSync(stage, lockPath);
        published = true;
        result = Object.freeze({ path: lockPath, owner });
        break;
      } catch (error) {
        if (!PUBLISH_RETRY_CODES.includes(code(error) ?? "")) throw error;
        if (attempt === 1) return unavailable(("PUBLISH_" + (code(error) ?? "UNKNOWN")) as `PUBLISH_${string}`, error);
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
        { code: "BROKER_LOCK_" + BROKER_LOCK_REASONS.PREPARATION_CLEANUP_FAILED });
      if (cleanup.length === 1) throw cleanup[0];
      throw Object.assign(new AggregateError(cleanup, "Broker lock preparation cleanup failed.", { cause: cleanup[0] }),
        { code: "BROKER_LOCK_" + BROKER_LOCK_REASONS.PREPARATION_CLEANUP_FAILED });
    }
  }
  if (failure) throw failure.error;
  return result;
}

/** Reobserve short release/reclaim gaps; persistent unknown state is never deleted. */
export async function acquireBrokerProcessLockWhenReady(lockPath: string, budget?: ProcessIdentityBudget): Promise<BrokerProcessLock | null> {
  for (let attempt = 0; ; attempt++) {
    try { return acquireBrokerProcessLock(lockPath, budget); }
    catch (error) {
      if (attempt >= 19 || !REOBSERVE_CODES.includes(code(error) ?? "")) throw error;
      await delay(Math.min(25, remaining(budget) ?? 25));
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
