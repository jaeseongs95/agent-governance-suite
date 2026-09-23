import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { RawContentStore } from '../../../mcp-server/src/artifacts/content-store.ts';
import { ReplayMaterialLoader } from '../../../mcp-server/src/artifacts/replay-loader.ts';
import { ArtifactRetentionStore } from '../../../mcp-server/src/artifacts/retention.ts';
import { SqliteWorkflowStore } from '../../../mcp-server/src/sqlite-workflow-store.ts';
import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { SemanticAdviceAdmissionStore } from '../../../mcp-server/src/semantic/advice-admission.ts';
import { SemanticEvaluationIntentStore } from '../../../mcp-server/src/semantic/evaluation-intent.ts';
import { prepareSemanticRequest } from '../../../mcp-server/src/semantic/prepare-request.ts';
import { SemanticProviderRunner } from '../../../mcp-server/src/semantic/provider-runner.ts';
import { FakeSemanticDecisionProvider } from '../../../mcp-server/src/semantic/providers/fake.ts';
import { SemanticReplaySnapshotPublisher } from '../../../mcp-server/src/semantic/replay-snapshot.ts';
import { validateSemanticAdviceForRequest } from '../../../mcp-server/src/semantic/advice-validator.ts';
import { canonical, digest, seal } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { replaySemanticDecisionV1 } from '../../../skills/coordinate-subagents/scripts/semantic/replay.mjs';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';
import { LATER, END } from '../model-routing-v2/fixtures.mjs';

const roles = ['request', 'policy', 'catalog', 'capability', 'advice'];
const runnerOptions = { maxConcurrent: 1, maxOutputBytes: 4096, timeoutMs: 5000 };

function authorized() {
  const base = contracts('assist'), assignment = base.assignment;
  const binding = assignment.routingRequest.binding;
  const taskEnvelope = { schemaVersion: '1.0.0', taskId: binding.taskId,
    objective: 'Review the local task.', scope: { included: [], excluded: [] },
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
  const policy = { ...base.policy, mode: 'assist',
    adoption: { status: 'validated', minimumConfidence: 0.5,
      evidenceDigest: digest('fixture-only-policy-evidence'), provider: base.request.provider,
      questionDigest: digest(base.question), reducerVersion: 'semantic-reducer-v1' },
    egress: { enabled: true, allowedProviders: [base.request.provider.id] } };
  const environment = base.legacy.env;
  const prepared = prepareSemanticRequest({ assignment, store, principal, environment,
    semanticPolicy: policy, question: base.question, provider: base.request.provider,
    evaluationId: 'evaluation-p12', expiresAt: END });
  const endpoint = 'https://provider.example/v1/evaluate';
  const approval = { source: 'operator-record', revision: 4, decisionId: 'approved-4' };
  const config = { schemaVersion: '1.0.0', enabled: true, approval,
    routes: [{ providerId: prepared.provider.id, endpoint,
      dataCategories: ['routing', 'question', 'task', 'catalog'], accessPaths: ['subscription'] }],
    budget: { requests: { max: 3, basis: 'evaluation' },
      cost: { maxMicros: 250_000, currency: 'USD', basis: 'evaluation' } } };
  const context = { assignment, store, principal, endpoint, accessPath: 'subscription', redirect: 'error',
    approval: { ...approval, approved: true, configDigest: digest(config), paidAccessPaths: [] },
    credential: { providerId: prepared.provider.id, endpoint, accessPath: 'subscription' },
    accounting: { evaluationId: prepared.evaluationId, requestsUsed: 0,
      costUsedMicros: 100_000, estimatedCostMicros: 50_000, currency: 'USD', basis: 'evaluation' } };
  return { assignment, store, principal, environment, prepared, policy, config, context,
    authority: () => ({ policy, config, context }) };
}

async function isolated(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ags-p12-'));
  const file = path.join(directory, 'workflow.sqlite3');
  const workflow = new SqliteWorkflowStore(file), database = new DatabaseSync(file);
  const intents = new SemanticEvaluationIntentStore(database);
  try { await run({ directory, database, intents }); }
  finally { database.close(); workflow.close(); await rm(directory, { recursive: true, force: true }); }
}

test('P12 fake success passes access, prepare, runner, registration and identical offline S07 replay', async () => {
  await isolated(async ({ directory, database, intents }) => {
    const f = authorized(); let calls = 0, reserves = 0;
    const fake = new FakeSemanticDecisionProvider('p12-seed', { outcome: 'success', confidence: 0.75 });
    const port = { evaluate: async (...args) => { calls++; return fake.evaluate(...args); } };
    const runner = new SemanticProviderRunner(intents, port, f.authority, () => { reserves++; }, runnerOptions);
    const outcome = await runner.run({ idempotencyKey: 'p12-success', prepared: f.prepared });
    assert.equal(outcome.status, 'recorded');
    assert.equal(calls, 1); assert.equal(reserves, 1);
    const admission = new SemanticAdviceAdmissionStore(database, () => LATER);
    const registered = admission.register(f.prepared.evaluationId);
    assert.equal(registered.advice.choice.kind, 'Choice');
    assert.equal('testOnly' in registered.advice, false);
    const adoption = { status: 'eligible', evidenceDigest: digest('test-only-admission') };
    const archived = { routingRequest: f.assignment.routingRequest, prepared: f.prepared,
      adoption, decisionTime: LATER, reducerVersion: f.prepared.reducerVersion };
    const material = { request: archived, policy: f.environment.policy, catalog: f.environment.catalog,
      capability: f.environment.capabilities, advice: registered.advice };
    const artifactRoot = path.join(directory, 'artifacts'), content = new RawContentStore(artifactRoot);
    const refs = {};
    for (const role of roles) {
      const bytes = Buffer.from(canonical(material[role]), 'utf8');
      refs[role] = { schemaVersion: '1.0.0', namespace: 'task', id: `p12-${role}`,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        hashDomain: 'raw-bytes', size: bytes.length, mediaType: 'application/json' };
      await content.put(refs[role], bytes);
    }
    const principal = { workspaceId: 'workspace-a', taskId: f.prepared.binding.taskId };
    const grants = roles.map(role => ({ ref: refs[role], ...principal }));
    const retention = new ArtifactRetentionStore(path.join(directory, 'retention.sqlite3'));
    try {
      const consumption = { read: () => ({ evaluationId: f.prepared.evaluationId,
        registrationId: registered.registrationId, adviceDigest: registered.advice.adviceDigest,
        adoption, decisionTime: LATER }) };
      const publisher = new SemanticReplaySnapshotPublisher(artifactRoot, principal, grants,
        retention, admission, intents, consumption);
      const bundle = await publisher.publish({ evaluationId: f.prepared.evaluationId, materials: refs });
      const loader = new ReplayMaterialLoader(artifactRoot, principal,
        [...grants, { ref: bundle.manifestRef, ...principal }]);
      const loaded = await loader.load(bundle.manifestRef);
      assert.equal(loaded.status, 'ready');
      assert.equal(loaded.input.advice.adviceDigest, registered.advice.adviceDigest);
      const direct = { routingRequest: f.assignment.routingRequest,
        environment: { ...f.environment, now: LATER }, prepared: f.prepared,
        advice: registered.advice, adoption, decisionTime: LATER,
        reducerVersion: f.prepared.reducerVersion };
      assert.equal(replaySemanticDecisionV1(loaded.input).decisionDigest,
        replaySemanticDecisionV1(direct).decisionDigest);
      assert.equal(replaySemanticDecisionV1(loaded.input).executionAuthorized, false);
      assert.equal(calls, 1);
    } finally { retention.close(); }
  });
});

test('P12 off mode makes zero fake calls and timeout never reaches advice registration', async () => {
  await isolated(async ({ database, intents }) => {
    const f = authorized(); let calls = 0;
    const fake = new FakeSemanticDecisionProvider('p12-seed', { outcome: 'success' });
    const port = { evaluate: async (...args) => { calls++; return fake.evaluate(...args); } };
    const off = new SemanticProviderRunner(intents, port,
      () => ({ ...f.authority(), policy: { ...f.policy, mode: 'off' } }), () => {}, runnerOptions);
    assert.deepEqual(await off.run({ idempotencyKey: 'p12-off', prepared: f.prepared }), { status: 'off' });
    assert.equal(calls, 0); assert.equal(intents.get(f.prepared.evaluationId), null);
    const timeoutFake = new FakeSemanticDecisionProvider('p12-seed', { outcome: 'timeout' });
    const timeout = new SemanticProviderRunner(intents, timeoutFake, f.authority, () => {}, runnerOptions);
    assert.deepEqual(await timeout.run({ idempotencyKey: 'p12-timeout', prepared: f.prepared }),
      { status: 'uncertain' });
    assert.equal(intents.get(f.prepared.evaluationId).state, 'uncertain');
    assert.equal(intents.get(f.prepared.evaluationId).evaluation.result, null);
    assert.throws(() => new SemanticAdviceAdmissionStore(database, () => LATER)
      .register(f.prepared.evaluationId), { code: 'GATE_FAILED' });
  });
});

test('P12 forged provider binding is not recorded and cannot register advice', async () => {
  await isolated(async ({ database, intents }) => {
    const f = authorized();
    const fake = new FakeSemanticDecisionProvider('p12-seed', { outcome: 'success', confidence: 0.75 });
    const forged = { evaluate: async request => ({ ...await fake.evaluate(request), evaluationId: 'forged' }) };
    const runner = new SemanticProviderRunner(intents, forged, f.authority, () => {}, runnerOptions);
    assert.deepEqual(await runner.run({ idempotencyKey: 'p12-forged', prepared: f.prepared }),
      { status: 'uncertain' });
    assert.equal(intents.get(f.prepared.evaluationId).evaluation.result, null);
    assert.throws(() => new SemanticAdviceAdmissionStore(database, () => LATER)
      .register(f.prepared.evaluationId), { code: 'GATE_FAILED' });
    const validAdvice = contracts('assist').advice;
    const reSealed = seal({ ...validAdvice, evaluationId: 'forged' }, 'adviceDigest');
    assert.throws(() => validateSemanticAdviceForRequest({ prepared: f.prepared,
      advice: reSealed, now: LATER }));
  });
});

test('P12 preparation rejects a caller outside the guarded task principal', () => {
  const f = authorized();
  assert.throws(() => prepareSemanticRequest({ assignment: f.assignment, store: f.store,
    principal: { ...f.principal, actorId: 'other-actor' }, environment: f.environment,
    semanticPolicy: f.policy, question: contracts().question,
    provider: f.prepared.provider, evaluationId: 'unauthorized-evaluation', expiresAt: END }),
  { code: 'GATE_FAILED' });
});
