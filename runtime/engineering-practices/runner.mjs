// Capture a command explicitly supplied by the caller. Never execute a command from a report, rule, log or downloaded document.
// This runner is NOT a sandbox. timeout terminates the direct child; descendants may outlive it on some platforms.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { verifySnapshot, captureSnapshot, seal, assertReceipt } from './core.mjs';
import { requireCondition as need, hashBytes } from './io.mjs';
export function runCommand(root, snapshot, argv, { timeoutMs = 30000, environmentNote = 'Inherited process environment; undeclared environmental inputs are not captured.' } = {}) {
  need(Array.isArray(argv) && argv.length > 0 && argv.length <= 128 && argv.every(x => typeof x === 'string' && x.length > 0 && !x.includes('\0')), 'INVALID_INPUT', 'Explicit bounded argv is required.');
  need(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300000, 'INVALID_INPUT', 'timeoutMs must be within 1..300000.');
  need(typeof environmentNote === 'string' && environmentNote.trim(), 'INVALID_INPUT', 'Environment note is required.');
  verifySnapshot(root, snapshot);
  // Prevent the parent node:test harness from suppressing a nested --test invocation.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  environmentNote += ' Child NODE_TEST_CONTEXT is cleared to avoid nested-runner suppression.';
  const startedAt = new Date().toISOString();
  const child = spawnSync(argv[0], argv.slice(1), { cwd: path.resolve(root), shell: false, env: childEnv, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const finishedAt = new Date().toISOString();
  let afterDigest;
  try { afterDigest = captureSnapshot(root, snapshot.files.map(f => f.path)).digest; }
  catch { afterDigest = hashBytes('Snapshot became unreadable after command execution.'); }
  const stdout = child.stdout ?? '', stderr = child.stderr ?? '';
  let status;
  if (afterDigest !== snapshot.digest) status = 'INPUT_CHANGED';
  else if (child.error?.code === 'ETIMEDOUT') status = 'TIMED_OUT';
  else if (child.error || child.signal) status = 'SPAWN_ERROR';
  else status = child.status === 0 ? 'PASS' : 'FAIL';
  const receipt = seal({ schemaVersion: '1.0.0', kind: 'engineering-run-receipt', argv, snapshot, afterDigest, startedAt, finishedAt, status, exitCode: child.status ?? null, signal: child.signal ?? null, stdout, stderr, stdoutDigest: hashBytes(stdout), stderrDigest: hashBytes(stderr), timeoutMs, executable: argv[0], nodeVersion: process.versions.node, platform: process.platform, environmentNote });
  return assertReceipt(receipt);
}
