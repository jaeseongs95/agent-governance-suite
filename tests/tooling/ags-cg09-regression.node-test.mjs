import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { captureSnapshot, assertReceipt } from '../../runtime/engineering-practices/core.mjs';
import { runCommand } from '../../runtime/engineering-practices/runner.mjs';
import { execute } from '../../runtime/engineering-practices/cli.mjs';
import { hashBytes } from '../../runtime/engineering-practices/io.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-cg09-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'candidate.txt'), 'fixed candidate\n');
  return { root, snapshot: captureSnapshot(root, ['candidate.txt']) };
}

for (const invalid of ['long-argv-item', 'long-appended-environment-note']) {
  test(`D0148 ${invalid} is rejected before the command effect`, t => {
    const { root, snapshot } = fixture(t);
    const argv = [process.execPath, '-e', 'require("node:fs").writeFileSync("effect.txt","effect")'];
    const options = {};
    if (invalid === 'long-argv-item') argv.push('x'.repeat(8193));
    else options.environmentNote = 'x'.repeat(8192);
    assert.throws(() => runCommand(root, snapshot, argv, options), /schema validation failed/);
    assert.equal(existsSync(path.join(root, 'effect.txt')), false);
  });
}

test('D0148 a valid command still returns its actual effect and a valid receipt', t => {
  const { root, snapshot } = fixture(t);
  const receipt = runCommand(root, snapshot, [process.execPath, '-e', 'require("node:fs").writeFileSync("effect.txt","effect");console.log("observed")']);
  assert.equal(receipt.status, 'PASS');
  assert.equal(readFileSync(path.join(root, 'effect.txt'), 'utf8'), 'effect');
  assert.equal(receipt.stdout.trim(), 'observed');
  assertReceipt(receipt);
});

test('D0150 provider body and digest use the same bytes when the file is replaced after its first read', t => {
  const { root } = fixture(t);
  const target = path.join(fs.realpathSync(root), 'result.json');
  const result = { schemaVersion: '1.0.0', kind: 'engineering-plan-result', verdict: 'READY', planDigest: 'sha256:' + 'a'.repeat(64), caseIds: ['A'] };
  const first = JSON.stringify(result, null, 4) + '\n';
  const second = JSON.stringify({ ...result, planDigest: 'sha256:' + 'b'.repeat(64) }) + '\n';
  writeFileSync(target, first);
  const realOpen = fs.openSync, realClose = fs.closeSync;
  const targetDescriptors = new Set();
  let replaced = false;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = realOpen(file, ...args);
    if (String(file) === target) targetDescriptors.add(fd);
    return fd;
  });
  t.mock.method(fs, 'closeSync', fd => {
    const wasTarget = targetDescriptors.delete(fd);
    const value = realClose(fd);
    if (wasTarget && !replaced) { replaced = true; writeFileSync(target, second); }
    return value;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const response = execute(['provider-result', '--root', root, '--capability', 'test-plan-validation', '--result', 'result.json', '--locator', 'result.json']);
  assert.equal(replaced, true, 'the replacement fault must actually reach the file read');
  assert.equal(readFileSync(target, 'utf8'), second);
  assert.equal(response.value.output.planDigest, result.planDigest);
  assert.equal(response.value.artifacts[0].digest, hashBytes(Buffer.from(first)));
  assert.equal(response.value.artifacts[0].verified, false);
});

test('D0151 a direct child timeout is diagnostic rather than ordinary failing test evidence', t => {
  const { root, snapshot } = fixture(t);
  const receipt = runCommand(root, snapshot, [process.execPath, '-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.equal(receipt.status, 'TIMED_OUT');
  assert.notEqual(receipt.status, 'FAIL');
  assertReceipt(receipt);
});

test('D0151 POSIX TERM-ignoring direct child is killed, with an independent test watchdog', async t => {
  if (process.platform === 'win32') { t.skip('POSIX signal-handler behavior; ordinary timeout case still covers Windows'); return; }
  const { root, snapshot } = fixture(t);
  const snapshotPath = path.join(root, 'snapshot.json');
  const receiptPath = path.join(root, 'receipt.json');
  const readyPath = path.join(root, 'ready');
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  const runnerUrl = pathToFileURL(path.resolve(import.meta.dirname, '../../runtime/engineering-practices/runner.mjs')).href;
  const childCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(readyPath)},'ready');setInterval(()=>{},1000);`;
  const workerCode = `import {readFileSync,writeFileSync} from 'node:fs';import {runCommand} from ${JSON.stringify(runnerUrl)};const r=runCommand(${JSON.stringify(root)},JSON.parse(readFileSync(${JSON.stringify(snapshotPath)},'utf8')),[process.execPath,'-e',${JSON.stringify(childCode)}],{timeoutMs:1000});writeFileSync(${JSON.stringify(receiptPath)},JSON.stringify(r));`;
  const workerEnv = { ...process.env }; delete workerEnv.NODE_TEST_CONTEXT;
  const worker = spawn(process.execPath, ['--input-type=module', '-e', workerCode], { env: workerEnv, detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '', overdue = false, workerError = null;
  worker.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString(); });
  const killOwnedGroup = () => {
    if (!Number.isSafeInteger(worker.pid) || worker.exitCode !== null || worker.signalCode !== null) return;
    try { process.kill(-worker.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  const watchdog = setTimeout(() => {
    overdue = true;
    killOwnedGroup();
  }, 6000);
  t.after(() => { clearTimeout(watchdog); killOwnedGroup(); });
  const closed = await new Promise(resolve => {
    worker.on('error', error => { workerError = error; });
    worker.on('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(watchdog);
  // Only this test's detached worker process group is a cleanup target; no PID-file lookup or caller group is used.
  assert.equal(workerError, null);
  assert.equal(overdue, false, 'the original SIGTERM-only runner reaches this independent watchdog');
  assert.equal(closed.code, 0, stderr);
  assert.equal(existsSync(readyPath), true, 'the child must have installed its SIGTERM handler');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.status, 'TIMED_OUT');
  assert.equal(receipt.signal, 'SIGKILL');
  assertReceipt(receipt);
  // This narrowly exercises a scheduled direct child, not arbitrary descendants/OS hard-return bounds.
});
