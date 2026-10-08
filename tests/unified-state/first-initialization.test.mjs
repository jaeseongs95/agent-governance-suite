import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout, clearTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { InactiveUnifiedAuthority, createProviderAdapter, fixtureDigest } from "../../runtime/unified-state/authority.mjs";
import { InactiveSharedConnection } from "../../runtime/unified-state/shared-connection.mjs";
import { scopeA, workflowRef, snapshot } from "./fixtures.mjs";

const keys = { workflow: Buffer.alloc(32, 1).toString("base64url"), continuity: Buffer.alloc(32, 2).toString("base64url"), trust: Buffer.alloc(32, 3).toString("base64url") };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const application = { authority: 0x41475355, shared: 0x4147534e };
async function sharedFactory() { return (await import("../../mcp-server/src/inactive-shared-stores.ts")).createInactiveSharedStores; }

if (process.argv[2] === "--first-init-worker") {
  const [type, role, directory] = process.argv.slice(3);
  const factory = type === "shared" ? await sharedFactory() : null;
  const marker = path.join(directory, "release");
  let pendingOwner;
  if (role === "foreign" && type === "shared") pendingOwner = new InactiveSharedConnection({ databasePath: path.join(directory, "ags-state.sqlite3"), mode: "fixture-only", clock: () => 100 });
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalExec = DatabaseSync.prototype.exec;
  let paused = false;
  let callbackCalled = false;
  let transactionAtWalFailure;
  const pause = details => {
    if (paused) return;
    paused = true;
    process.send({ type: "paused", details });
    const deadline = Date.now() + 12000;
    while (!fs.existsSync(marker)) {
      if (Date.now() > deadline) throw new Error("FIXTURE_BARRIER_DEADLINE");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  };
  if (role === "mixed-a") DatabaseSync.prototype.prepare = function (sql, ...rest) {
    const statement = originalPrepare.call(this, sql, ...rest);
    if (/^PRAGMA application_id$/u.test(sql) && !paused) return { get: (...args) => {
      const value = statement.get(...args);
      pause({ app: value.application_id, inTransaction: this.isTransaction, boundary: "after-real-first-header-read" });
      return value;
    } };
    return statement;
  };
  if (role === "foreign") DatabaseSync.prototype.exec = function (sql) {
    if (/^BEGIN IMMEDIATE$/u.test(sql) && !paused) pause({ inTransaction: this.isTransaction, boundary: "before-first-writer-lock" });
    return originalExec.call(this, sql);
  };
  if (role === "wal-fail") DatabaseSync.prototype.exec = function (sql) {
    if (/PRAGMA journal_mode=WAL/iu.test(sql)) {
      transactionAtWalFailure = this.isTransaction;
      const error = new Error("fixed-wal-setup-failure"); error.code = "FIXTURE_WAL_SETUP_FAILURE"; throw error;
    }
    return originalExec.call(this, sql);
  };
  process.once("message", () => {
    let owner;
    let result;
    try {
      if (pendingOwner) {
        owner = pendingOwner;
        owner.initialize(() => { callbackCalled = true; });
        result = { opened: true, callbackCalled };
      } else if (type === "shared") {
        const bundle = factory({ directory, mode: "fixture-only", clock: () => 100, syntheticKeys: keys });
        owner = bundle.owner;
        result = { opened: true, sequence: role.startsWith("mixed-") ? bundle.workflow.nextRunSequence() : null, modules: owner.inspect().modules.length };
      } else {
        owner = new InactiveUnifiedAuthority({ directory, mode: "fixture-only", clock: () => 100 });
        if (role === "mixed-b") {
          const json = snapshot();
          createProviderAdapter(owner, scopeA).importFixture({ snapshotJson: json, sourceDigest: fixtureDigest(json), intentId: "first-init-source" });
        }
        result = { opened: true };
      }
    } catch (error) {
      result = { opened: false, callbackCalled, transactionAtWalFailure, error: { code: error.code, errcode: error.errcode, message: error.message, stack: error.stack } };
      process.exitCode = 1;
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
      DatabaseSync.prototype.exec = originalExec;
      owner?.close();
      if (pendingOwner && owner !== pendingOwner) pendingOwner.close();
    }
    process.stdout.write(JSON.stringify(result) + "\n");
    process.send({ type: "result", result }, () => process.disconnect());
  });
  process.send({ type: "ready" });
} else {
  const { afterAll, beforeAll, expect, test } = await import("vitest");
  const supplied = process.env.AGS_FIRST_INIT_FIXTURES;
  let root;
  let seed;
  let seedSha;
  const workers = new Set();
  beforeAll(() => {
    root = supplied ? path.resolve(supplied) : fs.mkdtempSync(path.join(os.tmpdir(), "ags-first-init-"));
    fs.mkdirSync(root, { recursive: true });
    seed = path.join(root, "empty-wal.sqlite3");
    if (!fs.existsSync(seed)) { const db = new DatabaseSync(seed); db.exec("PRAGMA journal_mode=WAL;"); db.close(); }
    seedSha = sha(fs.readFileSync(seed));
  });
  afterAll(() => {
    for (const worker of workers) worker.kill();
    if (!supplied && root) {
      if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("ags-first-init-")) throw new Error("cleanup outside owned fixture root");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  function freshDirectory(label) {
    const directory = path.join(root, label);
    if (path.dirname(directory) !== root || !/^(mixed|foreign|wal-fail)-(authority|shared)$/u.test(label)) throw new Error("fixture outside owned root");
    fs.rmSync(directory, { recursive: true, force: true }); fs.mkdirSync(directory);
    fs.copyFileSync(seed, path.join(directory, "ags-state.sqlite3"));
    return directory;
  }
  function worker(type, role, directory) {
    const child = fork(fileURLToPath(import.meta.url), ["--first-init-worker", type, role, directory], { cwd: path.resolve("."), execArgv: ["--import", "tsx"], env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    workers.add(child);
    let readyResolve, pausedResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const paused = new Promise(resolve => { pausedResolve = resolve; });
    let stdout = "", stderr = "", result;
    const done = new Promise((resolve, reject) => {
      child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
      child.on("error", reject); child.on("message", message => {
        if (message.type === "ready") readyResolve();
        if (message.type === "paused") pausedResolve(message.details);
        if (message.type === "result") result = message.result;
      });
      child.on("close", (code, signal) => { workers.delete(child); resolve({ code, signal, result, stdout, stderr }); });
    });
    return { child, ready, paused, done, go: () => child.send("go") };
  }
  function stableState(directory) {
    const filename = path.join(directory, "ags-state.sqlite3");
    const checkpoint = new DatabaseSync(filename); checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE);"); checkpoint.close();
    const db = new DatabaseSync(filename, { readOnly: true });
    try { return { app: db.prepare("PRAGMA application_id").get().application_id, version: db.prepare("PRAGMA user_version").get().user_version, tables: db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all(), bytesSha256: sha(fs.readFileSync(filename)), integrity: db.prepare("PRAGMA integrity_check").get().integrity_check }; }
    finally { db.close(); }
  }
  for (const type of ["authority", "shared"]) {
    test(`${type}: simultaneous first initialization admits both matching connections`, async () => {
      const directory = freshDirectory("mixed-" + type), a = worker(type, "mixed-a", directory), b = worker(type, "mixed-b", directory);
      await Promise.all([a.ready, b.ready]); a.go(); const captured = await a.paused;
      let released = false, releaseReason;
      const release = reason => { if (!released) { released = true; releaseReason = reason; fs.writeFileSync(path.join(directory, "release"), "release\n"); } };
      const timer = setTimeout(() => release("bounded-release-for-writer-serialization"), 500);
      b.go(); b.done.then(() => release("second-init-completed-before-release"));
      let left, right;
      try { [left, right] = await Promise.all([a.done, b.done]); }
      finally { clearTimeout(timer); release("cleanup"); }
      const state = stableState(directory);
      console.log("FIRST-INIT-RAW " + JSON.stringify({ type, seedSha, captured, releaseReason, left, right, state }));
      expect(captured.app).toBe(0);
      expect(left.result?.opened, "first metadata snapshot must not mix another committed format").toBe(true);
      expect(right.result?.opened).toBe(true); expect(left.code).toBe(0); expect(right.code).toBe(0);
      expect(state.app).toBe(application[type]); expect(state.version).toBe(1); expect(state.integrity).toBe("ok");
      if (type === "shared") expect([left.result.sequence, right.result.sequence].sort()).toEqual([1, 2]);
      else { const authority = new InactiveUnifiedAuthority({ directory, mode: "fixture-only", clock: () => 100 }); try { expect(createProviderAdapter(authority, scopeA).read(workflowRef)).toMatchObject({ sourceId: "fixture-source-original", revision: 4, row: { run_id: "original-run-id" } }); } finally { authority.close(); } }
      expect(sha(fs.readFileSync(seed))).toBe(seedSha);
    }, 20000);
    test(`${type}: foreign format committed before the writer lock is rejected without mutation`, async () => {
      const directory = freshDirectory("foreign-" + type), a = worker(type, "foreign", directory);
      await a.ready; a.go(); const captured = await a.paused;
      if (type === "shared") { const factory = await sharedFactory(); const bundle = factory({ directory, mode: "fixture-only", clock: () => 100, syntheticKeys: keys }); bundle.workflow.nextRunSequence(); bundle.owner.close(); }
      else { const authority = new InactiveUnifiedAuthority({ directory, mode: "fixture-only", clock: () => 100 }); const json = snapshot(); createProviderAdapter(authority, scopeA).importFixture({ snapshotJson: json, sourceDigest: fixtureDigest(json), intentId: "foreign-parent-source" }); authority.close(); }
      const foreign = new DatabaseSync(path.join(directory, "ags-state.sqlite3")); foreign.exec("PRAGMA application_id=19088743; PRAGMA user_version=99;"); foreign.close();
      const before = stableState(directory);
      fs.writeFileSync(path.join(directory, "release"), "release\n");
      const terminal = await a.done, after = stableState(directory);
      console.log("FIRST-INIT-FOREIGN-RAW " + JSON.stringify({ type, seedSha, captured, before, terminal, after }));
      expect(terminal.result?.error?.code).toBe("FOREIGN_OR_NEWER_DATABASE");
      expect(terminal.result?.callbackCalled).toBe(false); expect(after).toEqual(before);
      expect(sha(fs.readFileSync(seed))).toBe(seedSha);
    }, 20000);
    test(`${type}: WAL setup failure leaves a complete matching schema that can reopen`, async () => {
      const directory = freshDirectory("wal-fail-" + type), a = worker(type, "wal-fail", directory);
      await a.ready; a.go(); const terminal = await a.done, state = stableState(directory);
      console.log("FIRST-INIT-WAL-RAW " + JSON.stringify({ type, seedSha, terminal, state }));
      expect(terminal.result?.error?.code).toBe("FIXTURE_WAL_SETUP_FAILURE");
      expect(terminal.result.transactionAtWalFailure).toBe(false); expect(state.app).toBe(application[type]); expect(state.version).toBe(1);
      if (type === "shared") { const factory = await sharedFactory(); const bundle = factory({ directory, mode: "fixture-only", clock: () => 100, syntheticKeys: keys }); try { expect(bundle.owner.inspect().modules).toHaveLength(5); expect(bundle.workflow.nextRunSequence()).toBe(1); } finally { bundle.owner.close(); } }
      else { const authority = new InactiveUnifiedAuthority({ directory, mode: "fixture-only", clock: () => 100 }); authority.close(); }
      expect(sha(fs.readFileSync(seed))).toBe(seedSha);
    }, 20000);
  }
}
