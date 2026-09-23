import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { onTestFinished, test } from 'vitest';

import { ModelRoutingWorkflowBridge, hasModelRoutingArtifacts } from '../../../mcp-server/src/model-routing-workflow.ts';
import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { MODEL_DECISION_V3_SCHEMA, validateStoredSemanticWorkflowBinding } from '../../../mcp-server/src/routing-v3/workflow-binding.ts';
import { canonical, digest, seal } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { ModelRoutingStore } from '../../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';
import { NOW } from '../model-routing-v2/fixtures.mjs';

function fixture(role = null) {
  const db = new DatabaseSync(':memory:');
  onTestFinished(() => db.close());
  const routing = new ModelRoutingStore(db);
  const { legacy, decision: sample } = contracts();
  const request = role ? { ...legacy.req, role, highRisk: true } : legacy.req;
  const decision = role ? seal({ ...sample, requestDigest: digest(request) }, 'decisionDigest') : sample;
  const binding = decision.binding;
  db.prepare('INSERT INTO ags_model_decisions_v2 VALUES (?,?,?,?,?,?)').run(
    decision.decisionDigest, digest(binding), canonical(request), canonical(legacy.env), canonical(decision), NOW);
  db.prepare('INSERT INTO ags_model_decision_refs_v3 VALUES (?,?,?,?,?)').run(
    decision.decisionDigest, decision.semantic.baselineDecisionDigest,
    't06-evaluation', 't06-registration', decision.semantic.adviceDigest);
  const frame = { targetArtifacts: [{ digest: binding.candidateDigest }] };
  const task = { taskId: binding.taskId, riskLevel: 'low', authorization: { allowedActions: ['read', 'write'],
    prohibitedActions: [], approvalRequired: [] } };
  const root = { rootId: 't06-root', state: 'open', taskEnvelope: structuredClone(task),
    taskDigest: convergenceDigest(task), frame: structuredClone(frame),
    frameDigest: convergenceDigest(frame), targetDigest: convergenceDigest(frame.targetArtifacts) };
  const guarded = { root, proposal: { rootId: root.rootId, frame, taskEnvelope: task },
    lease: { rootId: root.rootId, state: 'consumed', leaseId: binding.attemptId,
      taskDigest: root.taskDigest, frameDigest: root.frameDigest, targetDigest: root.targetDigest,
      planIntegrityToken: 't06-plan-token' },
    outcome: null };
  const receipt = { runId: binding.runId, state: 'running', revision: binding.revision,
    plan: { taskId: binding.taskId, taskDigest: root.taskDigest,
      integrityToken: guarded.lease.planIntegrityToken, currentStageId: binding.stageId,
      stages: [{ stageId: binding.stageId, state: 'ready' }] } };
  const workflow = { getGuardedRunSnapshot: () => ({ receipt, guarded }) };
  const bridge = new ModelRoutingWorkflowBridge(workflow, routing);
  const locator = `ags-model-decision:${decision.decisionDigest.slice(7)}`;
  const artifact = { artifactId: 'semantic-diagnostic', schemaId: MODEL_DECISION_V3_SCHEMA,
    locator, digest: decision.decisionDigest, targetDigest: binding.candidateDigest, verified: false };
  const result = { runId: binding.runId, stageId: binding.stageId,
    expectedRevision: binding.revision, state: 'passed',
    output: { artifacts: [artifact] },
    evidence: [{ artifactId: artifact.artifactId, locator, verified: false }] };
  return { db, routing, request, decision, binding, guarded, receipt, bridge, artifact, result };
}

function refreshTask(f) {
  const root = f.guarded.root;
  root.taskEnvelope = structuredClone(f.guarded.proposal.taskEnvelope);
  root.taskDigest = convergenceDigest(root.taskEnvelope);
  f.guarded.lease.taskDigest = root.taskDigest;
  f.receipt.plan.taskDigest = root.taskDigest;
}

test('stored v3 diagnostic reference is recognized and binds to the current workflow without granting authority', () => {
  const f = fixture();
  assert.equal(hasModelRoutingArtifacts(f.result), true);
  assert.doesNotThrow(() => f.bridge.validateStageArtifacts(f.result));
  assert.deepEqual(validateStoredSemanticWorkflowBinding(
    { getGuardedRunSnapshot: () => ({ receipt: f.receipt, guarded: f.guarded }) },
    f.routing, f.decision.decisionDigest), { decision: f.decision, request: f.request });
  assert.equal(f.decision.executionAuthorized, false);
  assert.equal(f.decision.trustedGateSatisfied, false);
});

test('v3 reference rejects another run, stage, revision or forged locator and digest', () => {
  const f = fixture();
  for (const key of ['runId', 'stageId', 'expectedRevision']) {
    const result = structuredClone(f.result);
    result[key] = key === 'expectedRevision' ? result[key] + 1 : 'other';
    assert.throws(() => f.bridge.validateStageArtifacts(result), /different run, stage, revision/u);
  }
  for (const key of ['schemaId', 'locator', 'digest', 'targetDigest']) {
    const result = structuredClone(f.result);
    result.output.artifacts[0][key] = key === 'schemaId' ? 'other'
      : key === 'locator' ? 'ags-model-decision:bad'
        : digest('forged');
    assert.throws(() => f.bridge.validateStageArtifacts(result));
  }
  f.db.prepare('DELETE FROM ags_model_decision_refs_v3').run();
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /registered decision reference/u);
});

test('v3 binding requires a current consumed lease and the frozen candidate frame', () => {
  const f = fixture();
  f.receipt.runId = 'other-run';
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /current workflow run/u);
  f.receipt.runId = f.binding.runId;
  f.guarded.lease.state = 'issued';
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /consumed workflow lease/u);
  f.guarded.lease.state = 'consumed';
  f.guarded.lease.leaseId = 'other';
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /consumed workflow lease/u);
  f.guarded.lease.leaseId = f.binding.attemptId;
  f.receipt.plan.integrityToken = 'another-plan';
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /frozen attempt frame/u);
  f.receipt.plan.integrityToken = f.guarded.lease.planIntegrityToken;
  f.guarded.lease.frameDigest = digest('other-frame');
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /frozen attempt frame/u);
  f.guarded.lease.frameDigest = convergenceDigest(f.guarded.proposal.frame);
  f.guarded.lease.targetDigest = digest('other-target');
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /frozen attempt frame/u);
  f.guarded.proposal.frame.targetArtifacts = [{ digest: digest('other-candidate') }];
  f.guarded.root.frame = structuredClone(f.guarded.proposal.frame);
  f.guarded.root.frameDigest = convergenceDigest(f.guarded.proposal.frame);
  f.guarded.root.targetDigest = convergenceDigest(f.guarded.root.frame.targetArtifacts);
  f.guarded.lease.frameDigest = f.guarded.root.frameDigest;
  f.guarded.lease.targetDigest = f.guarded.root.targetDigest;
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /frozen attempt frame/u);
});

test('v3 diagnostic cannot downgrade task risk, exceed authorization or stand in for approval', () => {
  const f = fixture();
  f.guarded.proposal.taskEnvelope.riskLevel = 'high';
  refreshTask(f);
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /downgrade/u);
  f.guarded.proposal.taskEnvelope.riskLevel = 'low';
  f.guarded.proposal.taskEnvelope.authorization.prohibitedActions.push('read');
  refreshTask(f);
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /authorization/u);
  f.guarded.proposal.taskEnvelope.authorization.prohibitedActions = [];
  f.guarded.proposal.taskEnvelope.authorization.approvalRequired.push('native-approval');
  refreshTask(f);
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /approval adapter/u);
});

test('v3 diagnostic cannot mark its artifact or evidence verified', () => {
  const f = fixture();
  f.result.output.artifacts[0].verified = true;
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /diagnostic/u);
  f.result.output.artifacts[0].verified = false;
  f.result.evidence[0].verified = true;
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /diagnostic evidence/u);
  f.result.evidence[0].locator = 'fixture:unrelated';
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /diagnostic evidence/u);
});

test('v3 audit reference rechecks participant and excluded session at adoption', () => {
  const f = fixture('independent-audit');
  f.bridge.history = () => ({ actors: [f.decision.target.actorId], sessions: [] });
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /participated/u);
  f.bridge.history = () => ({ actors: [], sessions: [`${f.decision.target.host}/${f.decision.target.sessionId}`] });
  assert.throws(() => f.bridge.validateStageArtifacts(f.result), /participated/u);
});
