import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { SqliteWorkflowStore } from '../../../mcp-server/src/sqlite-workflow-store.ts';
import { SemanticAdviceAdmissionStore } from '../../../mcp-server/src/semantic/advice-admission.ts';
import { SemanticEvaluationIntentStore } from '../../../mcp-server/src/semantic/evaluation-intent.ts';
import { SemanticEvaluationStore } from '../../../mcp-server/src/semantic/evaluation-store.ts';
import { canonical, digest, seal } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';
import { LATER, END } from '../model-routing-v2/fixtures.mjs';

const result = (option = 'option-a') => ({ status: 'success',
  choice: { kind: 'Choice', selectedOptionIds: [option], confidence: 0.8 } });

function withStore(run) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ags-p10-'));
  const file = path.join(directory, 'workflow.sqlite3');
  const workflow = new SqliteWorkflowStore(file), database = new DatabaseSync(file);
  let now = LATER;
  const admission = new SemanticAdviceAdmissionStore(database, () => now);
  const intents = new SemanticEvaluationIntentStore(database);
  try { run({ database, file, admission, intents, setNow: value => { now = value; } }); }
  finally { database.close(); workflow.close(); rmSync(directory, { recursive: true, force: true }); }
}

function record(intents, request, raw = result(), key = request.evaluationId) {
  intents.begin(key, request);
  const claim = intents.claim(request.evaluationId, request.requestDigest, 'runner-a');
  intents.recordResult(request.evaluationId, request.requestDigest, claim.claimId, raw);
}

test('P10 requires a recorded runner claim, not a caller flag or bare result row', () => {
  withStore(({ database, admission, intents }) => {
    const { request } = contracts('shadow');
    assert.throws(() => admission.register(request.evaluationId), /runner-recorded/);
    intents.begin('prepared', request);
    assert.throws(() => admission.register(request.evaluationId), /runner-recorded/);
    assert.throws(() => admission.register({ evaluationId: request.evaluationId, registered: true }), /Evaluation ID/);
    new SemanticEvaluationStore(database).putResult(request.evaluationId, request.requestDigest,
      { ...result(), registered: true });
    assert.throws(() => admission.register(request.evaluationId));
    assert.equal(admission.get(request.evaluationId), null);
  });
});

test('P10 records one server-owned advice and replays identical response without a second row', () => {
  withStore(({ database, file, admission, intents }) => {
    const { request } = contracts('shadow');
    record(intents, request);
    const first = admission.register(request.evaluationId);
    assert.match(first.registrationId, /^[0-9a-f-]{36}$/);
    assert.equal(first.evaluationId, request.evaluationId);
    assert.equal(first.requestDigest, request.requestDigest);
    assert.equal(first.resultDigest, digest(result()));
    assert.equal(first.advice.evaluationId, request.evaluationId);
    assert.equal(Object.hasOwn(first.advice, 'registered'), false);
    assert.deepEqual(admission.register(request.evaluationId), first);
    assert.deepEqual(admission.get(request.evaluationId), first);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ags_semantic_advice_v1').get().n, 1);
    const readback = new DatabaseSync(file);
    try {
      const reopened = new SemanticAdviceAdmissionStore(readback, () => LATER);
      assert.deepEqual(reopened.get(request.evaluationId), first);
    } finally { readback.close(); }
  });
});

test('P10 rejects late new and duplicate registration while retaining historical readback', () => {
  withStore(({ admission, intents, setNow }) => {
    const first = contracts('shadow').request;
    record(intents, first);
    const stored = admission.register(first.evaluationId);
    const second = resealRequest({ ...first, evaluationId: 'fixture-evaluation-2' });
    record(intents, second);
    setNow(END);
    assert.throws(() => admission.register(first.evaluationId), /expired/);
    assert.throws(() => admission.register(second.evaluationId), /expiry|expired/);
    assert.deepEqual(admission.get(first.evaluationId), stored);
    assert.equal(admission.get(second.evaluationId), null);
  });
});

test('P10 cannot reuse another evaluation advice or accept conflicting recorded bytes', () => {
  withStore(({ database, admission, intents }) => {
    const first = contracts('shadow').request;
    const second = resealRequest({ ...first, evaluationId: 'fixture-evaluation-2' });
    record(intents, first);
    record(intents, second);
    const registered = admission.register(first.evaluationId);
    const other = admission.register(second.evaluationId);
    assert.notEqual(other.registrationId, registered.registrationId);
    assert.notEqual(other.advice.adviceDigest, registered.advice.adviceDigest);
    database.prepare('UPDATE ags_semantic_results_v1 SET result_digest=?, result_json=? WHERE evaluation_id=?')
      .run(digest(result('option-b')), canonical(result('option-b')), first.evaluationId);
    assert.throws(() => admission.register(first.evaluationId), /does not match/);
    database.prepare('DELETE FROM ags_semantic_advice_v1 WHERE evaluation_id=?').run(first.evaluationId);
    database.prepare('UPDATE ags_semantic_advice_v1 SET evaluation_id=?, request_digest=?, result_digest=? WHERE evaluation_id=?')
      .run(first.evaluationId, first.requestDigest, digest(result('option-b')), second.evaluationId);
    assert.throws(() => admission.get(first.evaluationId));
  });
});

test('P10 readback rejects a re-sealed Choice that differs from the runner result', () => {
  withStore(({ database, admission, intents }) => {
    const { request } = contracts('shadow');
    record(intents, request);
    const stored = admission.register(request.evaluationId);
    const forged = seal({ ...stored.advice, choice: result('option-b').choice }, 'adviceDigest');
    database.prepare('UPDATE ags_semantic_advice_v1 SET advice_digest=?, advice_json=? WHERE evaluation_id=?')
      .run(forged.adviceDigest, canonical(forged), request.evaluationId);
    assert.throws(() => admission.get(request.evaluationId), /inconsistent/);
    assert.throws(() => admission.register(request.evaluationId), /inconsistent/);
  });
});
