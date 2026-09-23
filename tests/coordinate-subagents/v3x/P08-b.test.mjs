import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { SqliteWorkflowStore } from '../../../mcp-server/src/sqlite-workflow-store.ts';
import { SemanticEvaluationIntentStore } from '../../../mcp-server/src/semantic/evaluation-intent.ts';
import { SemanticProviderRunner } from '../../../mcp-server/src/semantic/provider-runner.ts';
import { digest } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

const success = { status: 'success', choice: { kind: 'Choice', selectedOptionIds: ['option-a'], confidence: null } };
const options = { maxConcurrent: 1, maxOutputBytes: 4096, timeoutMs: 5000 };

function fixture() {
  const base = contracts('shadow'), assignment = base.assignment;
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
    effectiveRoutingRequestDigest: digest(assignment.routingRequest), semanticPolicyDigest: digest(policy) });
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
  const authority = request => ({ policy, config,
    context: { ...context, accounting: { ...context.accounting, evaluationId: request.evaluationId } } });
  return { prepared, policy, config, context, authority };
}

async function withRunner(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ags-p08b-'));
  const file = path.join(directory, 'workflows.sqlite3');
  const workflow = new SqliteWorkflowStore(file), database = new DatabaseSync(file);
  const intents = new SemanticEvaluationIntentStore(database);
  try { await run(intents, file); }
  finally { database.close(); workflow.close(); rmSync(directory, { recursive: true, force: true }); }
}

function runner(intents, fixtureValue, port, opts = options, reserve = () => {}) {
  return new SemanticProviderRunner(intents, port, fixtureValue.authority, reserve, opts);
}

test('P08-b off, cancelled, and denied egress call no provider and make no intent', async () => {
  await withRunner(async intents => {
    const f = fixture(); let calls = 0, reserves = 0;
    const port = { evaluate: async () => { calls++; return success; } };
    const off = { ...f, authority: request => ({ ...f.authority(request),
      policy: { ...f.policy, mode: 'off' } }) };
    assert.deepEqual(await runner(intents, off, port, options, () => reserves++).run({
      idempotencyKey: 'key', prepared: f.prepared }), { status: 'off' });
    const aborted = new globalThis.AbortController(); aborted.abort();
    assert.deepEqual(await runner(intents, f, port).run({ idempotencyKey: 'key', prepared: f.prepared,
      signal: aborted.signal }), { status: 'cancelled' });
    const denied = { ...f, authority: request => ({ ...f.authority(request),
      context: { ...f.authority(request).context, approval: null } }) };
    await assert.rejects(runner(intents, denied, port).run({ idempotencyKey: 'key', prepared: f.prepared }),
      { code: 'GATE_FAILED' });
    assert.equal(calls, 0); assert.equal(reserves, 0);
    assert.equal(intents.get(f.prepared.evaluationId), null);
  });
});

test('P08-b only a new claim invokes the provider and stores a bounded raw result', async () => {
  await withRunner(async (intents, file) => {
    const f = fixture(); let calls = 0, reserveCount = 0, sawRunning = false;
    const port = { evaluate: async (_request, control) => {
      calls++; sawRunning = intents.get(f.prepared.evaluationId)?.state === 'running';
      assert.equal(control.signal.aborted, false);
      assert.equal(control.endpoint, f.context.endpoint);
      assert.equal(control.redirect, 'error');
      control.onOutput('chunk');
      return success;
    } };
    const execute = runner(intents, f, port, options, () => { reserveCount++; });
    const first = await execute.run({ idempotencyKey: 'key', prepared: f.prepared });
    assert.deepEqual(first, { status: 'recorded', result: success });
    assert.equal('claimId' in first, false);
    assert.equal(sawRunning, true);
    assert.deepEqual(await execute.run({ idempotencyKey: 'key', prepared: f.prepared,
      claimId: intents.get(f.prepared.evaluationId).claimId, runnerId: 'forged' }),
    { status: 'already-claimed' });
    assert.equal(calls, 1); assert.equal(reserveCount, 1);
    const reopened = new DatabaseSync(file);
    try { assert.equal(new SemanticEvaluationIntentStore(reopened).get(f.prepared.evaluationId)?.state, 'recorded'); }
    finally { reopened.close(); }
  });
});

test('P08-b readback claim ID cannot be supplied to invoke again', async () => {
  await withRunner(async intents => {
    const f = fixture(); let calls = 0;
    intents.begin('key', f.prepared);
    const prior = intents.claim(f.prepared.evaluationId, f.prepared.requestDigest, 'other-runner');
    const port = { evaluate: async () => { calls++; return success; } };
    const execute = runner(intents, f, port);
    assert.deepEqual(await execute.run({ idempotencyKey: 'key', prepared: f.prepared,
      claimId: prior.claimId, runnerId: prior.runnerId }), { status: 'already-claimed' });
    intents.resume(f.prepared.evaluationId, f.prepared.requestDigest);
    assert.deepEqual(await execute.run({ idempotencyKey: 'key', prepared: f.prepared,
      claimId: prior.claimId }), { status: 'already-claimed' });
    assert.equal(calls, 0);
  });
});

test('P08-b deadline returns uncertain, ignores late response, and retains slot until provider settles', async () => {
  await withRunner(async intents => {
    const f = fixture(); let settle, calls = 0;
    const port = { evaluate: async () => { calls++; return new Promise(resolve => { settle = resolve; }); } };
    const execute = runner(intents, f, port, { ...options, timeoutMs: 5 });
    assert.deepEqual(await execute.run({ idempotencyKey: 'key', prepared: f.prepared }), { status: 'uncertain' });
    assert.equal(intents.get(f.prepared.evaluationId)?.state, 'uncertain');
    const second = resealRequest({ ...f.prepared, evaluationId: 'second-evaluation' });
    assert.deepEqual(await execute.run({ idempotencyKey: 'second-key', prepared: second }), { status: 'busy' });
    assert.equal(intents.get(second.evaluationId), null);
    assert.deepEqual(await execute.run({ idempotencyKey: 'key', prepared: f.prepared }), { status: 'busy' });
    settle(success); await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    assert.equal(intents.get(f.prepared.evaluationId)?.state, 'uncertain');
    assert.equal(intents.get(f.prepared.evaluationId)?.evaluation.result, null);
    assert.deepEqual(await execute.run({ idempotencyKey: 'key', prepared: f.prepared }), { status: 'already-claimed' });
    assert.equal(calls, 1);
  });
});

test('P08-b monotonic deadline rejects a success after synchronous provider blocking', async () => {
  await withRunner(async intents => {
    const f = fixture(); let calls = 0, observedSignal;
    const port = { evaluate: (_request, control) => {
      calls++; observedSignal = control.signal;
      const until = performance.now() + 30;
      while (performance.now() < until) { /* Simulate a blocking adapter before timer delivery. */ }
      return Promise.resolve(success);
    } };
    const execute = runner(intents, f, port, { ...options, timeoutMs: 5 });
    assert.deepEqual(await execute.run({ idempotencyKey: 'key', prepared: f.prepared }),
      { status: 'uncertain' });
    assert.equal(calls, 1);
    assert.equal(observedSignal.aborted, true);
    assert.equal(intents.get(f.prepared.evaluationId)?.state, 'uncertain');
    assert.equal(intents.get(f.prepared.evaluationId)?.evaluation.result, null);
  });
});

test('P08-b cancellation and cumulative stream excess become uncertain without late result admission', async () => {
  await withRunner(async intents => {
    const f = fixture();
    const controller = new globalThis.AbortController(); let settle, providerSignal;
    const slow = { evaluate: async (_request, control) => {
      providerSignal = control.signal;
      return new Promise(resolve => { settle = resolve; });
    } };
    const execute = runner(intents, f, slow);
    const pending = execute.run({ idempotencyKey: 'cancel-key', prepared: f.prepared, signal: controller.signal });
    await new Promise(resolve => globalThis.setTimeout(resolve, 0)); controller.abort();
    assert.deepEqual(await pending, { status: 'uncertain' });
    assert.equal(providerSignal.aborted, true);
    settle(success); await new Promise(resolve => globalThis.setTimeout(resolve, 0));
    assert.equal(intents.get(f.prepared.evaluationId)?.state, 'uncertain');

    const second = resealRequest({ ...f.prepared, evaluationId: 'stream-evaluation' });
    const chunks = { evaluate: async (_request, control) => {
      control.onOutput('123456'); control.onOutput('abcdef'); return success;
    } };
    const capped = runner(intents, f, chunks, { ...options, maxOutputBytes: 10 });
    assert.deepEqual(await capped.run({ idempotencyKey: 'stream-key', prepared: second }), { status: 'uncertain' });
    assert.equal(intents.get(second.evaluationId)?.state, 'uncertain');
    assert.equal(intents.get(second.evaluationId)?.evaluation.result, null);
    const third = resealRequest({ ...f.prepared, evaluationId: 'final-size-evaluation' });
    const quiet = { evaluate: async () => success };
    assert.deepEqual(await runner(intents, f, quiet, { ...options, maxOutputBytes: 10 })
      .run({ idempotencyKey: 'final-size-key', prepared: third }), { status: 'uncertain' });
    assert.equal(intents.get(third.evaluationId)?.evaluation.result, null);
  });
});

test('P08-b provider failure and ambiguous status stay uncertain and do not auto retry', async () => {
  await withRunner(async intents => {
    const f = fixture(); let calls = 0;
    const port = { evaluate: async () => { calls++; throw new Error('provider disconnected'); } };
    const execute = runner(intents, f, port);
    assert.deepEqual(await execute.run({ idempotencyKey: 'key', prepared: f.prepared }), { status: 'uncertain' });
    assert.deepEqual(await execute.run({ idempotencyKey: 'key', prepared: f.prepared }), { status: 'already-claimed' });
    assert.equal(calls, 1);
  });
});

test('P08-b changed authority after reservation or cancellation before invocation never calls provider', async () => {
  await withRunner(async intents => {
    const f = fixture(); let calls = 0, changed = false;
    const port = { evaluate: async () => { calls++; return success; } };
    const shifting = { ...f, authority: request => ({ ...f.authority(request),
      config: changed ? { ...f.config, approval: { ...f.config.approval, revision: 5 } } : f.config }) };
    const execute = runner(intents, shifting, port, options, () => { changed = true; });
    await assert.rejects(execute.run({ idempotencyKey: 'shift-key', prepared: f.prepared }),
      { code: 'GATE_FAILED', message: /authority changed/ });
    assert.equal(calls, 0);
    assert.equal(intents.get(f.prepared.evaluationId)?.state, 'uncertain');

    const second = resealRequest({ ...f.prepared, evaluationId: 'cancel-before-call' });
    const controller = new globalThis.AbortController();
    const cancelled = runner(intents, f, port, options, () => controller.abort());
    assert.deepEqual(await cancelled.run({ idempotencyKey: 'cancel-before-call', prepared: second,
      signal: controller.signal }), { status: 'uncertain' });
    assert.equal(calls, 0);
    assert.equal(intents.get(second.evaluationId)?.state, 'uncertain');
  });
});
