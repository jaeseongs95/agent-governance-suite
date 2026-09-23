import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { onTestFinished, test } from 'vitest';

import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { SemanticRoutingService } from '../../../mcp-server/src/routing-v3/semantic-service.ts';
import { SemanticEvaluationIntentStore } from '../../../mcp-server/src/semantic/evaluation-intent.ts';
import { SemanticProviderRunner } from '../../../mcp-server/src/semantic/provider-runner.ts';
import { ModelRoutingStore } from '../../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { digest } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { LATER, END } from '../model-routing-v2/fixtures.mjs';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';

function fixture(mode = 'off', { validated = false, reader = null, clock = LATER } = {}) {
  const base = contracts(), assignment = base.assignment, binding = assignment.routingRequest.binding;
  const database = new DatabaseSync(':memory:');
  onTestFinished(() => database.close());
  const routing = new ModelRoutingStore(database);
  const intents = new SemanticEvaluationIntentStore(database);
  const evidenceDigest = digest('t03-registered-evidence');
  const policy = { ...base.policy, mode,
    adoption: validated ? { status: 'validated', minimumConfidence: 0.5, evidenceDigest,
      provider: structuredClone(base.request.provider), questionDigest: digest(base.question),
      reducerVersion: 'semantic-reducer-v1' } : base.policy.adoption,
    egress: { enabled: validated, allowedProviders: validated ? [base.request.provider.id] : [] } };
  const taskEnvelope = { schemaVersion: '1.0.0', taskId: binding.taskId,
    objective: 'Choose a model.', scope: { included: [], excluded: [] },
    acceptanceCriteria: ['Choose one model.'], riskLevel: 'low', workUnits: [],
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
  const workflow = { getGuardedRunSnapshot: () => ({ receipt,
    guarded: { root, proposal, lease, outcome: null } }) };
  const principal = { actorId: 'actor-a', taskId: binding.taskId, runId: binding.runId,
    rootId: root.rootId, workspaceId: frame.workspace.workspaceId, rootRevision: root.revision,
    routingBinding: structuredClone(binding) };
  let calls = 0;
  const runner = { run: async ({ idempotencyKey, prepared }) => {
    calls++;
    intents.begin(idempotencyKey, prepared);
    const claim = intents.claim(prepared.evaluationId, prepared.requestDigest, 't03-runner');
    const result = { status: 'success', choice: { kind: 'Choice',
      selectedOptionIds: [prepared.options[0].optionId], confidence: 0.8 } };
    intents.recordResult(prepared.evaluationId, prepared.requestDigest, claim.claimId, result);
    return { status: 'recorded', result };
  } };
  const contextFor = () => ({ principal, environment: base.legacy.env, policy,
    question: base.question, provider: base.request.provider,
    evaluationId: 't03-evaluation', idempotencyKey: 't03-key', expiresAt: END });
  const service = new SemanticRoutingService(routing, workflow, runner, contextFor, reader, () => clock);
  const realRunner = port => {
    const endpoint = 'https://provider.example/v1/evaluate';
    const approval = { source: 'operator-record', revision: 4, decisionId: 'approved-4' };
    const config = { schemaVersion: '1.0.0', enabled: true, approval,
      routes: [{ providerId: base.request.provider.id, endpoint,
        dataCategories: ['routing', 'question', 'task', 'catalog'], accessPaths: ['subscription'] }],
      budget: { requests: { max: 3, basis: 'evaluation' },
        cost: { maxMicros: 250_000, currency: 'USD', basis: 'evaluation' } } };
    const authority = request => ({ policy, config, context: { assignment, store: workflow, principal,
      endpoint, accessPath: 'subscription', redirect: 'error',
      approval: { ...approval, approved: true, configDigest: digest(config), paidAccessPaths: [] },
      credential: { providerId: request.provider.id, endpoint, accessPath: 'subscription' },
      accounting: { evaluationId: request.evaluationId, requestsUsed: 0,
        costUsedMicros: 100_000, estimatedCostMicros: 50_000, currency: 'USD', basis: 'evaluation' } } });
    return new SemanticProviderRunner(intents, port, authority, () => {},
      { maxConcurrent: 1, maxOutputBytes: 4096, timeoutMs: 5 });
  };
  return { assignment, baseline: base.legacy.decision, database, routing, policy, service, calls: () => calls,
    evidenceDigest, evidenceReader: { read: () => ({ status: 'admitted', evidenceDigest,
      sufficient: true, registrationId: 't03-adoption-registration' }) },
    withReader: value => new SemanticRoutingService(routing, workflow, runner, contextFor, value, () => clock),
    withRunner: (value, evidence = reader) => new SemanticRoutingService(routing, workflow, value,
      contextFor, evidence, () => clock), realRunner };
}

function counts(database) {
  return {
    decisions: database.prepare('SELECT COUNT(*) AS n FROM ags_model_decisions_v2').get().n,
    references: database.prepare('SELECT COUNT(*) AS n FROM ags_model_decision_refs_v3').get().n,
  };
}

test('booted service returns v2 for off, shadow and unvalidated assist without invoking runner', async () => {
  for (const mode of ['off', 'shadow', 'assist']) {
    const f = fixture(mode);
    const result = await f.service.resolve(f.assignment);
    const decision = result.status === 'non-adoption' ? result.baselineDecision : result;
    assert.equal(decision.schemaVersion, '2.0.0');
    assert.equal(decision.decisionDigest, f.baseline.decisionDigest);
    assert.equal(f.calls(), 0);
    assert.deepEqual(counts(f.database), { decisions: 1, references: 0 });
  }
});

test('validated policy without a registered sufficient server reader remains v2', async () => {
  const f = fixture('assist', { validated: true });
  const result = await f.service.resolve(f.assignment);
  assert.equal(result.schemaVersion, '2.0.0');
  assert.equal(f.calls(), 0);
  const insufficient = f.withReader({ read: () => ({ status: 'admitted',
    evidenceDigest: f.evidenceDigest, sufficient: false, registrationId: 'registration' }) });
  assert.equal((await insufficient.resolve(f.assignment)).schemaVersion, '2.0.0');
  const unregistered = f.withReader({ read: () => ({ status: 'admitted',
    evidenceDigest: f.evidenceDigest, sufficient: true, registrationId: '' }) });
  assert.equal((await unregistered.resolve(f.assignment)).schemaVersion, '2.0.0');
  assert.equal(f.calls(), 0);
  assert.deepEqual(counts(f.database), { decisions: 1, references: 0 });
});

test('adoption registration drift before the writer leaves no v3 row', async () => {
  const f = fixture('assist', { validated: true });
  let reads = 0;
  const reader = { read: () => ({ status: 'admitted', evidenceDigest: f.evidenceDigest,
    sufficient: true, registrationId: ++reads === 1 ? 'registered-a' : 'registered-b' }) };
  await assert.rejects(f.withReader(reader).resolve(f.assignment), { code: 'GATE_FAILED' });
  assert.equal(reads, 2);
  assert.deepEqual(counts(f.database), { decisions: 1, references: 0 });
});

test('registered evidence, runner journal and advice produce only adopted assist v3', async () => {
  const f = fixture('assist', { validated: true });
  const result = await f.withReader(f.evidenceReader).resolve(f.assignment);
  assert.equal(result.schemaVersion, '3.0.0');
  assert.equal(result.semantic.mode, 'assist');
  assert.equal(f.calls(), 1);
  assert.deepEqual(counts(f.database), { decisions: 2, references: 1 });
  assert.deepEqual(f.routing.decision(result.decisionDigest).decision, result);
});

test('provider deadline uncertainty is separate from integrity and stale advice failures', async () => {
  const timeout = fixture('assist', { validated: true });
  const slow = timeout.realRunner({ evaluate: async () => new Promise(resolve => {
    globalThis.setTimeout(() => resolve({ status: 'abstained' }), 30);
  }) });
  await assert.rejects(timeout.withRunner(slow, timeout.evidenceReader).resolve(timeout.assignment),
    { code: 'MISSING_EVIDENCE' });
  assert.deepEqual(counts(timeout.database), { decisions: 1, references: 0 });

  const integrity = fixture('assist', { validated: true });
  const changed = { read: () => ({ status: 'admitted', evidenceDigest: digest('wrong'),
    sufficient: true, registrationId: 'registered' }) };
  await assert.rejects(integrity.withReader(changed).resolve(integrity.assignment),
    { code: 'INTEGRITY_FAILED' });
  assert.equal(integrity.calls(), 0);
  assert.deepEqual(counts(integrity.database), { decisions: 1, references: 0 });

  const stale = fixture('assist', { validated: true, clock: END });
  await assert.rejects(stale.withReader(stale.evidenceReader).resolve(stale.assignment),
    { code: 'INVALID_INPUT' });
  assert.deepEqual(counts(stale.database), { decisions: 1, references: 0 });
});
