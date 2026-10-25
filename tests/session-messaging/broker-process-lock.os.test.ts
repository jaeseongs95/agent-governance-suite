import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, readFile, readdir, lstat, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";

const workerFile = fileURLToPath(new URL("./fixtures/broker-process-lock-worker.mjs", import.meta.url));
const modulePath = fileURLToPath(new URL("../../mcp-server/src/broker-process-lock.ts", import.meta.url));
type Lease = { path: string; owner: string };
type Note = { pid: number; outcome?: string; code?: string | null; lease?: Lease };
type Gate = { phase: "acquire" | "release"; op: string; when: "before" | "after"; kind: string; name: string };
type Worker = { id: string; child: ChildProcess; exited: boolean; spawned: boolean; spawnFailed: boolean; output: string; outputBytes: number; outputLimitHit: boolean; done: Promise<{code: number | null; signal: string | null}> };
const heldGate = (name: string, phase: Gate["phase"], op: string, kind: string, when: Gate["when"] = "before"): Gate => ({name, phase, op, kind, when});

async function scenario(body: (s: Awaited<ReturnType<typeof controller>>) => Promise<void>) {
  const s = await controller();
  try { await body(s); }
  catch (primary) {
    let cleanupFailure: {error: unknown} | null = null;
    try { await s.cleanup(); }
    catch (cleanup) { cleanupFailure = {error: cleanup}; }
    if (cleanupFailure) throw new AggregateError([primary, cleanupFailure.error], "OS race body and cleanup failed", {cause: primary});
    throw primary;
  }
  await s.cleanup();
}
async function controller() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ags-broker-os-"));
  const lockPath = path.join(root, "broker.lock");
  const workers: Worker[] = [];
  async function start(id: string, gates: Gate[] = [], marker?: string) {
    const config = path.join(root, id + ".config.json");
    await writeFile(config, JSON.stringify({root, id, lockPath, modulePath, gates, marker}), {flag: "wx"});
    const child = spawn(process.execPath, ["--experimental-strip-types", workerFile, config], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
    const w: Worker = {id, child, exited: false, spawned: false, spawnFailed: false, output: "", outputBytes: 0, outputLimitHit: false, done: Promise.resolve({code: null, signal: null})};
    w.done = new Promise(resolve => {
      child.once("exit", () => { w.exited = true; });
      child.once("close", (code, signal) => { resolve({code, signal}); });
      child.once("spawn", () => { w.spawned = true; });
      child.on("error", error => {
        w.output += String(error);
        // A post-spawn kill/IPC error does not prove that this child stopped.
        if (!w.spawned && child.pid === undefined) {
          w.spawnFailed = true; resolve({code: null, signal: "SPAWN_ERROR"});
        }
      });
    });
    const capture = (chunk: Buffer) => {
      if (w.outputLimitHit) return;
      const room = Math.max(0, 65536 - w.outputBytes);
      const prefix = chunk.subarray(0, room);
      w.output += prefix.toString("utf8"); w.outputBytes += prefix.length;
      if (chunk.length > room) {
        w.outputLimitHit = true; w.output += "\nWORKER_OUTPUT_LIMIT\n";
        try { child.kill(); } catch (error) { w.output += String(error); }
      }
    };
    child.stdout!.on("data", capture); child.stderr!.on("data", capture);
    workers.push(w);
    return w;
  }
  async function optional(file: string): Promise<Note | null> {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async function note(w: Worker, name: string): Promise<Note> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const failure = await optional(path.join(root, w.id + ".failure.json"));
      if (failure) throw new Error("Worker failed: " + JSON.stringify(failure) + " " + w.output);
      const result = await optional(path.join(root, w.id + "." + name + ".json"));
      if (result) return result;
      if (w.exited) throw new Error("Worker exited before " + name + ": " + w.output);
      await delay(5);
    }
    throw new Error("Deadline waiting for " + w.id + "." + name);
  }
  const resume = (w: Worker, name: string) => writeFile(path.join(root, w.id + "." + name + ".resume"), "", {flag: "wx"});
  const command = async (w: Worker, action = "release") => {
    const target = path.join(root, w.id + ".command.json"), temporary = target + ".tmp";
    await writeFile(temporary, JSON.stringify({action}), {flag: "wx"});
    await rename(temporary, target);
  };
  async function stopped(w: Worker) {
    return Promise.race([w.done.then(() => true), delay(5000, false, {ref: false})]);
  }
  async function finish(w: Worker) {
    if (!await stopped(w)) throw new Error("Deadline waiting for actual owned-worker exit");
    expect(w.exited).toBe(true);
    const result = await w.done;
    const failure = await optional(path.join(root, w.id + ".failure.json"));
    expect(result, JSON.stringify({worker: w.id, failure, output: w.output, outputLimitHit: w.outputLimitHit})).toEqual({code: 0, signal: null});
  }
  async function owner(lease: Lease) {
    expect(await readdir(lockPath)).toEqual([lease.owner]);
    const info = await lstat(path.join(lockPath, lease.owner));
    expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
  }
  async function noStages() { expect((await readdir(root)).filter(name => name.startsWith("broker.lock.stage-"))).toEqual([]); }
  async function cleanup() {
    for (const w of workers) if (!w.exited && !w.spawnFailed) {
      try { w.child.kill(); } catch (error) { w.output += String(error); }
    }
    for (const w of workers) {
      if (!await stopped(w) || (!w.exited && !w.spawnFailed)) {
        throw new Error("Owned worker did not stop; preserve fixture directory");
      }
    }
    const resolved = path.resolve(root);
    const info = await lstat(resolved);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("ags-broker-os-")
      || !info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe fixture cleanup target");
    await rm(resolved, {recursive: true, force: false});
  }
  return {root, lockPath, start, note, resume, command, finish, owner, noStages, cleanup};
}

it("OS-001: private preparation pause cannot expose an empty public owner", async () => {
  await scenario(async s => {
    const a = await s.start("a", [heldGate("prepared", "acquire", "mkdirSync", "marker-preparation")]);
    await s.note(a, "prepared");
    await expect(lstat(s.lockPath)).rejects.toMatchObject({code: "ENOENT"});
    const b = await s.start("b"); const winner = await s.note(b, "result");
    expect(winner.outcome).toBe("acquired"); await s.owner(winner.lease!);
    b.child.emit("error", new Error("Synthetic post-spawn control error; no OS failure fabricated"));
    expect(b.exited).toBe(false); expect(b.spawnFailed).toBe(false);
    await s.owner(winner.lease!);
    await s.resume(a, "prepared"); expect((await s.note(a, "result")).outcome).toBe("contended");
    await s.finish(a); await s.owner(winner.lease!); await s.noStages();
    await s.command(b); await s.finish(b);
  });
});

it("OS-002: delayed stale observer cannot remove a new live generation", async () => {
  await scenario(async s => {
    const seed = await s.start("seed"); const stale = await s.note(seed, "result");
    expect(stale.outcome).toBe("acquired");
    await s.command(seed, "exit-without-release"); await s.finish(seed);
    let absent = false;
    try { process.kill(stale.pid, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    expect(absent).toBe(true); // No fabricated dead PID and no PID-reuse assumption.
    const b = await s.start("b", [heldGate("observed", "acquire", "rmdirSync", "observed-marker")], path.join(s.lockPath, stale.lease!.owner));
    await s.note(b, "observed");
    const c = await s.start("c"); const winner = await s.note(c, "result");
    expect(winner.outcome).toBe("acquired"); expect(winner.lease!.owner).not.toBe(stale.lease!.owner);
    await s.owner(winner.lease!); await s.resume(b, "observed");
    expect((await s.note(b, "result")).outcome).toBe("contended");
    await s.finish(b); await s.owner(winner.lease!); await s.noStages();
    await s.command(c); await s.finish(c);
  });
});

it("OS-003: delayed old parent cleanup preserves a successor across the real OS rename outcome", async () => {
  await scenario(async s => {
    const b = await s.start("b", [heldGate("publish", "acquire", "renameSync", "publication"),
      heldGate("renamed", "acquire", "renameSync", "publication", "after")]);
    await s.note(b, "publish"); // B has observed absence, but its rename has not executed.
    const a = await s.start("a", [heldGate("cleanup", "release", "rmdirSync", "parent")]);
    const old = await s.note(a, "result"); expect(old.outcome).toBe("acquired");
    await s.command(a, "release-and-repeat"); await s.note(a, "cleanup"); expect(await readdir(s.lockPath)).toEqual([]);
    await s.resume(b, "publish"); const actualRename = await s.note(b, "renamed");
    if (process.platform === "win32") {
      expect(actualRename.outcome).toBe("error"); expect(["EPERM", "EACCES", "EEXIST", "ENOTEMPTY"]).toContain(actualRename.code);
      expect(await readdir(s.lockPath)).toEqual([]);
    } else {
      expect(actualRename.outcome).toBe("ok");
      expect((await readdir(s.lockPath))).toHaveLength(1); // Real POSIX replacement happened before old cleanup.
    }
    await s.resume(a, "cleanup"); await s.note(a, "released");
    await s.resume(b, "renamed"); const winner = await s.note(b, "result");
    expect(winner.outcome).toBe("acquired"); expect(winner.lease!.owner).not.toBe(old.lease!.owner);
    await s.owner(winner.lease!); await s.resume(a, "repeat"); await s.finish(a);
    await s.owner(winner.lease!); await s.noStages(); await s.command(b); await s.finish(b);
  });
});

it("OS-004: a partially published fixture command is observable as a parser failure, not a broker-lock failure", async () => {
  await scenario(async s => {
    const worker = await s.start("partial-command");
    expect((await s.note(worker, "result")).outcome).toBe("acquired");
    await writeFile(path.join(s.root, worker.id + ".command.json"), '{"action":', {flag: "wx"});
    const result = await Promise.race([worker.done, delay(5000, null, {ref: false})]);
    expect(result).toEqual({code: 1, signal: null});
    expect(worker.exited).toBe(true);
    const failure = JSON.parse(await readFile(path.join(s.root, worker.id + ".failure.json"), "utf8")) as {code: string; message: string};
    expect(failure.code).toBe("TEST_WORKER_ERROR");
    expect(failure.message).toMatch(/JSON/u);
  });
});

it("OS-005: the fixture publishes a complete release command and observes drained child close", async () => {
  await scenario(async s => {
    const worker = await s.start("atomic-command");
    const winner = await s.note(worker, "result");
    expect(winner.outcome).toBe("acquired");
    await s.owner(winner.lease!); await s.command(worker); await s.finish(worker);
    expect(await readdir(s.root)).not.toContain(worker.id + ".command.json.tmp");
    await expect(lstat(s.lockPath)).rejects.toMatchObject({code: "ENOENT"});
    await s.noStages();
  });
});
