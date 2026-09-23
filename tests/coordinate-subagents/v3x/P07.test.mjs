import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { SqliteWorkflowStore } from '../../../mcp-server/src/sqlite-workflow-store.ts';
import { SemanticEvaluationStore } from '../../../mcp-server/src/semantic/evaluation-store.ts';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

function databaseTest(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ags-p07-'));
  const file = path.join(directory, 'workflows.sqlite3');
  const workflow = new SqliteWorkflowStore(file);
  let database = new DatabaseSync(file);
  const reopen = () => { database.close(); database = new DatabaseSync(file); return database; };
  try { return run(new SemanticEvaluationStore(database), database, reopen, file); }
  finally { database.close(); workflow.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('P07: request and result survive reopening the existing workflow database', () => {
  databaseTest((journal, database, reopen) => {
    database.prepare("INSERT INTO workflow_metadata (key,value,updated_at) VALUES ('p07-legacy','preserved','2026-01-01T00:00:00Z')").run();
    const request = contracts('shadow').request;
    const key = 'intent-1';
    assert.equal(journal.putRequest(key, request).state, 'prepared');
    const raw = { text: 'opaque provider output', option: 'option-a' };
    assert.equal(journal.putResult(request.evaluationId, request.requestDigest, raw).state, 'recorded');
    const reopened = reopen();
    const restored = new SemanticEvaluationStore(reopened);
    assert.deepEqual(restored.get(request.evaluationId)?.request, request);
    assert.deepEqual(restored.getByIdempotencyKey(key)?.result, raw);
    assert.equal(restored.get(request.evaluationId)?.state, 'recorded');
    assert.equal(reopened.prepare("SELECT value FROM workflow_metadata WHERE key='p07-legacy'").get().value, 'preserved');
    assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 5);
  });
});

test('P07: idempotency key and evaluation ID bind immutable request bytes', () => {
  databaseTest(journal => {
    const request = contracts('shadow').request;
    assert.deepEqual(journal.putRequest('intent-1', request).request, request);
    assert.deepEqual(journal.putRequest('intent-1', request).request, request);
    const changed = resealRequest({ ...request, state: { ...request.state, text: 'changed' } });
    assert.throws(() => journal.putRequest('intent-1', changed), /conflicts/);
    assert.throws(() => journal.putRequest('intent-2', request), /conflicts/);
    assert.throws(() => journal.putRequest('intent-1', resealRequest({ ...request, evaluationId: 'other-id' })), /conflicts/);
    assert.equal(journal.get(request.evaluationId)?.request.requestDigest, request.requestDigest);
    assert.equal(journal.get('other-id'), null);
  });
});

test('P07: result binds request digest and cannot be replaced', () => {
  databaseTest(journal => {
    const request = contracts('shadow').request;
    journal.putRequest('intent-1', request);
    assert.throws(() => journal.putResult(request.evaluationId, 'wrong', { value: 1 }), /not bound/);
    assert.throws(() => journal.putResult('unknown', request.requestDigest, { value: 1 }), /not bound/);
    assert.equal(journal.get(request.evaluationId)?.state, 'prepared');
    assert.deepEqual(journal.putResult(request.evaluationId, request.requestDigest, { value: 1 }).result, { value: 1 });
    assert.deepEqual(journal.putResult(request.evaluationId, request.requestDigest, { value: 1 }).result, { value: 1 });
    assert.throws(() => journal.putResult(request.evaluationId, request.requestDigest, { value: 2 }), /conflicts/);
    assert.deepEqual(journal.get(request.evaluationId)?.result, { value: 1 });
    assert.throws(() => journal.putResult(request.evaluationId, request.requestDigest, { value: Number.NaN }), /plain JSON/);
  });
});

test('P07: reopened journal rejects a result whose stored request binding diverged', () => {
  databaseTest((journal, database, reopen) => {
    const request = contracts('shadow').request;
    journal.putRequest('intent-1', request);
    journal.putResult(request.evaluationId, request.requestDigest, { value: 1 });
    database.prepare('UPDATE ags_semantic_results_v1 SET request_digest=? WHERE evaluation_id=?')
      .run('different-request', request.evaluationId);
    const restored = new SemanticEvaluationStore(reopen());
    assert.throws(() => restored.get(request.evaluationId), /result digest is corrupt/);
    assert.throws(() => restored.putRequest('intent-1', request), /result digest is corrupt/);
    assert.throws(() => restored.putResult(request.evaluationId, request.requestDigest, { value: 1 }), /result digest is corrupt/);
  });
});

test('P07: failed second insert rolls back the evaluation row and preserves v2 data', () => {
  databaseTest((journal, database) => {
    const request = contracts('shadow').request;
    database.prepare("INSERT INTO workflow_metadata (key,value,updated_at) VALUES ('old','value','2026-01-01T00:00:00Z')").run();
    database.exec("CREATE TRIGGER p07_reject_request BEFORE INSERT ON ags_semantic_requests_v1 BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    assert.throws(() => journal.putRequest('intent-1', request), /blocked/);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ags_semantic_evaluations_v1').get().n, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ags_semantic_requests_v1').get().n, 0);
    assert.equal(database.prepare("SELECT value FROM workflow_metadata WHERE key='old'").get().value, 'value');
    database.exec('DROP TRIGGER p07_reject_request');
    assert.equal(journal.putRequest('intent-1', request).state, 'prepared');
  });
});

test('P07: a second connection cannot race a locked request into partial storage', () => {
  databaseTest((journal, database, _reopen, file) => {
    const request = contracts('shadow').request;
    const second = new DatabaseSync(file);
    try {
      const competing = new SemanticEvaluationStore(second);
      second.exec('PRAGMA busy_timeout = 1');
      database.exec('BEGIN IMMEDIATE');
      try { assert.throws(() => competing.putRequest('intent-1', request), /SQLITE_BUSY|database is locked/); }
      finally { database.exec('ROLLBACK'); }
      assert.equal(journal.get(request.evaluationId), null);
      assert.equal(competing.putRequest('intent-1', request).state, 'prepared');
      assert.equal(journal.putRequest('intent-1', request).state, 'prepared');
    } finally { second.close(); }
  });
});
