import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout, clearTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { InactiveUnifiedAuthority, createProviderAdapter, fixtureDigest } from "../../runtime/unified-state/authority.mjs";
import { scopeA, workflowRef, snapshot } from "./fixtures.mjs";

if (process.argv[2] === "--open-authority") {
  process.once("message", () => {
    process.send({ type: "attempt-start" });
    let authority;
    let result;
    try {
      authority = new InactiveUnifiedAuthority({ directory: process.argv[3], mode: "fixture-only", clock: () => 105 });
      result = { opened: true, row: createProviderAdapter(authority, scopeA).read(workflowRef) };
    } catch (error) {
      result = { opened: false, error: { code: error.code, errcode: error.errcode, message: error.message, stack: error.stack } };
      process.exitCode = 1;
    } finally {
      authority?.close();
    }
    process.send({ type: "result", result });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.disconnect();
  });
  process.send({ type: "ready" });
} else {
  const { afterAll, beforeAll, expect, test } = await import("vitest");
  const supplied = process.env.AGS_AUTHORITY_LOCK_FIXTURES;
  const sha = b => createHash("sha256").update(b).digest("hex");
  let root;
  let seed;
  let seedSha;
  beforeAll(() => {
    const parent = supplied ? path.resolve(supplied) : path.resolve(os.tmpdir());
    fs.mkdirSync(parent, { recursive: true });
    root = fs.mkdtempSync(path.join(parent, "ags-authority-opening-"));
    fs.mkdirSync(path.join(root, "seed"));
    seed = path.join(root, "seed", "ags-state.sqlite3");
    if (!fs.existsSync(seed)) {
      const authority = new InactiveUnifiedAuthority({ directory: path.dirname(seed), mode: "fixture-only", clock: () => 100 });
      try {
        const provider = createProviderAdapter(authority, scopeA);
        const snapshotJson = snapshot();
        provider.importFixture({ snapshotJson, sourceDigest: fixtureDigest(snapshotJson), intentId: "import-once" });
        provider.claim(workflowRef, { expectedRevision: 4, owner: "opening-fixture-owner", ttlMs: 10 });
      } finally { authority.close(); }
    }
    seedSha = sha(fs.readFileSync(seed));
  });
  afterAll(() => {
    if (root) {
      const target = path.resolve(root);
      const parent = supplied ? path.resolve(supplied) : path.resolve(os.tmpdir());
      if (path.dirname(target) !== parent || !path.basename(target).startsWith("ags-authority-opening-")) throw new Error("cleanup outside owned fixture directory");
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  test("waits for a held database read lock before its first metadata query", async () => {
    const active = path.join(root, "active");
    fs.mkdirSync(active, { recursive: true });
    fs.copyFileSync(seed, path.join(active, "ags-state.sqlite3"));
    const blocker = new DatabaseSync(path.join(active, "ags-state.sqlite3"));
    // Deliberately strong admission stimulus; not the exact CI WAL interleaving.
    blocker.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
    let held = true;
    let releaseTimer;
    let resultWhileHeld = null;
    const events = [];
    const release = () => {
      if (held) { blocker.exec("ROLLBACK"); blocker.close(); held = false; events.push("lock-released"); }
    };
    const worker = fork(fileURLToPath(import.meta.url), ["--open-authority", active], { execArgv: [], env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError;
    const deadline = setTimeout(() => { timedOut = true; worker.kill(); }, 7000);
    const completed = new Promise(resolve => {
      worker.stdout.on("data", b => { stdout += b; });
      worker.stderr.on("data", b => { stderr += b; });
      worker.on("error", error => { spawnError = error; });
      worker.on("message", message => {
        events.push(message.type);
        if (message.type === "ready") worker.send("open");
        if (message.type === "attempt-start") releaseTimer = setTimeout(release, 500);
        if (message.type === "result") resultWhileHeld = held;
      });
      worker.on("close", (code, signal) => resolve({ code, signal, timedOut, spawnError }));
    });
    let terminal;
    try { terminal = await completed; }
    finally { clearTimeout(deadline); clearTimeout(releaseTimer); release(); }
    console.log("LOCK-RAW " + JSON.stringify({ seedSha, events, resultWhileHeld, terminal, stdout, stderr }));
    expect(terminal.timedOut).toBe(false); expect(terminal.spawnError).toBeUndefined();
    expect(terminal.code).toBe(0); expect(terminal.signal).toBeNull();
    let actual;
    try { actual = JSON.parse(stdout.trim()); }
    catch (error) { throw new Error(`Authority opening worker returned invalid JSON: ${JSON.stringify({ terminal, stdout, stderr })}`, { cause: error }); }
    expect(events).toContain("attempt-start");
    expect(terminal.signal).toBeNull();
    expect(actual.opened, "first metadata admission must wait for lock release").toBe(true);
    expect(terminal.code).toBe(0);
    expect(resultWhileHeld).toBe(false);
    expect(actual.row.sourceId).toBe("fixture-source-original");
    expect(actual.row.revision).toBe(4);
    expect(actual.row.row.run_id).toBe("original-run-id");
    expect(sha(fs.readFileSync(seed))).toBe(seedSha);
  }, 10000);
}
