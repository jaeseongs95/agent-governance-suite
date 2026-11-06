// Linux TEST only: each owned child is a process-group leader. No host/user-wide process scans or kills.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function requireLinux() {
  if (process.platform !== "linux") throw new Error("UNSUPPORTED_PLATFORM: owned process-group cleanup is Linux TEST only");
}

export function spawnOwned(command, args, options, runDir, label) {
  requireLinux();
  const child = spawn(command, args, { ...options, detached: true });
  if (child.pid) appendFileSync(path.join(runDir, "owned-groups.jsonl"), JSON.stringify({ pgid: child.pid, ownerPid: process.pid, label }) + "\n");
  return child;
}

export function retireGroup(runDir, pgid) {
  if (Number.isSafeInteger(pgid)) appendFileSync(path.join(runDir, "owned-groups.jsonl"), JSON.stringify({ pgid, retired: true }) + "\n");
}

function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

export async function stopGroups(pgids) {
  requireLinux();
  // An ESRCH group is retired; never signal that numeric id again during this cleanup.
  let active = [...new Set(pgids)].filter(pgid => Number.isSafeInteger(pgid) && pgid > 1 && pgid !== process.pid);
  const attempted = [...active];
  active = active.filter(pgid => signalGroup(pgid, "SIGTERM"));
  const wait = async () => {
    const until = Date.now() + 1500;
    while (active.length && Date.now() < until) {
      await delay(50);
      active = active.filter(pgid => signalGroup(pgid, 0));
    }
  };
  await wait();
  active = active.filter(pgid => signalGroup(pgid, "SIGKILL"));
  await wait();
  return { attempted, remainingGroups: active, groupCleanup: active.length ? "UNCONFIRMED" : "CONFIRMED", escapedDescendants: "NOT_OBSERVED" };
}

export async function stopRecordedGroups(runDir) {
  const file = path.join(runDir, "owned-groups.jsonl");
  const rows = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const latest = new Map(rows.map(row => [row.pgid, row]));
  const result = await stopGroups([...latest.values()].filter(row => !row.retired).map(row => row.pgid));
  for (const pgid of result.attempted) if (!result.remainingGroups.includes(pgid)) retireGroup(runDir, pgid);
  return result;
}
