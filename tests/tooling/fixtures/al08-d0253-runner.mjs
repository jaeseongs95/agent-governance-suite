// Copied unchanged to the fixture's runtime/engineering-practices/runner.mjs.
// This diagnostic fixture never executes argv or the original OS race tests.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertReceipt, seal, verifySnapshot } from './core.mjs';
import { hashBytes } from './io.mjs';

export function runCommand(root, snapshot, argv, options) {
  verifySnapshot(root, snapshot);
  assert.equal(options.timeoutMs, 45_000);
  const fixture = JSON.parse(readFileSync(path.join(root, 'diagnostic-fixture.json'), 'utf8'));
  const caseId = argv[argv.indexOf('-t') + 1].slice(0, -1);
  assert(['OS-001', 'OS-002', 'OS-003'].includes(caseId));
  const red = snapshot.files.find(file => file.path === 'mcp-server/src/broker-process-lock.ts').digest !== fixture.productionDigest;
  appendFileSync(fixture.callsFile, JSON.stringify({ caseId, red, timeoutMs: options.timeoutMs }) + '\n');
  if (fixture.mode === (red ? 'red-throw' : 'green-throw')) {
    const error = new Error(`PRIVATE_RUNNER_SENTINEL:${caseId}:${red ? 'red' : 'green'}`);
    error.code = 'EIO';
    throw error;
  }
  const outputFile = path.resolve(root, argv.find(arg => arg.startsWith('--outputFile=')).slice('--outputFile='.length));
  const message = fixture.mode === 'green-reject' ? {
    'OS-001': 'promise resolved instead of rejecting', 'OS-002': 'expected acquired contended',
    'OS-003': 'ENOENT scandir broker.lock',
  }[caseId] : 'SyntaxError PRIVATE_REPORT_SENTINEL: fixture dependency could not load';
  const failed = red || fixture.mode === 'green-reject';
  const report = { numTotalTests: 1, numFailedTests: failed ? 1 : 0, numFailedTestSuites: failed ? 1 : 0,
    numPassedTests: failed ? 0 : 1, numPendingTests: 0,
    testResults: [{ assertionResults: [{ fullName: `${caseId}: deterministic diagnostic fixture`,
      status: failed ? 'failed' : 'passed', failureMessages: failed ? [message] : [] }] }] };
  if (!(fixture.mode === 'report-missing' && !red)) writeFileSync(outputFile, JSON.stringify(report), { flag: 'wx' });
  const stdout = red ? message : 'fixture green';
  const status = red ? (fixture.mode === 'spawn-error' ? 'SPAWN_ERROR' : 'FAIL') : failed ? 'FAIL' : 'PASS';
  return assertReceipt(seal({ schemaVersion: '1.0.0', kind: 'engineering-run-receipt', argv, snapshot,
    afterDigest: snapshot.digest, startedAt: `2026-10-26T00:00:0${red ? '0' : '2'}.000Z`,
    finishedAt: `2026-10-26T00:00:0${red ? '1' : '3'}.000Z`, status,
    exitCode: status === 'SPAWN_ERROR' ? null : failed ? 1 : 0, signal: null,
    stdout, stderr: '', stdoutDigest: hashBytes(stdout), stderrDigest: hashBytes(''),
    timeoutMs: options.timeoutMs, executable: argv[0], nodeVersion: process.versions.node,
    platform: process.platform, environmentNote: options.environmentNote }));
}
