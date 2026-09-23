import assert from 'node:assert/strict';
import { test } from 'vitest';
import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { prepareSemanticRequest } from '../../../mcp-server/src/semantic/prepare-request.ts';
import { resolveTaskReference } from '../../../mcp-server/src/semantic/task-ref-resolver.ts';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import {
  digest, verifySeal,
} from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { assertPreparedSemanticInputV1 } from '../../../skills/coordinate-subagents/scripts/semantic/prepared-input-check.mjs';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';

function fixture() {
  const base = contracts();
  const assignment = base.assignment;
  const binding = assignment.routingRequest.binding;
  const taskEnvelope = { schemaVersion: '1.0.0', taskId: binding.taskId,
    objective: 'Review the local task.', scope: { included: [], excluded: [] },
    acceptanceCriteria: ['Choose a model.'], riskLevel: 'low', workUnits: [],
    requiredCapabilities: [], constraints: [],
    authorization: { allowedActions: ['read'], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: 'simple', hasConflicts: false },
    orchestration: { requested: false, mcpAvailable: true } };
  const frame = { schemaVersion: '1.0.0', workspace: { workspaceId: 'workspace-a', locator: 'local-workspace' },
    controlArtifacts: [], targetArtifacts: [],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 60 } };
  const root = { rootId: 'root-a', revision: 3, state: 'open', taskEnvelope, frame,
    taskDigest: convergenceDigest(taskEnvelope), frameDigest: convergenceDigest(frame) };
  const proposal = { rootId: root.rootId, actorId: 'actor-a', taskEnvelope, frame };
  const lease = { leaseId: binding.attemptId, rootId: root.rootId, actorId: 'actor-a', state: 'consumed',
    taskDigest: root.taskDigest, frameDigest: root.frameDigest, planIntegrityToken: 'signed-plan' };
  const receipt = { runId: binding.runId, revision: binding.revision, state: 'running',
    plan: { taskId: binding.taskId, taskDigest: root.taskDigest, currentStageId: binding.stageId,
      stages: [{ stageId: binding.stageId }], integrityToken: 'signed-plan' } };
  let reads = 0;
  const store = { getGuardedRunSnapshot: () => {
    reads++;
    return { receipt, guarded: { root, proposal, lease, outcome: null } };
  } };
  const principal = { actorId: 'actor-a', taskId: binding.taskId, runId: binding.runId,
    rootId: root.rootId, workspaceId: frame.workspace.workspaceId, rootRevision: root.revision,
    routingBinding: structuredClone(binding) };
  const input = { assignment, store, principal, environment: base.legacy.env,
    semanticPolicy: { ...base.policy, mode: 'shadow' }, question: base.question,
    provider: { id: 'fixture-provider', model: 'fixture-choice', adapterVersion: 'fixture-v1' },
    evaluationId: 'evaluation-p05', expiresAt: '2026-09-21T12:04:00.000Z' };
  const rebindTask = () => {
    root.taskDigest = convergenceDigest(taskEnvelope);
    lease.taskDigest = root.taskDigest;
    receipt.plan.taskDigest = root.taskDigest;
  };
  return { input, root, receipt, taskEnvelope, rebindTask, getReads: () => reads };
}

test('P05 prepares a sealed internal request from authorized local sources and current routing data', () => {
  const { input, root, getReads } = fixture();
  const original = structuredClone({ assignment: input.assignment, environment: input.environment });
  const prepared = prepareSemanticRequest(input);
  assert.equal(getReads(), 1);
  assert.deepEqual(new ContractValidator().semanticDecisionRequestV1(prepared), prepared);
  verifySeal(prepared, 'requestDigest');
  assert.equal(prepared.effectiveRoutingRequestDigest, digest(input.assignment.routingRequest));
  assert.equal(prepared.catalogDigest, input.environment.catalog.catalogDigest);
  assert.equal(prepared.routingPolicyDigest, digest(input.environment.policy));
  assert.equal(prepared.semanticPolicyDigest, digest(input.semanticPolicy));
  for (const [field, value] of [
    ['stateDigest', prepared.state], ['questionDigest', prepared.question],
    ['eligibleSetDigest', prepared.eligibleSet], ['optionMappingDigest', prepared.options],
  ]) assert.equal(prepared[field], digest(value));
  assert.equal(prepared.state.sources[0].digest, root.taskDigest);
  assert.equal(prepared.state.sources[0].id, root.taskEnvelope.taskId);
  assert.equal(prepared.state.sources[1].digest, input.environment.catalog.catalogDigest);
  assert.equal(assertPreparedSemanticInputV1(prepared, input.assignment.routingRequest,
    input.environment, input.environment.now), true);
  assert.deepEqual({ assignment: input.assignment, environment: input.environment }, original);
});

test('P05 keeps unobserved revisions null and fixes explicit time, provider and reducer identity', () => {
  const { input } = fixture();
  const prepared = prepareSemanticRequest(input);
  assert.deepEqual(prepared.provider, { ...input.provider, providerVersion: null, modelVersion: null });
  assert.equal(prepared.reducerVersion, 'semantic-reducer-v1');
  assert.equal(prepared.mode, 'shadow');
  assert.equal(prepared.requestedAt, input.environment.now);
  assert.equal(prepared.expiresAt, input.expiresAt);
  const observed = prepareSemanticRequest({ ...input, provider: {
    ...input.provider, providerVersion: 'observed-provider', modelVersion: 'observed-model',
  } });
  assert.equal(observed.provider.providerVersion, 'observed-provider');
  assert.equal(observed.provider.modelVersion, 'observed-model');
  assert.notEqual(observed.requestDigest, prepared.requestDigest);
  assert.throws(() => prepareSemanticRequest({ ...input, expiresAt: input.environment.now }));
});

test('P05 refuses to create a request without fresh local access and an eligible pool', () => {
  const { input, receipt } = fixture();
  assert.throws(() => prepareSemanticRequest({ ...input, store: { getGuardedRunSnapshot: () => null } }),
    { code: 'GATE_FAILED' });
  assert.throws(() => prepareSemanticRequest({ ...input, principal: { ...input.principal, actorId: 'other' } }),
    { code: 'GATE_FAILED' });
  receipt.revision++;
  assert.throws(() => prepareSemanticRequest(input), { code: 'GATE_FAILED' });
  receipt.revision--;
  assert.throws(() => prepareSemanticRequest({ ...input, assignment: {
    ...input.assignment, state: { text: 'caller supplied state' },
  } }));
  assert.throws(() => prepareSemanticRequest({ ...input, environment: { ...input.environment, capabilities: [] } }));
  assert.throws(() => prepareSemanticRequest({ ...input, semanticPolicy: { ...input.semanticPolicy, mode: 'off' } }));
});

test('P05 rejects a high or critical task disguised as a low-risk routing request', () => {
  for (const riskLevel of ['high', 'critical']) {
    const { input, taskEnvelope, rebindTask } = fixture();
    taskEnvelope.riskLevel = riskLevel;
    rebindTask();
    assert.equal(resolveTaskReference(input.assignment, input.store, input.principal).task.riskLevel, riskLevel);
    assert.equal(input.assignment.routingRequest.highRisk, false);
    assert.throws(() => prepareSemanticRequest(input), { code: 'GATE_FAILED' });
  }
});

test('P05 rejects caller tools and filesystem that exceed task authorization', () => {
  for (const authorization of [
    { allowedActions: [], prohibitedActions: ['read'], approvalRequired: [] },
    { allowedActions: ['read'], prohibitedActions: ['read'], approvalRequired: [] },
    { allowedActions: ['read'], prohibitedActions: [], approvalRequired: ['read'] },
  ]) {
    const { input, taskEnvelope, rebindTask } = fixture();
    taskEnvelope.authorization = authorization;
    rebindTask();
    assert.deepEqual(resolveTaskReference(input.assignment, input.store, input.principal).task.authorization, authorization);
    assert.throws(() => prepareSemanticRequest(input), { code: 'GATE_FAILED' });
  }
  for (const allowedActions of [['read'], ['write']]) {
    const { input, taskEnvelope, rebindTask } = fixture();
    taskEnvelope.authorization.allowedActions = allowedActions;
    input.assignment.routingRequest.requirements.tools = [];
    input.assignment.routingRequest.requirements.filesystem = 'write';
    rebindTask();
    assert.throws(() => prepareSemanticRequest(input), { code: 'GATE_FAILED' });
  }
  const { input, taskEnvelope, rebindTask } = fixture();
  taskEnvelope.authorization.allowedActions = ['read', 'network'];
  taskEnvelope.authorization.prohibitedActions = ['network'];
  input.assignment.routingRequest.requirements.tools = ['network'];
  rebindTask();
  assert.deepEqual(resolveTaskReference(input.assignment, input.store, input.principal).task.authorization,
    taskEnvelope.authorization);
  assert.throws(() => prepareSemanticRequest(input), { code: 'GATE_FAILED' });
});
