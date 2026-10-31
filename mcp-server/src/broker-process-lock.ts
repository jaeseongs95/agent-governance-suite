import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "node:net";
import { createLockWitness, lockWitnessState, lockWitnessSupported } from "./broker-lock-witness.js";
import { processStartToken, type ProcessIdentityBudget } from "./process-identity.js";
import { BROKER_LOCK_PUBLISH_RETRY_CODES, BROKER_LOCK_REASONS } from "./session-message-protocol.js";

export interface BrokerProcessLock {
  readonly path: string;
  readonly owner: string;
}
// 4번째 칸: 출생 시각 hash(기존), "pipe"(Windows 세대 증인), 없음(옛 PID-only, fail closed).
const OWNER = /^owner-([1-9][0-9]*)-([a-f0-9]{32})(?:-([a-f0-9]{64}|pipe))?$/u;
const PUBLISH_RETRY_CODES = BROKER_LOCK_PUBLISH_RETRY_CODES;
const REOBSERVE_CODES = ["BROKER_LOCK_" + BROKER_LOCK_REASONS.EMPTY_DIRECTORY, "BROKER_LOCK_" + BROKER_LOCK_REASONS.CHANGED,
  ...PUBLISH_RETRY_CODES.map(value => "BROKER_LOCK_PUBLISH_" + value)];
const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const startHash = (token: string) => createHash("sha256").update(token).digest("hex");
let ownStartHash: string | undefined;
const verifiedStartHashes = new Map<number, string>();
const heldWitnesses = new Map<string, Server>();

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

function definitelyGone(pid: number, expectedStartHash?: string, budget?: ProcessIdentityBudget, generation?: string): boolean {
  remaining(budget);
  try { process.kill(pid, 0); }
  catch (error) {
    if (code(error) === "ESRCH") { verifiedStartHashes.delete(pid); return true; }
    if (code(error) !== "EPERM") return unavailable(BROKER_LOCK_REASONS.OWNER_UNVERIFIED, error);
    if (expectedStartHash !== "pipe") return false;
  }
  if (expectedStartHash === "pipe") {
    // PID가 살아 있어도 그 세대의 pipe가 없으면 소유 세대는 끝났다. 목록을 못 읽으면 보존한다.
    const state = generation && lockWitnessSupported() ? lockWitnessState(generation) : "unknown";
    if (state === "unknown") return unavailable(BROKER_LOCK_REASONS.OWNER_UNVERIFIED);
    return state === "absent";
  }
  if (expectedStartHash === undefined) return false; // Legacy PID-only markers fail closed.
  if (verifiedStartHashes.get(pid) === expectedStartHash) return false;
  const actualHash = startHash(startToken(pid, budget));
  if (actualHash === expectedStartHash) {
    verifiedStartHashes.set(pid, actualHash);
    return false;
  }
  verifiedStartHashes.delete(pid);
  return true;
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
  if (!definitelyGone(pid, match[3], budget, match[2])) return false;
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
    let namedVerifiedDead = false;
    if (namedMatch?.[3]) {
      const namedPid = Number(namedMatch[1]);
      if (!Number.isSafeInteger(namedPid) || namedPid < 1) continue;
      try { if (!definitelyGone(namedPid, namedMatch[3], budget, namedMatch[2])) continue; }
      catch (error) { if (code(error) === "BROKER_LOCK_" + BROKER_LOCK_REASONS.OWNER_UNVERIFIED) continue; throw error; }
      namedVerifiedDead = true;
    }
    let children;
    try { children = readdirSync(stage, { withFileTypes: true }); }
    catch (error) { if (["ENOENT", "EPERM", "EACCES", "ENOTDIR"].includes(code(error) ?? "")) continue; throw error; }
    const marker = children.length === 1 ? children[0]! : null;
    const owner = marker?.name ?? (children.length === 0 && namedMatch?.[3] ? namedOwner : "");
    const match = OWNER.exec(owner);
    if (!match || (marker && (!marker.isDirectory() || marker.isSymbolicLink()))
      || (namedMatch && owner !== namedOwner)) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid < 1) continue;
    if (!namedVerifiedDead) {
      try { if (!definitelyGone(pid, match[3], budget, match[2])) continue; }
      catch (error) { if (code(error) === "BROKER_LOCK_" + BROKER_LOCK_REASONS.OWNER_UNVERIFIED) continue; throw error; }
    }
    try {
      if (marker) rmdirSync(path.join(stage, owner));
      rmdirSync(stage);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST", "EPERM", "EACCES", "EBUSY"].includes(code(error) ?? "")) throw error;
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
  const generation = randomBytes(16).toString("hex");
  // Windows는 자기 출생 시각을 조회하지 않는다(PowerShell 기동 속도 의존 제거). 세대 pipe를 marker보다 먼저
  // 만들어, 게시된 marker에는 소유자가 살아 있는 동안 항상 증인이 있게 한다.
  // pipe를 만들 수 없는 환경(제한 토큰 등)은 기존 출생 시각 marker로 돌아간다.
  const witness = lockWitnessSupported() ? createLockWitness(generation) ?? undefined : undefined;
  if (!witness && ownStartHash === undefined) {
    const token = startToken(process.pid, budget);
    ownStartHash = startHash(token);
  }
  const owner = "owner-" + process.pid + "-" + generation + "-" + (witness ? "pipe" : ownStartHash);
  try { return publishOwner(lockPath, owner, witness, budget); }
  catch (error) { witness?.close(); throw error; }
}

function publishOwner(lockPath: string, owner: string, witness: Server | undefined, budget?: ProcessIdentityBudget): BrokerProcessLock | null {
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
  if (result && witness) heldWitnesses.set(owner, witness);
  else witness?.close();
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
  const closeWitness = () => { heldWitnesses.get(lock.owner)?.close(); heldWitnesses.delete(lock.owner); };
  try { rmdirSync(path.join(lock.path, lock.owner)); }
  catch (error) { if (code(error) === "ENOENT") { closeWitness(); return; } throw error; }
  // marker를 지운 뒤에 증인을 닫는다. 지우지 못하면(위 throw) 증인을 유지해 살아 있는 소유자로 남는다.
  closeWitness();
  // A new nonempty owner can already have replaced the empty parent. Never recurse.
  try { rmdirSync(lock.path); }
  catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? "")) throw error; }
}
