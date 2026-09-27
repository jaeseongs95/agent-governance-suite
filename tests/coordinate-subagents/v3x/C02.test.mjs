import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { test } from 'vitest';
import { CONTEXT_TRANSITION_ACTIONS } from '../../../contracts/types.ts';
import { evaluateSafeBoundary } from '../../../mcp-server/src/context-transition/safe-boundary.ts';

const now = 1000;
const scope = { taskId: 'task-1', revision: 2, contextGeneration: 3,
  receiver: { host: 'codex', sessionId: 'session-1', instanceId: 'instance-1' } };
const intent = action => ({ schemaVersion: '1.0.0', kind: 'context-transition-intent', status: 'request', action,
  binding: { ...structuredClone(scope), transitionId: 'transition-1', checkpoint: { schemaVersion: '1.0.0',
    namespace: 'checkpoint-evidence', id: 'checkpoint-1', digest: `sha256:${'a'.repeat(64)}`,
    hashDomain: 'raw-bytes', size: 1, mediaType: 'application/json' } } });
const fields = ['workflowMutation', 'activeJobs', 'activeChildren', 'pendingIntents'];
const snapshot = () => ({ scope: structuredClone(scope), ...Object.fromEntries(fields.map(field => [field,
  { sourceId: `${field}-tracker`, availability: 'available', observedAtMs: 900, expiresAtMs: 1100,
    value: field === 'workflowMutation' ? false : 0 }])) });
function blocked(activity, boundary, ...times) {
  // Preserve an explicitly supplied undefined clock; it must not become a valid default.
  const time = times.length === 0 ? now : times[0];
  for (const action of CONTEXT_TRANSITION_ACTIONS) {
    const decision = evaluateSafeBoundary(intent(action), activity, time);
    assert.equal(decision.action, 'CONTINUE');
    assert.equal(decision.reviewAllowed, false);
    assert.equal(decision.boundary, boundary);
  }
}

test('C02 only explicit fresh idle observations permit transition review; CONTINUE is normal', () => {
  for (const action of CONTEXT_TRANSITION_ACTIONS) {
    const decision = evaluateSafeBoundary(intent(action), snapshot(), now);
    assert.deepEqual(decision, { boundary: 'safe', action, reviewAllowed: action !== 'CONTINUE', reason: 'explicit-safe' });
    assert.equal(Object.hasOwn(decision, 'approved'), false);
    assert.equal(Object.hasOwn(decision, 'status'), false);
    assert.equal(Object.hasOwn(decision, 'baseAck'), false);
  }
});

for (const field of fields) {
  test(`C02 ${field} blocks destructive review while activity exists`, () => {
    const activity = snapshot(); activity[field].value = field === 'workflowMutation' ? true : 1;
    blocked(activity, 'busy');
  });

  test(`C02 ${field} has independent source availability and freshness`, () => {
    for (const changes of [{ availability: 'unavailable' }, { availability: 'unknown' }, { availability: 'fresh' },
      { sourceId: '' }, { sourceId: ' ' }, { observedAtMs: null }, { observedAtMs: now + 1 },
      { observedAtMs: -1 }, { observedAtMs: NaN }, { observedAtMs: 900.1 },
      { expiresAtMs: null }, { expiresAtMs: now }, { expiresAtMs: now - 1 },
      { expiresAtMs: Number.MAX_SAFE_INTEGER + 1 }, { expiresAtMs: Infinity }]) {
      const activity = snapshot(); Object.assign(activity[field], changes); blocked(activity, 'unknown');
    }
    for (const value of [null, undefined]) {
      const activity = snapshot(); activity[field] = value; blocked(activity, 'unknown');
    }
    const missing = snapshot(); delete missing[field]; blocked(missing, 'unknown');
  });

  test(`C02 ${field} never treats missing or malformed values as idle`, () => {
    const invalid = field === 'workflowMutation' ? [null, undefined, 0, 1, 'false', 'idle', {}, []]
      : [null, undefined, false, '0', -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, []];
    for (const value of invalid) {
      const activity = snapshot(); activity[field].value = value; blocked(activity, 'unknown');
    }
  });
}

test('C02 absent snapshots and invalid judgment clocks remain unknown with CONTINUE', () => {
  for (const activity of [null, undefined, {}]) blocked(activity, 'unknown');
  for (const time of [null, undefined, -1, 1000.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    blocked(snapshot(), 'unknown', time);
  }
});

test('C02 safe observations for another task/revision/receiver/generation cannot permit review', () => {
  for (const changes of [{ taskId: 'task-2' }, { revision: 3 }, { contextGeneration: 4 }, { receiver: null },
    ...['host', 'sessionId', 'instanceId'].map(field => ({ receiver: { ...scope.receiver, [field]: 'other' } }))]) {
    const activity = snapshot(); Object.assign(activity.scope, changes); blocked(activity, 'unknown');
  }
});

test('C02 unknown action labels do not become transition review permission', () => {
  for (const action of ['FORK_INDEPENDENT', 'compact', null, undefined]) {
    const decision = evaluateSafeBoundary(intent(action), snapshot(), now);
    assert.deepEqual(decision, { boundary: 'unknown', action: 'CONTINUE', reviewAllowed: false, reason: 'unsupported-action' });
  }
});

test('C02 uses caller time and fresh reobservation without mutating input or caching a safe verdict', () => {
  const request = intent('CLOSE'); const activity = snapshot();
  const before = structuredClone({ request, activity });
  assert.equal(evaluateSafeBoundary(request, activity, now).reviewAllowed, true);
  blocked(activity, 'unknown', 1100);
  activity.pendingIntents.value = 1;
  assert.equal(evaluateSafeBoundary(request, activity, now).reviewAllowed, false);
  activity.pendingIntents.value = 0;
  assert.deepEqual({ request, activity }, before);
  Object.freeze(request); Object.freeze(request.binding); Object.freeze(activity); Object.freeze(activity.scope);
  for (const field of fields) Object.freeze(activity[field]);
  assert.equal(evaluateSafeBoundary(request, activity, now).reviewAllowed, true);
});

test('C02 activity port exposes only reads and its observation/scope contracts are immutable', () => {
  // C01 uses the same virtual compiler pattern; this produces no fixture files.
  const virtual = path.join(fileURLToPath(new URL('../../../', import.meta.url)), 'mcp-server', 'src',
    'context-transition', '__c02_readonly_virtual.ts');
  const source = `import type { ActivitySnapshotPort, ActivitySnapshotV1 } from './safe-boundary.js';
    const port: ActivitySnapshotPort = { async readActivitySnapshot() { return null; } };
    declare const activity: ActivitySnapshotV1;
    // @ts-expect-error the activity port has no destructive operation
    port.close();
    // @ts-expect-error the snapshot cannot be edited through this contract
    activity.pendingIntents = activity.activeJobs;
    // @ts-expect-error individual observations are readonly
    activity.activeJobs.value = 0;
    // @ts-expect-error task/revision/generation scope is readonly
    activity.scope.revision = 3;
    // @ts-expect-error receiver identity is readonly
    activity.scope.receiver.instanceId = 'other';`;
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host); const exists = host.fileExists.bind(host);
  host.fileExists = file => path.normalize(file) === virtual || exists(file);
  host.getSourceFile = (file, version, onError, shouldCreate) => path.normalize(file) === virtual
    ? ts.createSourceFile(file, source, version, true) : original(file, version, onError, shouldCreate);
  assert.deepEqual(ts.getPreEmitDiagnostics(ts.createProgram([virtual], options, host))
    .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});
