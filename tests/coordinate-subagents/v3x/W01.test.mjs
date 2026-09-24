import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { assertSessionTaskTransitionV1 } from '../../../contracts/types.ts';

const schema = JSON.parse(readFileSync(new URL('../../../contracts/session-task.v1.schema.json', import.meta.url), 'utf8'));
const validate = addFormats(new Ajv2020({ allErrors: true })).compile(schema);
const sender = { host: 'portable-host', sessionId: 'sender-session', instanceId: 'sender-instance' };
const callbackTarget = { host: sender.host, sessionId: sender.sessionId };
const recipient = { host: 'another-host', sessionId: 'recipient-session' };
const actor = { ...recipient, instanceId: 'recipient-instance' };
const request = {
  schemaVersion: '1.0.0', kind: 'request', requestId: 'request-0001', taskId: 'task-0001',
  sender, recipient, callbackTarget, revision: 1,
  requestedAt: '2026-09-24T00:00:00Z', expiresAt: '2026-09-25T00:00:00Z', authorityEffect: 'none',
};
const outcome = {
  schemaVersion: '1.0.0', kind: 'terminal-outcome', requestId: request.requestId,
  taskId: request.taskId, actor, callbackTarget, revision: 2,
  result: 'COMPLETED', evidenceRefs: ['handoffs/task-0001.md'],
  reportedAt: '2026-09-24T01:00:00Z', authorityEffect: 'none',
};
const activity = {
  schemaVersion: '1.0.0', kind: 'activity-observation', actor, revision: 1,
  activity: 'idle', source: 'host-observed', observedAt: '2026-09-24T01:00:00Z',
  authorityEffect: 'none',
};
const requestContext = { authenticatedActor: sender, currentInstanceId: sender.instanceId, revisionStream: 'task', currentRevision: 0, boundTaskId: request.taskId };
const outcomeContext = { authenticatedActor: actor, currentInstanceId: actor.instanceId, revisionStream: 'task', currentRevision: 1, boundTaskId: request.taskId, request };

test('W01 host-neutral request, terminal report and activity schemas reject implicit completion and host extensions', () => {
  for (const event of [request, outcome, activity]) assert.equal(validate(event), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...request, taskId: 'W01', sender: { ...sender, instanceId: 'i' } }), true);
  for (const invalid of [
    { ...outcome, kind: 'session-end' },
    { ...outcome, result: 'ACK' },
    { ...outcome, acceptanceVerdict: 'PASS' },
    { ...activity, activity: 'CodexStop' },
    { ...activity, source: 'ClaudeSessionEnd' },
    { ...request, authorityEffect: 'approve' },
    { ...outcome, reportedAt: 'not-a-date' },
    { ...outcome, callbackTarget: undefined },
    { ...outcome, callbackTarget: sender },
  ]) assert.equal(validate(invalid), false);
});

test('W01 callback is bound to authenticated sender and stored request', () => {
  assert.equal(assertSessionTaskTransitionV1(request, requestContext), 'new');
  assert.equal(assertSessionTaskTransitionV1(outcome, outcomeContext), 'new');
  assert.throws(() => assertSessionTaskTransitionV1({ ...request, callbackTarget: recipient }, requestContext), /CALLBACK_TARGET_MISMATCH/);
  assert.throws(() => assertSessionTaskTransitionV1({ ...outcome, callbackTarget: recipient }, outcomeContext), /REQUEST_BINDING_MISMATCH/);
  assert.throws(() => assertSessionTaskTransitionV1({ ...outcome, requestId: 'request-0002' }, outcomeContext), /REQUEST_BINDING_MISMATCH/);
  assert.throws(() => assertSessionTaskTransitionV1(request, { ...requestContext, boundTaskId: 'other-task' }), /BINDING_MISMATCH/);
});

test('W01 exact request retry is a no-op while conflicting request is rejected', () => {
  const persisted = { ...requestContext, currentRevision: 1, request };
  assert.equal(assertSessionTaskTransitionV1(request, persisted), 'duplicate');
  assert.throws(() => assertSessionTaskTransitionV1({ ...request, recipient: { ...recipient, sessionId: 'other-session' } }, persisted), /REQUEST_CONFLICT/);
  assert.throws(() => assertSessionTaskTransitionV1(request, { ...requestContext, revisionStream: 'activity', currentRevision: 5 }), /REVISION_STREAM_MISMATCH/);
});

test('W01 standalone task can report outcome without inventing a callback request', () => {
  const standalone = { ...outcome };
  delete standalone.requestId;
  delete standalone.callbackTarget;
  assert.equal(validate(standalone), true, JSON.stringify(validate.errors));
  assert.equal(assertSessionTaskTransitionV1(standalone, { ...outcomeContext, request: undefined }), 'new');
  assert.throws(() => assertSessionTaskTransitionV1(standalone, outcomeContext), /REQUEST_BINDING_MISMATCH/);
  assert.throws(() => assertSessionTaskTransitionV1(standalone, { ...outcomeContext, request: undefined, boundTaskId: 'other' }), /REQUEST_BINDING_MISMATCH/);
});

test('W01 old instance and revision cannot replace current activity or outcome', () => {
  assert.throws(() => assertSessionTaskTransitionV1(request, { ...requestContext, currentInstanceId: 'new-instance' }), /ACTOR_STALE/);
  assert.throws(() => assertSessionTaskTransitionV1(outcome, { ...outcomeContext, currentInstanceId: 'new-instance' }), /ACTOR_STALE/);
  assert.throws(() => assertSessionTaskTransitionV1(outcome, { ...outcomeContext, currentRevision: 2 }), /REVISION_STALE/);
  const activityContext = { authenticatedActor: actor, currentInstanceId: actor.instanceId, revisionStream: 'activity', currentRevision: 0, observedSource: 'host-observed' };
  assert.equal(assertSessionTaskTransitionV1(activity, activityContext), 'new');
  assert.throws(() => assertSessionTaskTransitionV1(activity, { ...activityContext, currentRevision: 1 }), /REVISION_STALE/);
  assert.throws(() => assertSessionTaskTransitionV1(activity, { ...activityContext, observedSource: 'self-reported' }), /SOURCE_UNVERIFIED/);
});

test('W01 repeated identical terminal report is a no-op; conflicting terminal reports fail closed', () => {
  const terminalContext = { ...outcomeContext, currentRevision: 2, terminalOutcome: outcome };
  assert.equal(assertSessionTaskTransitionV1(outcome, terminalContext), 'duplicate');
  assert.throws(() => assertSessionTaskTransitionV1({ ...outcome, result: 'BLOCKED' }, terminalContext), /TERMINAL_CONFLICT/);
  assert.throws(() => assertSessionTaskTransitionV1({ ...outcome, revision: 3 }, terminalContext), /TERMINAL_CONFLICT/);
  assert.throws(() => assertSessionTaskTransitionV1({ ...outcome, evidenceRefs: ['other.md'] }, terminalContext), /TERMINAL_CONFLICT/);
});
