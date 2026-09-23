import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { resolveTaskReference } from '../../../mcp-server/src/semantic/task-ref-resolver.ts';
import { SqliteWorkflowStore } from '../../../mcp-server/src/sqlite-workflow-store.ts';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';

function fixture() {
  const { assignment } = contracts();
  const binding = assignment.routingRequest.binding;
  const taskEnvelope = { schemaVersion: '1.0.0', taskId: binding.taskId,
    objective: 'Review the approved local task.', scope: { included: ['artifact-a'], excluded: [] },
    acceptanceCriteria: ['Report a supported decision.'], riskLevel: 'low', workUnits: [],
    requiredCapabilities: [], constraints: [],
    authorization: { allowedActions: ['read'], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: 'simple', hasConflicts: false },
    orchestration: { requested: false, mcpAvailable: true } };
  const frame = { schemaVersion: '1.0.0', workspace: { workspaceId: 'workspace-a', locator: 'local-workspace' },
    controlArtifacts: [], targetArtifacts: [{ artifactId: 'artifact-a', role: 'target',
      locator: 'local-artifact', digest: convergenceDigest('artifact-content') }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 60 } };
  const root = { rootId: 'root-a', revision: 3, state: 'open', taskEnvelope, frame,
    taskDigest: convergenceDigest(taskEnvelope), frameDigest: convergenceDigest(frame) };
  const proposal = { rootId: root.rootId, actorId: 'actor-a', taskEnvelope, frame };
  const lease = { leaseId: binding.attemptId, rootId: root.rootId, actorId: 'actor-a', state: 'consumed',
    taskDigest: root.taskDigest, frameDigest: root.frameDigest, planIntegrityToken: 'signed-plan' };
  const receipt = { runId: binding.runId, revision: binding.revision, state: 'running',
    plan: { taskId: binding.taskId, taskDigest: root.taskDigest, currentStageId: binding.stageId,
      stages: [{ stageId: binding.stageId }], integrityToken: 'signed-plan' } };
  const store = { getGuardedRunSnapshot: () => ({ receipt, guarded: { root, proposal, lease, outcome: null } }) };
  const principal = { actorId: 'actor-a', taskId: binding.taskId, runId: binding.runId,
    rootId: root.rootId, workspaceId: frame.workspace.workspaceId, rootRevision: root.revision,
    routingBinding: structuredClone(binding) };
  return { assignment, principal, store, root, receipt, lease, proposal };
}

test('P04 resolves only current local task/frame/artifacts and keeps provenance', () => {
  const { assignment, principal, store, root } = fixture();
  assignment.taskRef.frameId = root.rootId;
  assignment.taskRef.artifactIds = ['artifact-a'];
  const result = resolveTaskReference(assignment, store, principal);
  assert.equal(result.task.taskId, assignment.taskRef.taskId);
  assert.deepEqual(result.sources.map(source => source.kind), ['task', 'frame', 'artifact']);
  assert.equal(result.sources[0].digest, root.taskDigest);
  assert.equal(result.sources[1].digest, root.frameDigest);
  assert.equal(result.sources[2].digest, root.frame.targetArtifacts[0].digest);
  assert.equal(result.provenance.runRevision, assignment.routingRequest.binding.revision);
  assert.ok(!JSON.stringify(result).includes('local-artifact'));
  result.task.objective = 'changed';
  assert.equal(root.taskEnvelope.objective, 'Review the approved local task.');
});

test('P04 denies foreign and format-only IDs, raw caller state, and revoked scope', () => {
  const { assignment, principal, store } = fixture();
  const deny = (request = assignment, trusted = principal) =>
    assert.throws(() => resolveTaskReference(request, store, trusted));
  deny({ ...assignment, taskRef: { taskId: 'other-task' } });
  deny({ ...assignment, taskRef: { taskId: assignment.taskRef.taskId, frameId: 'other-root' } });
  deny({ ...assignment, taskRef: { taskId: assignment.taskRef.taskId, artifactIds: ['artifact-valid-format'] } });
  deny({ ...assignment, taskRef: { ...assignment.taskRef, url: 'https://example.invalid/state' } });
  deny({ ...assignment, state: { text: 'caller supplied' } });
  deny(assignment, { ...principal, taskId: 'other-task' });
  deny(assignment, { ...principal, actorId: 'other-actor' });
  deny(assignment, { ...principal, workspaceId: 'other-workspace' });
});

test('P04 rejects stale workflow/root revisions and changed stored provenance', () => {
  const { assignment, principal, store, root, receipt, lease } = fixture();
  const deny = () => assert.throws(() => resolveTaskReference(assignment, store, principal));
  receipt.revision += 1; deny(); receipt.revision -= 1;
  root.revision += 1; deny(); root.revision -= 1;
  root.taskEnvelope.objective = 'Changed after the workflow was bound.'; deny();
  root.taskEnvelope.objective = 'Review the approved local task.';
  lease.state = 'expired'; deny();
  lease.state = 'consumed';
  store.getGuardedRunSnapshot = () => null; deny();
});

test('P04 reads one SQLite snapshot and rejects an old revision after another connection updates it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ags-p04-'));
  const path = join(directory, 'workflow.sqlite3');
  const store = new SqliteWorkflowStore(path);
  const writer = new DatabaseSync(path);
  try {
    const { assignment, principal, root, receipt, lease, proposal } = fixture();
    const now = '2026-09-23T00:00:00.000Z';
    writer.prepare('INSERT INTO workflow_runs VALUES (?,?,?,?,?,?)')
      .run(receipt.runId, receipt.revision, receipt.state, JSON.stringify(receipt), now, now);
    writer.prepare('INSERT INTO convergence_roots VALUES (?,?,?,?,?,?,?,?)')
      .run(root.rootId, root.revision, root.state, root.frame.workspace.workspaceId,
        root.frame.workspace.locator, JSON.stringify(root), now, now);
    writer.prepare('INSERT INTO convergence_leases VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(lease.leaseId, root.rootId, 2, 1, 1, lease.state,
        JSON.stringify(lease), JSON.stringify(proposal), now, '2026-09-24T00:00:00.000Z');
    writer.prepare('INSERT INTO convergence_attempts VALUES (?,?,?,?,?,?,?,?,?)')
      .run(root.rootId, 1, 1, lease.leaseId, receipt.runId, 'running', null, now, now);
    writer.prepare('INSERT INTO workflow_attempt_links VALUES (?,?,?,?,?)')
      .run(receipt.runId, root.rootId, lease.leaseId, 1, 1);

    assert.equal(resolveTaskReference(assignment, store, principal).provenance.runRevision, receipt.revision);
    // The resolver must not fall back to the two independently timed legacy reads.
    store.getRun = () => { throw new Error('split receipt read'); };
    store.getGuardedRunBinding = () => { throw new Error('split binding read'); };
    const revised = { ...receipt, revision: receipt.revision + 1,
      plan: { ...receipt.plan, currentStageId: 'other-stage' } };
    writer.prepare('UPDATE workflow_runs SET revision=?, receipt_json=? WHERE run_id=?')
      .run(revised.revision, JSON.stringify(revised), receipt.runId);
    assert.throws(() => resolveTaskReference(assignment, store, principal), { code: 'GATE_FAILED' });
  } finally {
    writer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
