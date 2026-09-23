import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import { collectEligibleCandidatesV2, digest } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { projectApprovedRoleSlotsV1 } from '../../../skills/coordinate-subagents/scripts/orchestration/approved-slot-projection.mjs';
import { capability, environment, request } from '../model-routing-v2/fixtures.mjs';

const validator = new ContractValidator();
const requirements = () => ({ inputModalities: ['text'], tools: ['read'], filesystem: 'read',
  allowedSurfaces: ['peer-session'], allowedRuntimeModes: ['standard'], allowNestedDelegation: false,
  requireObservable: ['model', 'reasoning', 'runtimeMode'], excludedActors: [], excludedSessions: [],
  contextMode: 'limited' });
const assignment = (assignmentId, routingRole, purpose) => ({ assignmentId, state: 'approved', purpose,
  routingRole, riskLevel: 'medium', highRisk: routingRole === 'independent-audit',
  independenceRequired: routingRole === 'independent-audit',
  requirements: { ...requirements(), excludedActors: routingRole === 'independent-audit' ? ['other-conflict'] : [] } });

function approvedPlan() {
  const content = { schemaVersion: '1.0.0', taskId: 'task-1', runId: 'run-1', revision: 7,
    state: 'approved', stages: [
      { stageId: 'stage-1', state: 'approved', assignments: [
        assignment('assignment-1', 'general-implementation', 'implement') ] },
      { stageId: 'stage-2', state: 'approved', assignments: [
        assignment('assignment-2', 'independent-audit', 'independent review') ] },
    ] };
  const planDigest = digest(content);
  return { ...content, planDigest, authorizationDigest: digest({ kind: 'approved-plan-authorization',
    taskId: content.taskId, runId: content.runId, revision: content.revision, planDigest }) };
}
function participation() {
  const entries = [{ actorId: 'actor-1', host: 'openai-codex', sessionId: 'session-1' }];
  return { entries, digest: digest(entries) };
}
const project = (plan = approvedPlan(), history = participation()) =>
  projectApprovedRoleSlotsV1({ approvedPlan: plan, participation: history });

test('R15 projects a deterministic complete RoleSlot set from one approved plan', () => {
  const plan = approvedPlan(), history = participation();
  const original = structuredClone({ plan, history });
  const slots = project(plan, history);
  assert.deepEqual(project(structuredClone(plan), structuredClone(history)), slots);
  assert.equal(slots.length, 2);
  assert.deepEqual(slots.map(slot => slot.slotIndex), [0, 1]);
  assert.deepEqual(slots.map(slot => slot.slotCount), [2, 2]);
  assert.notEqual(slots[0].slotId, slots[1].slotId);
  assert(slots.every(slot => slot.authorization.planDigest === plan.planDigest
    && slot.authorization.planRevision === plan.revision && slot.executionAuthorized === false));
  for (const slot of slots) assert.deepEqual(validator.roleSlotV1(slot, slots, slot.slotId), slot);
  assert.deepEqual({ plan, history }, original);
  assert.throws(() => projectApprovedRoleSlotsV1({ approvedPlan: plan, participation: history,
    approvedSlots: slots }), { code: 'INVALID_INPUT' });
});

test('R15 rejects extra role/slot, changed revision, weakened requirements and unapproved material', () => {
  for (const mutate of [
    plan => { plan.stages.push({ stageId: 'stage-3', state: 'approved', assignments: [
      assignment('assignment-3', 'discovery', 'extra role') ] }); },
    plan => { plan.stages[0].assignments.push(assignment('assignment-3', 'discovery', 'extra slot')); },
    plan => { plan.revision += 1; },
    plan => { plan.stages[1].assignments[0].requirements.filesystem = 'write'; },
    plan => { plan.stages[1].assignments[0].requirements.excludedActors = []; },
    plan => { plan.stages[1].state = 'cancelled'; },
    plan => { plan.stages[0].assignments[0].state = 'cancelled'; },
  ]) {
    const changed = approvedPlan(); mutate(changed);
    assert.throws(() => project(changed));
  }
  for (const mutate of [
    plan => { plan.stages[0].assignments.push(assignment('assignment-3', 'discovery', 'extra slot')); },
    plan => { plan.stages[1].assignments[0].requirements.filesystem = 'write'; },
    plan => { plan.stages[1].assignments[0].requirements.excludedActors = []; },
  ]) {
    const changed = approvedPlan(); mutate(changed);
    const content = { ...changed };
    delete content.planDigest;
    delete content.authorizationDigest;
    changed.planDigest = digest(content);
    assert.throws(() => project(changed), { code: 'DIGEST_MISMATCH' });
  }
  const revised = approvedPlan(); revised.revision += 1;
  revised.planDigest = digest(Object.fromEntries(Object.entries(revised)
    .filter(([key]) => !['planDigest', 'authorizationDigest'].includes(key))));
  assert.throws(() => project(revised));
  revised.authorizationDigest = digest({ kind: 'approved-plan-authorization',
    taskId: revised.taskId, runId: revised.runId, revision: revised.revision, planDigest: revised.planDigest });
  assert.notEqual(project(revised)[0].slotId, project()[0].slotId);
  const slots = project();
  for (const mutate of [
    slot => { slot.slotCount = 3; },
    slot => { slot.routingRole = 'discovery'; },
    slot => { slot.requirements.filesystem = 'write'; },
    slot => { slot.authorization.planRevision += 1; },
  ]) {
    const candidate = structuredClone(slots[0]); mutate(candidate);
    assert.throws(() => validator.roleSlotV1(candidate, slots, slots[0].slotId));
  }
});

test('R15 audit slot excludes participating actor and session; history tampering fails closed', () => {
  const slots = project();
  const audit = slots[1];
  assert.equal(audit.routingRole, 'independent-audit');
  assert.equal(audit.highRisk, true);
  assert.equal(audit.independenceRequired, true);
  assert.deepEqual(audit.requirements.excludedActors, ['actor-1', 'other-conflict']);
  assert.deepEqual(audit.requirements.excludedSessions, ['openai-codex/session-1']);
  const selected = collectEligibleCandidatesV2(request({ role: 'independent-audit', highRisk: true,
    requirements: audit.requirements }), environment({ capabilities: [capability()] }));
  assert(selected.rejectedCandidates.some(item => item.reasonCodes.includes('INDEPENDENCE_CONFLICT')));
  const forged = structuredClone(audit); forged.requirements.excludedActors = [];
  assert.throws(() => validator.roleSlotV1(forged, slots, audit.slotId));
  const changedHistory = participation(); changedHistory.entries[0].actorId = 'other-actor';
  assert.throws(() => project(approvedPlan(), changedHistory));
  changedHistory.digest = digest(changedHistory.entries);
  const revised = project(approvedPlan(), changedHistory);
  assert.notEqual(revised[1].slotId, audit.slotId);
  assert.deepEqual(revised[1].requirements.excludedActors, ['other-actor', 'other-conflict']);
});

test('R15 rejects duplicate stage/assignment and malformed risk or audit constraints even if resealed', () => {
  for (const mutate of [
    plan => { plan.stages[1].stageId = 'stage-1'; },
    plan => { plan.stages[1].assignments[0].assignmentId = 'assignment-1'; },
    plan => { plan.stages[1].assignments[0].highRisk = false; },
    plan => { plan.stages[1].assignments[0].independenceRequired = false; },
    plan => { plan.stages[1].assignments[0].requirements.contextMode = 'full-history'; },
  ]) {
    const changed = approvedPlan(); mutate(changed);
    const content = { ...changed };
    delete content.planDigest;
    delete content.authorizationDigest;
    changed.planDigest = digest(content);
    assert.throws(() => project(changed));
  }
});
