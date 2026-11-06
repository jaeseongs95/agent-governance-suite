import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Runtime preservation tests, not a functional RED/GREEN claim for the D0022 CQS refactor.
// Reuses hook-execution-budget.test.ts's real second-connection BEGIN IMMEDIATE fixture pattern.
const root = path.resolve(import.meta.dirname, "../..");
const helper = path.join(import.meta.dirname, "ags38-peer-elapsed-helper.mjs");
const preload = path.join(import.meta.dirname, "ags38-peer-elapsed-preload.mjs");
const entry = path.join(root, "mcp-server/dist/session-message-hook.mjs");
const marker = "AGS38_PEER_ELAPSED ";
const DEADLINE_MS = 6500;
const CHILD_TIMEOUT_MS = 10_000;
const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "ags38-peer-elapsed-recipient", agent_id: "" });

async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Owned TEST deadline: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function launch(args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const events = [], productFailures = [], waiters = [];
  let output = "", stderr = "", pending = "", launchError, stdinError, closedResult;
  const started = performance.now();
  const shutdownTimer = setTimeout(() => child.kill("SIGTERM"), CHILD_TIMEOUT_MS);
  child.stdin.on("error", error => { stdinError = error.code ?? "STDIN_ERROR"; });
  child.on("error", error => { launchError = error.code ?? "LAUNCH_ERROR"; });
  child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => {
    stderr += chunk;
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop();
    for (const line of lines) {
      if (line.startsWith(marker)) {
        const event = JSON.parse(line.slice(marker.length));
        events.push(event);
        for (const waiter of waiters.splice(0)) waiter();
      } else if (line.startsWith("{")) {
        const failure = JSON.parse(line);
        // D0023 product diagnostics are JSON lines; identify the producer and event, never a retired text prefix.
        if (failure.component === "session-message-hook" && failure.event === "peer-hook-failure") {
          productFailures.push({ phase: failure.phase, reason: failure.reason, step: failure.step ?? null });
        }
      }
    }
  });
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    clearTimeout(shutdownTimer);
    closedResult = { code, signal, elapsedMs: performance.now() - started };
    for (const waiter of waiters.splice(0)) waiter();
    resolve(closedResult);
  }));
  return {
    child, closed, events, productFailures,
    rawOutput() { return { stdout: output, stderr }; },
    async phase(phase) {
      while (!events.some(event => event.phase === phase)) {
        assert.equal(closedResult, undefined, `Owned child closed before ${phase}; launch=${launchError ?? "ok"}`);
        await bounded(new Promise(resolve => waiters.push(resolve)), CHILD_TIMEOUT_MS, phase);
      }
      return events.find(event => event.phase === phase);
    },
    async cleanup() {
      if (!closedResult) child.kill("SIGTERM");
      try { await bounded(closed, 2000, "SIGTERM close"); }
      catch (cause) {
        if (!closedResult) child.kill("SIGKILL");
        try { await bounded(closed, 2000, "SIGKILL close"); }
        catch (secondary) { throw new AggregateError([cause, secondary], "Owned child cleanup unconfirmed"); }
      }
      if (child.pid) assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" }, "Owned PID is still live");
    },
    summary() { return { ...closedResult, launchError: launchError ?? null, stdinError: stdinError ?? null,
      stdoutBytes: Buffer.byteLength(output), events, productFailures }; },
    assertCleanExit() {
      assert.equal(launchError, undefined, "Owned TEST launch failed");
      assert.equal(stdinError, undefined, "Owned TEST stdin failed");
      assert.equal(closedResult?.code, 0, "Owned TEST child did not exit successfully");
      assert.equal(closedResult?.signal, null);
    },
  };
}

function snapshot(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    return db.prepare(`SELECT message_id, delivery_attempts, claimed_at IS NOT NULL AS claimed,
      claim_until IS NOT NULL AS leased, claim_receipt IS NOT NULL AS receipt_present, acknowledged_at IS NOT NULL AS acked
      FROM messages ORDER BY message_id`).all().map(row => ({ ...row }));
  } finally { db.close(); }
}

async function fixture(t, run) {
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Requires Node24 or later TEST runtime");
  const directory = await mkdtemp(path.join(tmpdir(), "ags38-peer-elapsed-"));
  const state = path.join(directory, "messaging");
  await mkdir(state);
  const env = { ...process.env, XDG_STATE_HOME: directory, AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(directory, "shared"),
    AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: state, AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflow.sqlite3"), AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
    AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"),
    AGENT_GOVERNANCE_CODEX_QUEUE_WAKE: "0", AGENT_GOVERNANCE_ANTIGRAVITY_QUEUE_WAKE: "0", AGENT_GOVERNANCE_LOCALE: "en" };
  const children = [];
  const ownedLaunch = args => { const child = launch(args, env); children.push(child); return child; };
  let primary;
  try {
    const setup = ownedLaunch(["--import", "tsx", helper, "setup", state]);
    setup.child.stdin.end();
    await bounded(setup.closed, CHILD_TIMEOUT_MS + 1000, "setup close");
    setup.assertCleanExit();
    assert.equal(setup.events.filter(event => event.phase === "setup-complete").length, 1);
    await setup.cleanup();
    const database = path.join(state, "session-messages.sqlite3");
    const before = snapshot(database);
    assert.equal(before.length, 1);
    assert.deepEqual(before.map(row => [row.delivery_attempts, row.claimed, row.leased, row.receipt_present, row.acked]), [[0, 0, 0, 0, 0]]);
    await run({ state, database, before, ownedLaunch });
  } catch (error) { primary = error; }
  const cleanupErrors = [];
  for (const child of children) {
    try { await child.cleanup(); } catch (error) { cleanupErrors.push(error); }
    t.diagnostic(JSON.stringify({ observation: "ags38-peer-elapsed", ...child.summary() }));
  }
  // Preserve owned raw failure evidence without printing input, environment or receipt values.
  if (primary || cleanupErrors.length) {
    try {
      for (const [index, child] of children.entries()) {
        for (const [stream, content] of Object.entries(child.rawOutput())) {
          await writeFile(path.join(directory, `child-${index + 1}.${stream}`), content);
        }
      }
      t.diagnostic(JSON.stringify({ ownedFailureArtifacts: directory }));
    } catch (error) { cleanupErrors.push(error); }
  } else {
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  }
  if (primary && cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], "TEST and cleanup failed", { cause: primary });
  if (primary) throw primary;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "TEST cleanup failed");
}

test("PB06: actual shared CLI expires at its original 6500ms budget before claiming", { timeout: 25_000 }, async t => {
  await fixture(t, async ({ database, before, ownedLaunch }) => {
    t.diagnostic(JSON.stringify({ entrySha256: createHash("sha256").update(await readFile(entry)).digest("hex"),
      originalDeadlineMs: DEADLINE_MS, claimReserveMs: 1000, evidence: "real-clock-shared-CLI; not Claude overlay" }));
    const cli = ownedLaunch(["--import", pathToFileURL(preload).href, entry, "--host=codex"]);
    const ready = await cli.phase("preload-ready");
    await bounded(delay(Math.max(0, DEADLINE_MS - ready.nowMs + 100)), CHILD_TIMEOUT_MS, "original elapsed budget");
    cli.child.stdin.end(stop);
    await bounded(cli.closed, CHILD_TIMEOUT_MS + 1000, "CLI close");
    cli.assertCleanExit();
    assert.equal(cli.events.filter(event => event.phase === "stdin-return").length, 1);
    assert.ok(cli.events.find(event => event.phase === "stdin-return").nowMs >= DEADLINE_MS);
    assert.deepEqual(cli.productFailures.map(failure => failure.reason), ["HOOK_BUDGET_EXPIRED"]);
    assert.equal(cli.productFailures[0].phase, "options");
    assert.equal(cli.summary().stdoutBytes, 0);
    assert.deepEqual(snapshot(database), before);
  });
});

for (const interrupt of [false, true]) {
  test(interrupt ? "PB08: OS termination of an owned blocked child leaves no claim or ACK"
    : "PB07: actual SQLite writer lock respects the original claim deadline without replay", { timeout: 25_000 }, async t => {
    await fixture(t, async ({ state, database, before, ownedLaunch }) => {
      const holder = new DatabaseSync(database);
      let primary;
      try {
        holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
        const worker = ownedLaunch(["--import", "tsx", helper, "request", state]);
        worker.child.stdin.end();
        const attempted = await worker.phase("operation-attempt");
        assert.equal(attempted.attempts, 1);
        assert.ok(attempted.nowMs < 5500, "Fixture started after original claim deadline");
        await worker.phase("writer-wait-enter");
        if (interrupt) assert.equal(worker.child.kill("SIGTERM"), true, "Owned OS termination was not sent");
        const result = await bounded(worker.closed, CHILD_TIMEOUT_MS + 1000, "request close");
        assert.equal(worker.events.filter(event => event.phase === "operation-attempt").length, 1);
        assert.equal(worker.events.filter(event => event.phase === "writer-wait-enter").length, 1);
        assert.equal(worker.events.some(event => event.phase === "writer-wait-return"), false);
        if (interrupt) {
          assert.ok(result.signal !== null || result.code !== 0, "OS termination became a successful client outcome");
          assert.equal(worker.events.some(event => event.phase === "request-failed" || event.phase === "request-complete"), false);
          assert.equal(worker.events.some(event => event.phase === "writer-wait-failed"), false);
          t.diagnostic("PB08 evidence is OS child termination, not cooperative cancellation or Claude native cancellation");
        } else {
          worker.assertCleanExit();
          const failed = worker.events.filter(event => event.phase === "request-failed");
          assert.equal(failed.length, 1);
          assert.equal(failed[0].reason, "MESSAGING_BUSY");
          assert.equal(failed[0].attempts, 1);
          assert.equal(worker.events.filter(event => event.phase === "writer-wait-failed").length, 1);
          assert.ok(failed[0].nowMs <= CHILD_TIMEOUT_MS, "Busy operation outlived the unchanged host deadline");
          assert.equal(worker.events.filter(event => event.phase === "client-closed").length, 1);
        }
        await worker.cleanup();
      } catch (error) { primary = error; }
      let cleanup;
      try { if (holder.isTransaction) holder.exec("ROLLBACK;"); } catch (error) { cleanup = error; }
      try { holder.close(); } catch (error) { cleanup = cleanup ? new AggregateError([cleanup, error], "Lock release failed") : error; }
      if (primary && cleanup) throw new AggregateError([primary, cleanup], "TEST and lock cleanup failed", { cause: primary });
      if (primary) throw primary;
      if (cleanup) throw cleanup;
      assert.deepEqual(snapshot(database), before);
    });
  });
}
