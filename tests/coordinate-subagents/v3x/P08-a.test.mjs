import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { test } from 'vitest';
import { SqliteWorkflowStore } from '../../../mcp-server/src/sqlite-workflow-store.ts';
import { SemanticEvaluationStore } from '../../../mcp-server/src/semantic/evaluation-store.ts';
import { SemanticEvaluationIntentStore } from '../../../mcp-server/src/semantic/evaluation-intent.ts';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

function withWorkflow(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ags-p08a-'));
  const file = path.join(directory, 'workflows.sqlite3');
  const workflow = new SqliteWorkflowStore(file);
  const connections = [];
  const open = () => { const database = new DatabaseSync(file); connections.push(database); return database; };
  try { return run(open, file); }
  finally {
    for (const connection of connections) connection.close();
    workflow.close(); rmSync(directory, { recursive: true, force: true });
  }
}

test('P08-a: same intent key reuses one evaluation and rejects changed request or ID', () => {
  withWorkflow(open => {
    const database = open(), intents = new SemanticEvaluationIntentStore(database);
    const request = contracts('shadow').request;
    assert.equal(intents.begin('intent-1', request).state, 'pending');
    assert.equal(intents.begin('intent-1', request).evaluation.evaluationId, request.evaluationId);
    const changed = resealRequest({ ...request, state: { ...request.state, text: 'different request' } });
    assert.throws(() => intents.begin('intent-1', changed), /conflicts/);
    assert.throws(() => intents.begin('intent-1', resealRequest({ ...request, evaluationId: 'different-id' })), /conflicts/);
    assert.throws(() => intents.begin('different-key', request), /conflicts/);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ags_semantic_evaluations_v1').get().n, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ags_semantic_intents_v1').get().n, 1);
  });
});

test('P08-a: crash between request and intent insert resumes the same evaluation', () => {
  withWorkflow(open => {
    const first = open(), request = contracts('shadow').request;
    new SemanticEvaluationStore(first).putRequest('intent-1', request);
    const resumed = new SemanticEvaluationIntentStore(open());
    assert.equal(resumed.begin('intent-1', request).state, 'pending');
    assert.equal(resumed.resume(request.evaluationId, request.requestDigest).state, 'pending');
    assert.equal(resumed.begin('intent-1', request).evaluation.evaluationId, request.evaluationId);
    assert.equal(first.prepare('SELECT COUNT(*) AS n FROM ags_semantic_evaluations_v1').get().n, 1);
  });
});

test('P08-a: two connections obtain at most one runner claim', () => {
  withWorkflow(open => {
    const a = new SemanticEvaluationIntentStore(open());
    const b = new SemanticEvaluationIntentStore(open());
    const request = contracts('shadow').request;
    a.begin('intent-1', request);
    const claimed = a.claim(request.evaluationId, request.requestDigest, 'runner-a');
    assert.equal(claimed.state, 'running');
    assert.match(claimed.claimId, /^[0-9a-f-]{36}$/);
    assert.equal(claimed.runnerId, 'runner-a');
    assert.throws(() => b.claim(request.evaluationId, request.requestDigest, 'runner-b'), /already has a claim/);
    assert.throws(() => a.claim(request.evaluationId, request.requestDigest, 'runner-a'), /already has a claim/);
    assert.equal(b.begin('intent-1', request).claimId, claimed.claimId);
    assert.equal(b.get(request.evaluationId)?.claimId, claimed.claimId);
  });
});

test('P08-a: simultaneous claim attempts in separate workers have one winner', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ags-p08a-race-'));
  const file = path.join(directory, 'workflows.sqlite3');
  const workflow = new SqliteWorkflowStore(file);
  const request = contracts('shadow').request;
  const database = new DatabaseSync(file);
  new SemanticEvaluationIntentStore(database).begin('intent-1', request);
  database.close(); workflow.close();
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    (async () => {
      const { SemanticEvaluationIntentStore } = await require('tsx/esm/api').tsImport(workerData.moduleUrl, workerData.parentUrl);
      const db = new DatabaseSync(workerData.file);
      const store = new SemanticEvaluationIntentStore(db);
      parentPort.postMessage({ type: 'ready' });
      parentPort.once('message', () => {
        try {
          const claimed = store.claim(workerData.evaluationId, workerData.requestDigest, workerData.runnerId);
          parentPort.postMessage({ type: 'result', claimId: claimed.claimId });
        } catch (error) { parentPort.postMessage({ type: 'result', error: String(error.message) }); }
        finally { db.close(); }
      });
    })().catch(error => parentPort.postMessage({ type: 'result', error: String(error.message) }));
  `;
  const workers = ['runner-a', 'runner-b'].map(runnerId => new Worker(source, { eval: true,
    workerData: { file, evaluationId: request.evaluationId, requestDigest: request.requestDigest,
      runnerId, moduleUrl: new URL('../../../mcp-server/src/semantic/evaluation-intent.ts', import.meta.url).href,
      parentUrl: import.meta.url } }));
  const message = (worker, type) => new Promise((resolve, reject) => {
    const onMessage = value => { if (value.type === type) { worker.off('message', onMessage); resolve(value); } };
    worker.on('message', onMessage); worker.once('error', reject);
  });
  try {
    await Promise.all(workers.map(worker => message(worker, 'ready')));
    const results = workers.map(worker => message(worker, 'result'));
    workers.forEach(worker => worker.postMessage('go'));
    const outcomes = await Promise.all(results);
    assert.equal(outcomes.filter(outcome => outcome.claimId).length, 1);
    assert.equal(outcomes.filter(outcome => /already has a claim/.test(outcome.error)).length, 1);
    const reopened = new DatabaseSync(file);
    try { assert.equal(new SemanticEvaluationIntentStore(reopened).get(request.evaluationId)?.claimId,
      outcomes.find(outcome => outcome.claimId).claimId); }
    finally { reopened.close(); }
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('P08-a: restart conservatively marks a running claim uncertain and never reissues it', () => {
  withWorkflow(open => {
    const request = contracts('shadow').request;
    const first = new SemanticEvaluationIntentStore(open());
    first.begin('intent-1', request);
    const claimed = first.claim(request.evaluationId, request.requestDigest, 'runner-a');
    const resumed = new SemanticEvaluationIntentStore(open());
    assert.equal(resumed.resume(request.evaluationId, request.requestDigest).state, 'uncertain');
    assert.equal(resumed.resume(request.evaluationId, request.requestDigest).claimId, claimed.claimId);
    assert.throws(() => resumed.claim(request.evaluationId, request.requestDigest, 'runner-b'), /already has a claim/);
    assert.throws(() => resumed.resume(request.evaluationId, 'wrong'), /not bound/);
    assert.equal(resumed.begin('intent-1', request).state, 'uncertain');
  });
});

test('P08-a: only the bound claim can record a result, including a late uncertain result', () => {
  withWorkflow(open => {
    const request = contracts('shadow').request;
    const intents = new SemanticEvaluationIntentStore(open());
    intents.begin('intent-1', request);
    assert.throws(() => intents.recordResult(request.evaluationId, request.requestDigest, 'guess', { value: 1 }), /not bound/);
    assert.throws(() => intents.claim(request.evaluationId, 'wrong', 'runner-a'), /not bound/);
    const claim = intents.claim(request.evaluationId, request.requestDigest, 'runner-a');
    assert.throws(() => intents.recordResult(request.evaluationId, 'wrong', claim.claimId, { value: 1 }), /not bound/);
    assert.throws(() => intents.recordResult(request.evaluationId, request.requestDigest, 'wrong', { value: 1 }), /not bound/);
    intents.resume(request.evaluationId, request.requestDigest);
    assert.equal(intents.recordResult(request.evaluationId, request.requestDigest, claim.claimId, { value: 1 }).state, 'recorded');
    assert.equal(intents.recordResult(request.evaluationId, request.requestDigest, claim.claimId, { value: 1 }).state, 'recorded');
    assert.throws(() => intents.recordResult(request.evaluationId, request.requestDigest, claim.claimId, { value: 2 }), /Conflicting result/);
    assert.deepEqual(new SemanticEvaluationIntentStore(open()).get(request.evaluationId)?.evaluation.result, { value: 1 });
    assert.throws(() => intents.claim(request.evaluationId, request.requestDigest, 'runner-b'), /already has a claim/);
  });
});

test('P08-a: result and recorded transition roll back together; v2 data remains', () => {
  withWorkflow(open => {
    const database = open(), intents = new SemanticEvaluationIntentStore(database);
    database.prepare("INSERT INTO workflow_metadata (key,value,updated_at) VALUES ('legacy','intact','2026-01-01T00:00:00Z')").run();
    const request = contracts('shadow').request;
    intents.begin('intent-1', request);
    const claim = intents.claim(request.evaluationId, request.requestDigest, 'runner-a');
    database.exec("CREATE TRIGGER reject_recorded BEFORE UPDATE ON ags_semantic_intents_v1 WHEN NEW.state='recorded' BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    assert.throws(() => intents.recordResult(request.evaluationId, request.requestDigest, claim.claimId, { value: 1 }), /blocked/);
    assert.equal(intents.get(request.evaluationId)?.state, 'running');
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ags_semantic_results_v1').get().n, 0);
    assert.equal(database.prepare("SELECT value FROM workflow_metadata WHERE key='legacy'").get().value, 'intact');
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 5);
    database.exec('DROP TRIGGER reject_recorded');
    assert.equal(intents.recordResult(request.evaluationId, request.requestDigest, claim.claimId, { value: 1 }).state, 'recorded');
  });
});

test('P08-a: an unclaimed raw journal result cannot become runner evidence', () => {
  withWorkflow(open => {
    const database = open(), intents = new SemanticEvaluationIntentStore(database);
    const request = contracts('shadow').request;
    intents.begin('intent-1', request);
    new SemanticEvaluationStore(database).putResult(request.evaluationId, request.requestDigest, { value: 1 });
    assert.throws(() => intents.get(request.evaluationId), /diverged/);
    assert.throws(() => intents.claim(request.evaluationId, request.requestDigest, 'runner-a'), /diverged/);
  });
});
