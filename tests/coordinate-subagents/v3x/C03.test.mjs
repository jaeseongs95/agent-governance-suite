import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { checkpointTransitionContext } from '../../../mcp-server/src/context-transition/checkpoint-bridge.ts';
import { ContinuityService, UnavailableContinuityService } from '../../../mcp-server/src/continuity-service.ts';
import { SqliteContinuityStore } from '../../../mcp-server/src/continuity-store.ts';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';

const stores = [];
const directories = [];
const session = 'c03-fixture-session';
const fixedTime = Date.parse('2026-09-28T00:00:00.000Z');

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    // Only remove this suite's mkdtemp children, including SQLite WAL/shm files.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('ags-c03-'));
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(now = () => new Date(fixedTime)) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ags-c03-'));
  directories.push(directory);
  const databasePath = path.join(directory, 'continuity.sqlite3');
  return { directory, databasePath, service: connect(databasePath, now) };
}

function connect(databasePath, now = () => new Date(fixedTime)) {
  const store = new SqliteContinuityStore(databasePath);
  stores.push(store);
  return new ContinuityService(store, new ContractValidator(), null, now);
}

function input(overrides = {}) {
  return { schemaVersion: '1.0.0', requestId: 'checkpoint-1', expectedRevision: 0, status: 'active',
    core: { objective: 'Preserve the current task.', completionCriteria: ['Verify the stored evidence.'],
      constraints: ['Keep host effects separate.'], decisions: ['Reuse the existing checkpoint CAS.'],
      progress: ['A checkpoint is requested.'], blockers: ['Await independent review.'],
      nextActions: ['Historical candidate: review this checkpoint.'] },
    evidenceRefs: [true, false].map(verified => ({ artifactId: `evidence-${verified}`,
      locator: 'fixture://checkpoint', digest: convergenceDigest(`evidence-${verified}`), verified })),
    ...overrides };
}

function bound(service, value = input(), tool = 'checkpoint_context') {
  return { ...value, _continuityBinding: service.issueToolBinding(session, tool, value) };
}

function snapshot(service) {
  return service.store.getSnapshot(service.correlateSession(session), 1);
}

function receipt(service, requestId) {
  return service.store.getRequest(service.correlateSession(session), 1, service.hashOpaque('request', requestId));
}

function rejectedWithoutWrite(service, request, code) {
  const before = { request: structuredClone(request), snapshot: snapshot(service), receipt: receipt(service, request.requestId) };
  const result = checkpointTransitionContext(service, request);
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.equal(result.error.code, code);
  assert.deepEqual(request, before.request);
  assert.deepEqual(snapshot(service), before.snapshot);
  assert.deepEqual(receipt(service, request.requestId), before.receipt);
  return result;
}

test('C03 delegates the exact request once and returns success or failure without adding authority', () => {
  const { service } = fixture();
  const request = Object.freeze(bound(service));
  const success = service.checkpointContext(request);
  assert.equal(success.ok, true);
  for (const response of [
    success,
    { schemaVersion: '1.0.0', ok: false, data: null, error: { code: 'STALE_REVISION', message: 'stale', details: null } },
  ]) {
    let calls = 0;
    const gateway = { checkpointContext(value) {
      calls += 1;
      assert.equal(this, gateway);
      assert.equal(value, request);
      return response;
    } };
    const before = structuredClone(request);
    assert.equal(checkpointTransitionContext(gateway, request), response);
    assert.equal(calls, 1);
    assert.deepEqual(request, before);
  }
});

test('C03 propagates a gateway exception without retry or synthetic success', () => {
  const failure = new Error('fixture gateway failure');
  let calls = 0;
  const gateway = { checkpointContext() { calls += 1; throw failure; } };
  assert.throws(() => checkpointTransitionContext(gateway, { ...input(), _continuityBinding: 'provided-binding' }),
    error => error === failure);
  assert.equal(calls, 1);
});

test('C03 stores all supplied core, evidence and status values through the existing SQLite service', () => {
  const { service, directory } = fixture();
  for (const [index, status] of ['active', 'paused', 'completed'].entries()) {
    const request = bound(service, input({ requestId: `checkpoint-${index}`, expectedRevision: index, status }));
    const before = structuredClone(request);
    const result = checkpointTransitionContext(service, request);
    assert.equal(result.ok, true);
    assert.equal(result.data.revision, index + 1);
    assert.equal(result.data.source, 'direct');
    assert.equal(result.data.status, status);
    assert.deepEqual(result.data.core, before.core);
    assert.deepEqual(result.data.evidenceRefs, before.evidenceRefs);
    assert.deepEqual(snapshot(service), result.data);
    assert.deepEqual(request, before);
    assert.equal(Object.hasOwn(result.data, '_continuityBinding'), false);
  }
  assert.ok(readdirSync(directory).every(name => /^continuity\.sqlite3(?:-wal|-shm)?$/.test(name)));
});

test('C03 two sequential SQLite connections preserve CAS losers without storing their receipts', () => {
  const { service: first, databasePath } = fixture();
  const second = connect(databasePath);
  const winner = checkpointTransitionContext(first, bound(first));
  assert.equal(winner.ok, true);
  assert.equal(winner.data.revision, 1);
  const loser = bound(second, input({ requestId: 'loser-1' }));
  assert.equal(rejectedWithoutWrite(second, loser, 'STALE_REVISION').error.details.actualRevision, 1);
  assert.equal(receipt(first, loser.requestId), null);
  assert.deepEqual(snapshot(first), winner.data);

  const next = checkpointTransitionContext(second, bound(second, input({ requestId: 'winner-2', expectedRevision: 1 })));
  assert.equal(next.ok, true);
  assert.equal(next.data.revision, 2);
  const stale = bound(first, input({ requestId: 'loser-2', expectedRevision: 1 }));
  rejectedWithoutWrite(first, stale, 'STALE_REVISION');
  assert.equal(receipt(second, stale.requestId), null);
  assert.deepEqual(snapshot(second), next.data);
});

test('C03 replays an identical requestId and rejects changed content without changing its receipt', () => {
  const { service } = fixture();
  const request = bound(service);
  const first = checkpointTransitionContext(service, request);
  assert.equal(first.ok, true);
  const storedReceipt = receipt(service, request.requestId);
  assert.deepEqual(checkpointTransitionContext(service, bound(service)), first);
  assert.deepEqual(receipt(service, request.requestId), storedReceipt);
  const conflict = input(); conflict.core.objective = 'Different task content.';
  rejectedWithoutWrite(service, bound(service, conflict), 'REQUEST_CONFLICT');
  assert.deepEqual(receipt(service, request.requestId), storedReceipt);
});

test('C03 old checkpoint replay stays stale after replacement and purge', () => {
  const { service } = fixture();
  assert.equal(checkpointTransitionContext(service, bound(service)).ok, true);
  const replacement = input({ requestId: 'replacement', expectedRevision: 1 });
  const second = checkpointTransitionContext(service, bound(service, replacement));
  assert.equal(second.ok, true);
  rejectedWithoutWrite(service, bound(service), 'STALE_REVISION');
  const purge = { schemaVersion: '1.0.0', requestId: 'purge', expectedEpoch: 1, expectedRevision: second.data.revision };
  assert.equal(service.purgeDirectContext(bound(service, purge, 'purge_direct_context')).ok, true);
  assert.equal(snapshot(service), null);
  const tombstone = service.store.getTombstone(service.correlateSession(session), 1);
  rejectedWithoutWrite(service, bound(service), 'STALE_REVISION');
  rejectedWithoutWrite(service, bound(service, replacement), 'STALE_REVISION');
  assert.deepEqual(service.store.getTombstone(service.correlateSession(session), 1), tombstone);
});

test('C03 does not manufacture missing core or binding values', () => {
  const { service } = fixture();
  assert.equal(checkpointTransitionContext(service, bound(service)).ok, true);
  const missingCore = input({ requestId: 'missing-core', expectedRevision: 1 }); delete missingCore.core;
  rejectedWithoutWrite(service, bound(service, missingCore), 'INVALID_INPUT');
  const missingBinding = input({ requestId: 'missing-binding', expectedRevision: 1 });
  rejectedWithoutWrite(service, missingBinding, 'INVALID_INPUT');
  const shortToken = bound(service, input({ requestId: 'short-token', expectedRevision: 1 }));
  shortToken._continuityBinding = 'invalid-token';
  rejectedWithoutWrite(service, shortToken, 'INVALID_INPUT');
});

test('C03 retains invalid, changed-input and wrong-tool binding rejections', () => {
  const { service } = fixture();
  assert.equal(checkpointTransitionContext(service, bound(service)).ok, true);
  const malformed = bound(service, input({ requestId: 'malformed', expectedRevision: 1 }));
  const [body, signature] = malformed._continuityBinding.split('.');
  malformed._continuityBinding = `${body}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  rejectedWithoutWrite(service, malformed, 'BINDING_INVALID');
  const changed = bound(service, input({ requestId: 'changed', expectedRevision: 1 }));
  changed.core.decisions.push('Unbound change.');
  rejectedWithoutWrite(service, changed, 'BINDING_INVALID');
  const wrongTool = bound(service, input({ requestId: 'wrong-tool', expectedRevision: 1 }), 'inspect_context');
  rejectedWithoutWrite(service, wrongTool, 'BINDING_INVALID');
});

test('C03 rejects an old epoch token while preserving the old snapshot and leaving the new epoch empty', () => {
  const { service } = fixture();
  assert.equal(checkpointTransitionContext(service, bound(service)).ok, true);
  const old = bound(service, input({ requestId: 'old-epoch', expectedRevision: 1 }));
  assert.equal(service.clearSession(session).currentEpoch, 2);
  rejectedWithoutWrite(service, old, 'BINDING_INVALID');
  assert.equal(service.store.getSnapshot(service.correlateSession(session), 2), null);
});

test('C03 rejects an expired binding without refreshing it', () => {
  let time = fixedTime;
  const { service } = fixture(() => new Date(time));
  assert.equal(checkpointTransitionContext(service, bound(service)).ok, true);
  const expired = bound(service, input({ requestId: 'expired', expectedRevision: 1 }));
  time += 301_000;
  rejectedWithoutWrite(service, expired, 'BINDING_INVALID');
});

test('C03 cannot replace a direct checkpoint after its task has a workflow root binding', () => {
  const { service } = fixture();
  assert.equal(checkpointTransitionContext(service, bound(service)).ok, true);
  // Lifecycle fixture binding only; this test does not exercise workflow admission.
  service.bindOpenedRoot(bound(service, { schemaVersion: '1.0.0' }, 'open_convergence_root'), 'fixture-root');
  assert.equal(service.store.getTask(service.correlateSession(session)).rootId, 'fixture-root');
  rejectedWithoutWrite(service, bound(service, input({ requestId: 'after-root', expectedRevision: 1 })), 'SNAPSHOT_CONFLICT');
});

test('C03 preserves unavailable results and does not recover by creating another database', () => {
  const { service, databasePath, directory } = fixture();
  assert.equal(checkpointTransitionContext(service, bound(service)).ok, true);
  const before = snapshot(service);
  const request = bound(service, input({ requestId: 'unavailable', expectedRevision: 1 }));
  service.store.close();
  for (const gateway of [service, new UnavailableContinuityService()]) {
    const result = checkpointTransitionContext(gateway, request);
    assert.equal(result.ok, false);
    assert.equal(result.data, null);
    assert.equal(result.error.code, 'CONTINUITY_UNAVAILABLE');
  }
  const reopened = connect(databasePath);
  assert.deepEqual(snapshot(reopened), before);
  assert.equal(receipt(reopened, request.requestId), null);
  assert.ok(readdirSync(directory).every(name => /^continuity\.sqlite3(?:-wal|-shm)?$/.test(name)));
});
