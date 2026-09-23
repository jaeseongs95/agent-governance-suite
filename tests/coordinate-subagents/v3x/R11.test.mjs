import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';

const validator = new ContractValidator();
const digest = letter => `sha256:${letter.repeat(64)}`;
const requirements = () => ({
  inputModalities: ['text'], tools: ['git'], filesystem: 'read',
  allowedSurfaces: ['peer-session'], allowedRuntimeModes: [],
  allowNestedDelegation: false, requireObservable: ['model'],
  excludedActors: [], excludedSessions: [], contextMode: 'limited',
});
const slot = (index, routingRole) => ({
  schemaVersion: '1.0.0', kind: 'role-slot-projection',
  slotId: `slot-sha256:${String(index + 1).repeat(64)}`,
  authorization: { taskId: 'task-1', runId: 'run-1', stageId: `stage-${index + 1}`,
    assignmentId: `assignment-${index + 1}`, planRevision: 7,
    planDigest: digest('a'), authorizationDigest: digest('b') },
  slotIndex: index, slotCount: 2, purpose: routingRole === 'independent-audit' ? 'independent review' : 'implementation',
  routingRole, riskLevel: 'medium', highRisk: routingRole === 'independent-audit',
  independenceRequired: routingRole === 'independent-audit',
  requirements: { ...requirements(), excludedActors: routingRole === 'independent-audit' ? ['implementer'] : [] },
  executionAuthorized: false,
});
const approved = () => [slot(0, 'general-implementation'), slot(1, 'independent-audit')];
const check = (candidate, set = approved(), expectedSlotId = set[0].slotId) =>
  validator.roleSlotV1(candidate, set, expectedSlotId);

test('approved role slots bind count, position, revision and routing role', () => {
  const set = approved();
  assert.deepEqual(check(set[0], set), set[0]);
  assert.deepEqual(check(set[1], set, set[1].slotId), set[1]);
  assert.equal(set[1].highRisk, true);
  assert.equal(set[1].independenceRequired, true);
  assert.equal(set[1].requirements.excludedActors[0], 'implementer');
  assert.equal(set[1].executionAuthorized, false);
});

test('caller cannot create a role by changing slot ID, role, task, or approved position', () => {
  const set = approved();
  for (const mutation of [
    value => { value.slotId = `slot-sha256:${'f'.repeat(64)}`; },
    value => { value.slotId = set[1].slotId; },
    value => { value.routingRole = 'complex-reasoning'; },
    value => { value.authorization.taskId = 'task-2'; },
    value => { value.authorization.assignmentId = 'assignment-2'; },
    value => { value.slotIndex = 1; },
    value => { value.slotCount = 3; },
  ]) {
    const forged = structuredClone(set[0]); mutation(forged);
    assert.throws(() => check(forged, set));
  }
  assert.throws(() => check(set[1], set, set[0].slotId));
  assert.throws(() => check(set[0], set, 'caller-slot'));
});

test('risk, independent audit, requirements, approval digest and revision cannot be weakened', () => {
  const set = approved();
  for (const mutation of [
    value => { value.highRisk = false; },
    value => { value.independenceRequired = false; },
    value => { value.requirements.excludedActors = []; },
    value => { value.requirements.contextMode = 'full-history'; },
    value => { value.authorization.planRevision = 8; },
    value => { value.authorization.planDigest = digest('c'); },
    value => { value.authorization.authorizationDigest = digest('c'); },
    value => { value.executionAuthorized = true; },
  ]) {
    const forged = structuredClone(set[1]); mutation(forged);
    assert.throws(() => check(forged, set, set[1].slotId));
  }
});

test('current approved set must be complete, unique, and one plan revision', () => {
  const set = approved();
  for (const forgedSet of [
    [set[0]], [set[0], set[0]],
    [set[0], { ...set[1], slotIndex: 0 }],
    [set[0], { ...set[1], authorization: { ...set[1].authorization, planRevision: 8 } }],
    [set[0], { ...set[1], authorization: { ...set[1].authorization, authorizationDigest: digest('c') } }],
  ]) assert.throws(() => check(set[0], forgedSet));
  assert.throws(() => validator.roleSlotV1(set[0], [], set[0].slotId));
  const revised = approved();
  for (const item of revised) item.authorization.planRevision = 8;
  assert.throws(() => check(set[0], revised));
  const tightened = approved();
  tightened[0].requirements.filesystem = 'none';
  assert.throws(() => check(set[0], tightened));
});
