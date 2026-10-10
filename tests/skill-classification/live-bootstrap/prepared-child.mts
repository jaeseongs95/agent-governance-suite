import assert from "node:assert/strict";
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {mockEnv, mockResponse, hash} from "./prepared-fixture.mjs";

const [, , repo, helper, configFile, mode = "normal"] = process.argv;
assert(repo && helper && configFile && process.send, "CHILD_REQUIRES_IPC_AND_EXPLICIT_INPUTS");
const api = await import(pathToFileURL(path.resolve(helper!)).href) as typeof import("./bootstrap.mts");
const config = JSON.parse(await readFile(configFile!, "utf8"));
const send = (value: unknown) => new Promise<void>((resolve, reject) => process.send!(value as object, error => error ? reject(error) : resolve()));
const released = new Promise<void>(resolve => process.once("message", message => {assert.equal((message as {type: string}).type, "RELEASE"); resolve();}));
await send({type: "READY", pid: process.pid});
await released;
let calls = 0;

const cuts = ["before-reserve", "after-reserve", "after-claim", "after-unknown-journal", "after-response", "after-finish"] as const;
type Cut = typeof cuts[number];
const cut = mode.startsWith("cut:") ? mode.slice(4) as Cut : null;
if (cut) assert(cuts.includes(cut), "UNKNOWN_CRASH_CUT");
const ledgerFile = path.join(config.outputDirectory, "ledger.json");
const original = {openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync, renameSync: fs.renameSync, readFileSync: fs.readFileSync,
  readdirSync: fs.readdirSync, existsSync: fs.existsSync, promiseWriteFile: fs.promises.writeFile};
const claimFds = new Set<number>();
let cutRecorded = false;
function crashAt(observed: Cut): never {
  assert.equal(observed, cut); assert(!cutRecorded); cutRecorded = true;
  const names = original.readdirSync(config.outputDirectory).filter(name =>
    name === "bootstrap.lock" || name === "ledger.json" || name.endsWith(".attempt-1.claim.json") || name.endsWith(".raw.json")).sort();
  const files = names.map(name => {const bytes = original.readFileSync(path.join(config.outputDirectory, name)); return {name, bytes: bytes.length, digest: hash(bytes)};});
  const marker = JSON.stringify({schemaVersion: "1.0.0", cut: observed, processId: process.pid, calls, files,
    ledgerPresent: original.existsSync(ledgerFile), claimCount: names.filter(name => name.endsWith(".attempt-1.claim.json")).length,
    rawCount: names.filter(name => name.endsWith(".raw.json")).length, scope: "same-local-physical-run-output-only"}) + "\n";
  const fd = original.openSync(path.join(config.outputDirectory, "fixture-cut-marker.json"), "wx", 0o600);
  try {original.writeFileSync(fd, marker); original.fsyncSync(fd);} finally {original.closeSync(fd);}
  // No IPC completion message is needed: parent must observe actual exit and the fsynced marker.
  process.kill(process.pid, "SIGKILL");
  throw new Error("SELF_SIGKILL_RETURNED"); // A normal DONE/zero exit cannot count as the requested crash.
}
if (cut) {
  fs.openSync = (...args: Parameters<typeof fs.openSync>) => {
    const fd = original.openSync(...args);
    if (String(args[0]).endsWith(".attempt-1.claim.json")) claimFds.add(fd);
    return fd;
  };
  fs.fsyncSync = fd => {
    original.fsyncSync(fd);
    if (cut === "after-claim" && claimFds.has(fd)) crashAt(cut);
  };
  fs.renameSync = (from, to) => {
    original.renameSync(from, to);
    if (String(to) !== ledgerFile) return;
    const ledger = JSON.parse(original.readFileSync(ledgerFile, "utf8"));
    if (cut === "after-reserve" && ledger.entries.length === config.limits.requests
      && ledger.entries.every((row: {state: string}) => row.state === "reserved")) crashAt(cut);
    if (cut === "after-unknown-journal" && calls === 0
      && ledger.entries.some((row: {state: string; resultDigest: unknown}) => row.state === "unknown" && row.resultDigest === null)) crashAt(cut);
    if (cut === "after-finish" && calls === config.limits.requests
      && ledger.entries.every((row: {resultDigest: unknown}) => row.resultDigest !== null)) crashAt(cut);
  };
  fs.promises.writeFile = (async (...args: Parameters<typeof fs.promises.writeFile>) => {
    const file = String(args[0]);
    if (cut === "before-reserve" && file.startsWith(ledgerFile + ".tmp-") && !original.existsSync(ledgerFile)) crashAt(cut);
    if (cut === "after-response" && calls === 1 && file.endsWith(".raw.json")) crashAt(cut);
    return original.promiseWriteFile(...args);
  }) as typeof fs.promises.writeFile;
  syncBuiltinESMExports();
}

try {
  const result = await api.run(config, {executionKind: "offline-mock", env: {...mockEnv}, fetcher: async (_url, init) => {
    calls++;
    const ledger = JSON.parse(await readFile(path.join(config.outputDirectory, "ledger.json"), "utf8"));
    assert.equal(ledger.entries.length, config.limits.requests, "WHOLE_RUN_RESERVED_BEFORE_FIRST_TRANSPORT");
    assert.equal(ledger.entries.reduce((sum: number, row: {reservedUsd: number}) => sum + row.reservedUsd, 0), config.limits.requests * 0.001);
    const ids = Object.keys(JSON.parse(String(init?.body)).questions);
    assert.equal(ids.length, 24, "NORMAL_SYNTHETIC_RESPONSE_COVERS_ALL_24_IDS");
    if (mode === "crash") {
      await send({type: "DISPATCH", calls, entries: ledger.entries});
      return await new Promise<Response>(() => {}); // Parent kills this actual process after the durable UNKNOWN marker.
    }
    return mockResponse(init);
  }});
  await send({type: "DONE", calls, status: result.status, reserved: "requestsReserved" in result ? result.requestsReserved : 0});
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  await send({type: "DONE", calls, status: "REJECTED", code: typeof code === "string" ? code : "RUN_REJECTED"});
}
if (cut && !cutRecorded) throw new Error(`CRASH_CUT_NOT_REACHED:${cut}`);
process.disconnect!();
