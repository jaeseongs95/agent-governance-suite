/** Pure projection of a server-owned approved plan. This function cannot authenticate its caller. */
import { ROLES, assert, digest, digestValue, identifier, keys, text, validateRequest } from '../model-routing-core.mjs';

const RISKS = ['low', 'medium', 'high', 'critical'];
const APPROVED_PLAN = ['schemaVersion', 'taskId', 'runId', 'revision', 'state', 'stages',
  'planDigest', 'authorizationDigest'];
const STAGE = ['stageId', 'state', 'assignments'];
const ASSIGNMENT = ['assignmentId', 'state', 'purpose', 'routingRole', 'riskLevel',
  'highRisk', 'independenceRequired', 'requirements'];
const PARTICIPANT = ['actorId', 'host', 'sessionId'];

function validPlan(plan) {
  keys(plan, APPROVED_PLAN);
  assert(plan.schemaVersion === '1.0.0' && plan.state === 'approved', 'INVALID_INPUT', 'Approved plan required');
  identifier(plan.taskId, 'taskId'); identifier(plan.runId, 'runId');
  assert(Number.isSafeInteger(plan.revision) && plan.revision >= 0, 'INVALID_INPUT', 'Invalid plan revision');
  digestValue(plan.planDigest, 'planDigest'); digestValue(plan.authorizationDigest, 'authorizationDigest');
  assert(Array.isArray(plan.stages) && plan.stages.length > 0 && plan.stages.length <= 64,
    'INVALID_INPUT', 'Bounded approved stages required');
  const stageIds = new Set(), assignmentIds = new Set();
  let slotCount = 0;
  for (const stage of plan.stages) {
    keys(stage, STAGE);
    identifier(stage.stageId, 'stageId');
    assert(!stageIds.has(stage.stageId) && stage.state === 'approved',
      'INVALID_INPUT', 'Duplicate or unapproved stage');
    stageIds.add(stage.stageId);
    assert(Array.isArray(stage.assignments) && stage.assignments.length > 0,
      'INVALID_INPUT', 'Approved stage needs assignments');
    slotCount += stage.assignments.length;
    assert(slotCount <= 64, 'INVALID_INPUT', 'At most 64 approved assignments');
    for (const assignment of stage.assignments) {
      keys(assignment, ASSIGNMENT);
      identifier(assignment.assignmentId, 'assignmentId');
      text(assignment.purpose, 'purpose', 1000);
      assert(!assignmentIds.has(assignment.assignmentId) && assignment.state === 'approved'
        && ROLES.includes(assignment.routingRole) && RISKS.includes(assignment.riskLevel)
        && typeof assignment.highRisk === 'boolean'
        && typeof assignment.independenceRequired === 'boolean',
      'INVALID_INPUT', 'Duplicate, unapproved or invalid assignment');
      assignmentIds.add(assignment.assignmentId);
      const highRisk = ['high', 'critical'].includes(assignment.riskLevel)
        || assignment.routingRole === 'independent-audit';
      assert(assignment.highRisk === highRisk
        && (assignment.routingRole !== 'independent-audit' || assignment.independenceRequired),
      'INVALID_INPUT', 'Risk or audit independence weakened');
      validateRequest({ schemaVersion: '2.0.0', binding: {
        assignmentId: assignment.assignmentId, taskId: plan.taskId, runId: plan.runId,
        stageId: stage.stageId, attemptId: 'role-slot-projection', revision: plan.revision,
        inputDigest: plan.planDigest, candidateDigest: plan.planDigest,
      }, role: assignment.routingRole, highRisk: assignment.highRisk,
      requirements: assignment.requirements });
      if (assignment.routingRole === 'independent-audit') {
        assert(assignment.requirements.contextMode === 'limited', 'INVALID_INPUT', 'Audit needs limited context');
      }
    }
  }
  const content = { ...plan };
  delete content.planDigest;
  delete content.authorizationDigest;
  assert(digest(content) === plan.planDigest, 'DIGEST_MISMATCH', 'Approved plan content changed');
  assert(plan.authorizationDigest === digest({ kind: 'approved-plan-authorization',
    taskId: plan.taskId, runId: plan.runId, revision: plan.revision, planDigest: plan.planDigest }),
  'DIGEST_MISMATCH', 'Approval binding does not match the plan revision');
  return slotCount;
}

function validParticipation(value) {
  keys(value, ['entries', 'digest']);
  digestValue(value.digest, 'participation digest');
  assert(Array.isArray(value.entries) && value.entries.length <= 256,
    'INVALID_INPUT', 'Bounded participation history required');
  const seen = new Set();
  for (const entry of value.entries) {
    keys(entry, PARTICIPANT);
    for (const field of PARTICIPANT) identifier(entry[field], field);
    assert(!entry.host.includes('/') && !entry.sessionId.includes('/'),
      'INVALID_INPUT', 'Participation session identity must be unambiguous');
    const key = digest(entry);
    assert(!seen.has(key), 'INVALID_INPUT', 'Duplicate participation entry');
    seen.add(key);
  }
  assert(digest(value.entries) === value.digest, 'DIGEST_MISMATCH', 'Participation history changed');
}

/** R16 must read both arguments from the current approval/participation stores. */
export function projectApprovedRoleSlotsV1(input) {
  keys(input, ['approvedPlan', 'participation']);
  const { approvedPlan, participation } = input;
  const slotCount = validPlan(approvedPlan);
  validParticipation(participation);
  const actorIds = [...new Set(participation.entries.map((entry) => entry.actorId))].sort();
  const sessionKeys = [...new Set(participation.entries.map((entry) => `${entry.host}/${entry.sessionId}`))].sort();
  const slots = [];
  for (const stage of approvedPlan.stages) for (const assignment of stage.assignments) {
    const slotIndex = slots.length;
    const requirements = structuredClone(assignment.requirements);
    if (assignment.routingRole === 'independent-audit') {
      requirements.excludedActors = [...new Set([...requirements.excludedActors, ...actorIds])].sort();
      requirements.excludedSessions = [...new Set([...requirements.excludedSessions, ...sessionKeys])].sort();
    }
    slots.push({ schemaVersion: '1.0.0', kind: 'role-slot-projection',
      slotId: `slot-sha256:${digest({ planDigest: approvedPlan.planDigest,
        planRevision: approvedPlan.revision, stageId: stage.stageId,
        assignmentId: assignment.assignmentId, routingRole: assignment.routingRole,
        slotIndex, participationDigest: participation.digest }).slice('sha256:'.length)}`,
      authorization: { taskId: approvedPlan.taskId, runId: approvedPlan.runId,
        stageId: stage.stageId, assignmentId: assignment.assignmentId,
        planRevision: approvedPlan.revision, planDigest: approvedPlan.planDigest,
        authorizationDigest: approvedPlan.authorizationDigest },
      slotIndex, slotCount, purpose: assignment.purpose, routingRole: assignment.routingRole,
      riskLevel: assignment.riskLevel, highRisk: assignment.highRisk,
      independenceRequired: assignment.independenceRequired, requirements,
      executionAuthorized: false });
  }
  return slots;
}
