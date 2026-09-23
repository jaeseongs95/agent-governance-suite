import assert from 'node:assert/strict';
import { test } from 'vitest';
import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { assertSemanticEgressAllowed } from '../../../mcp-server/src/semantic/egress-guard.ts';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import { digest } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

function fixture() {
  const base = contracts('shadow');
  const assignment = base.assignment;
  const binding = assignment.routingRequest.binding;
  const taskEnvelope = { schemaVersion: '1.0.0', taskId: binding.taskId,
    objective: 'Evaluate this task.', scope: { included: [], excluded: [] },
    acceptanceCriteria: ['Choose a model.'], riskLevel: 'low', workUnits: [],
    requiredCapabilities: [], constraints: [],
    authorization: { allowedActions: ['read', 'network'], prohibitedActions: [], approvalRequired: [] },
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
  const store = { getGuardedRunSnapshot: () => ({ receipt,
    guarded: { root, proposal, lease, outcome: null } }) };
  const principal = { actorId: 'actor-a', taskId: binding.taskId, runId: binding.runId,
    rootId: root.rootId, workspaceId: frame.workspace.workspaceId, rootRevision: root.revision,
    routingBinding: structuredClone(binding) };
  const policy = { ...base.policy, mode: 'shadow',
    egress: { enabled: true, allowedProviders: [base.request.provider.id] } };
  const state = { ...base.request.state,
    sources: [{ kind: 'task', id: binding.taskId, digest: root.taskDigest }] };
  const prepared = resealRequest({ ...base.request, state,
    effectiveRoutingRequestDigest: digest(assignment.routingRequest),
    semanticPolicyDigest: digest(policy) });
  const endpoint = 'https://provider.example/v1/evaluate';
  const approval = { source: 'operator-record', revision: 4, decisionId: 'approved-4' };
  const config = { schemaVersion: '1.0.0', enabled: true, approval,
    routes: [{ providerId: prepared.provider.id, endpoint,
      dataCategories: ['routing', 'question', 'task', 'catalog'],
      accessPaths: ['subscription', 'api'] }],
    budget: { requests: { max: 3, basis: 'evaluation' },
      cost: { maxMicros: 250_000, currency: 'USD', basis: 'evaluation' } } };
  const context = { assignment, store, principal, endpoint, accessPath: 'subscription', redirect: 'error',
    approval: { ...approval, approved: true, configDigest: digest(config), paidAccessPaths: [] },
    credential: { providerId: prepared.provider.id, endpoint, accessPath: 'subscription' },
    accounting: { evaluationId: prepared.evaluationId, requestsUsed: 0,
      costUsedMicros: 100_000, estimatedCostMicros: 50_000, currency: 'USD', basis: 'evaluation' } };
  const rebindTask = () => {
    root.taskDigest = convergenceDigest(taskEnvelope);
    lease.taskDigest = root.taskDigest;
    receipt.plan.taskDigest = root.taskDigest;
  };
  return { prepared, policy, config, context, taskEnvelope, receipt, rebindTask };
}

function check({ prepared, policy, config, context }) {
  return assertSemanticEgressAllowed(prepared, policy, config, context);
}

test('P06 requires exact server config, approval, endpoint and every outgoing data category in shadow mode', () => {
  const f = fixture();
  assert.deepEqual(check(f), { endpoint: f.context.endpoint, redirect: 'error' });
  assert.throws(() => check({ ...f, config: null }), { code: 'GATE_FAILED' });
  assert.throws(() => check({ ...f, config: { schemaVersion: '1.0.0', enabled: false } }), { code: 'GATE_FAILED' });
  assert.throws(() => check({ ...f, policy: { ...f.policy, egress: { enabled: false, allowedProviders: [] } } }),
    { code: 'GATE_FAILED' });
  assert.throws(() => check({ ...f, context: { ...f.context, endpoint: 'https://provider.example/other' } }),
    { code: 'GATE_FAILED' });
  const categoryConfig = { ...f.config, routes: [{ ...f.config.routes[0],
    dataCategories: ['routing', 'question', 'catalog'] }] };
  assert.throws(() => check({ ...f, config: categoryConfig, context: { ...f.context,
    approval: { ...f.context.approval, configDigest: digest(categoryConfig) } } }),
  { code: 'GATE_FAILED', message: /disallowed data category/ });
  assert.throws(() => check({ ...f, config: { ...f.config, approval: { ...f.config.approval, revision: 5 } } }),
    { code: 'GATE_FAILED' });
  const changedEndpoint = 'https://provider.example/v2/evaluate';
  assert.throws(() => check({ ...f, config: { ...f.config, routes: [{ ...f.config.routes[0],
    endpoint: changedEndpoint }] }, context: { ...f.context, endpoint: changedEndpoint,
    credential: { ...f.context.credential, endpoint: changedEndpoint } } }),
  { code: 'GATE_FAILED' });
  assert.throws(() => check({ ...f, context: { ...f.context, approval: null } }), { code: 'GATE_FAILED' });
});

test('P06 denies redirects, unapproved paid paths and missing or mismatched credentials', () => {
  const f = fixture();
  for (const redirect of ['follow', 'manual']) {
    assert.throws(() => check({ ...f, context: { ...f.context, redirect } }), { code: 'GATE_FAILED' });
  }
  for (const endpoint of ['http://provider.example/v1/evaluate',
    'https://user@provider.example/v1/evaluate', 'https://provider.example/v1/evaluate?token=x']) {
    assert.throws(() => check({ ...f, context: { ...f.context, endpoint } }), { code: 'GATE_FAILED' });
  }
  const paid = { ...f.context, accessPath: 'api',
    credential: { ...f.context.credential, accessPath: 'api' } };
  assert.throws(() => check({ ...f, context: paid }), { code: 'GATE_FAILED' });
  assert.deepEqual(check({ ...f, context: { ...paid,
    approval: { ...paid.approval, paidAccessPaths: ['api'] } } }),
  { endpoint: f.context.endpoint, redirect: 'error' });
  for (const credential of [null, { ...f.context.credential, endpoint: 'https://provider.example/other' }]) {
    assert.throws(() => check({ ...f, context: { ...f.context, credential } }), { code: 'GATE_FAILED' });
  }
  assert.throws(() => check({ ...f, context: { ...f.context, accessPath: 'unknown' } }),
    { code: 'GATE_FAILED' });
});

test('P06 keeps request count and monetary basis separate and fails on unknown estimates', () => {
  const f = fixture();
  const accounting = f.context.accounting;
  for (const changed of [
    { ...accounting, requestsUsed: 3 },
    { ...accounting, estimatedCostMicros: 200_000 },
    { ...accounting, estimatedCostMicros: null },
    { ...accounting, currency: 'EUR' },
    { ...accounting, basis: 'quota' },
    { ...accounting, evaluationId: 'other-evaluation' },
  ]) assert.throws(() => check({ ...f, context: { ...f.context, accounting: changed } }),
    { code: 'GATE_FAILED' });
  assert.throws(() => check({ ...f, config: { ...f.config,
    budget: { ...f.config.budget, cost: { ...f.config.budget.cost, basis: 'quota' } } } }),
  { code: 'GATE_FAILED' });
  const lowerCostConfig = { ...f.config, budget: { ...f.config.budget,
    cost: { ...f.config.budget.cost, maxMicros: 125_000 } } };
  assert.throws(() => check({ ...f, config: lowerCostConfig, context: { ...f.context,
    approval: { ...f.context.approval, configDigest: digest(lowerCostConfig) } } }),
  { code: 'GATE_FAILED', message: /monetary budget/ });
});

test('P06 config is not model-callable input, and extra config fields fail schema validation', () => {
  const f = fixture(), validator = new ContractValidator();
  assert.throws(() => validator.semanticModelAssignmentRequestV1({
    ...contracts().assignment, egressConfig: f.config,
  }));
  assert.throws(() => check({ ...f, config: { ...f.config, callerOverride: true } }),
    { code: 'GATE_FAILED' });
  assert.throws(() => check({ ...f, prepared: { ...f.prepared, egressConfig: f.config } }));
});

test('P06 rechecks current task network authorization and prepared source binding before a call', () => {
  for (const authorization of [
    { allowedActions: ['read'], prohibitedActions: [], approvalRequired: [] },
    { allowedActions: ['read', 'network'], prohibitedActions: ['network'], approvalRequired: [] },
    { allowedActions: ['read', 'network'], prohibitedActions: [], approvalRequired: ['network'] },
  ]) {
    const f = fixture();
    f.taskEnvelope.authorization = authorization;
    f.rebindTask();
    f.prepared.state.sources[0].digest = convergenceDigest(f.taskEnvelope);
    f.prepared = resealRequest(f.prepared);
    assert.throws(() => check(f), { code: 'GATE_FAILED', message: /Provider network access/ });
  }
  const stale = fixture();
  stale.receipt.revision++;
  assert.throws(() => check(stale), { code: 'GATE_FAILED' });
  const foreign = fixture();
  foreign.prepared.state.sources[0].digest = digest('foreign-task');
  foreign.prepared = resealRequest(foreign.prepared);
  assert.throws(() => check(foreign), { code: 'GATE_FAILED' });
});
