import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Scheduler interposition only: every filesystem operation still reaches the OS.
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const native = Object.fromEntries(["mkdirSync", "renameSync", "rmdirSync", "writeFileSync", "existsSync"].map(k => [k, fs[k].bind(fs)]));
let phase = "acquire";
const gates = (cfg.gates ?? []).map(g => ({ ...g, used: false }));
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function signal(name, value) {
  const target = path.join(cfg.root, cfg.id + "." + name + ".json");
  const tmp = target + ".tmp";
  native.writeFileSync(tmp, JSON.stringify({ pid: process.pid, ...value }), { flag: "wx" });
  native.renameSync(tmp, target);
}
function gate(op, when, args, error) {
  const target = op === "renameSync" ? args[1] : args[0];
  const kind = op === "mkdirSync" && path.basename(target).startsWith("owner-")
    && (path.dirname(target).startsWith(cfg.lockPath + ".stage-") || path.dirname(target) === cfg.lockPath) ? "marker-preparation"
    : op === "renameSync" && target === cfg.lockPath ? "publication"
    : target === cfg.lockPath ? "parent" : target === cfg.marker ? "observed-marker" : "other";
  const g = gates.find(g => !g.used && g.phase === phase && g.op === op && g.when === when && g.kind === kind);
  if (!g) return;
  g.used = true;
  signal(g.name, { op, when, kind, outcome: error ? "error" : "ok", code: error?.code ?? null });
  const deadline = Date.now() + 8000;
  while (!native.existsSync(path.join(cfg.root, cfg.id + "." + g.name + ".resume"))) {
    if (Date.now() >= deadline) throw Object.assign(new Error("OS race gate deadline"), { code: "TEST_GATE_TIMEOUT" });
    Atomics.wait(sleepCell, 0, 0, 2);
  }
}
for (const op of ["mkdirSync", "renameSync", "rmdirSync"]) {
  fs[op] = (...args) => {
    gate(op, "before", args);
    let result, failure;
    try { result = native[op](...args); } catch (error) { failure = error; }
    gate(op, "after", args, failure);
    if (failure) throw failure;
    return result;
  };
}
syncBuiltinESMExports();
let lease;
let api;
try {
  api = await import(pathToFileURL(cfg.modulePath).href);
  lease = await api.acquireBrokerProcessLockWhenReady(cfg.lockPath);
  signal("result", { outcome: lease ? "acquired" : "contended", lease });
  if (lease) {
    const command = path.join(cfg.root, cfg.id + ".command.json");
    const deadline = Date.now() + 20000;
    while (!native.existsSync(command)) {
      if (Date.now() >= deadline) throw Object.assign(new Error("OS race owner deadline"), { code: "TEST_OWNER_TIMEOUT" });
      await delay(5);
    }
    const action = JSON.parse(fs.readFileSync(command, "utf8")).action;
    if (action === "release" || action === "release-and-repeat") {
      const oldLease = lease;
      phase = "release"; api.releaseBrokerProcessLock(lease); lease = null;
      if (action === "release-and-repeat") {
        signal("released", {});
        while (!native.existsSync(path.join(cfg.root, cfg.id + ".repeat.resume"))) {
          if (Date.now() >= deadline) throw Object.assign(new Error("OS race repeat deadline"), { code: "TEST_REPEAT_TIMEOUT" });
          await delay(5);
        }
        phase = "late-release"; api.releaseBrokerProcessLock(oldLease);
      }
    } else if (action !== "exit-without-release") throw new Error("Unknown owned-test command");
    signal("done", { action });
  }
} catch (error) {
  signal("failure", { code: error?.code ?? "TEST_WORKER_ERROR", message: String(error?.message ?? error) });
  process.exitCode = 1;
}
