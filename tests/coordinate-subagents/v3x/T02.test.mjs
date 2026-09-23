import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { onTestFinished, test } from 'vitest';

import { RegisteredDecisionWriter } from '../../../mcp-server/src/routing-v3/decision-writer.ts';
import { SemanticAdviceAdmissionStore } from '../../../mcp-server/src/semantic/advice-admission.ts';
import { SemanticEvaluationIntentStore } from '../../../mcp-server/src/semantic/evaluation-intent.ts';
import {
  canonical, collectEligibleCandidatesV2, digest, getBaselineCandidateMetadataV2, resolveV2, seal,
} from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { ModelRoutingStore } from '../../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { projectSemanticCandidatesV1 } from '../../../skills/coordinate-subagents/scripts/semantic/candidate-projection.mjs';
import { SEMANTIC_REDUCER_VERSION_V1 } from '../../../skills/coordinate-subagents/scripts/semantic/replay.mjs';
import { capability, environment, NOW, LATER, request } from '../model-routing-v2/fixtures.mjs';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

const rawResult = optionId => ({ status: 'success',
  choice: { kind: 'Choice', selectedOptionIds: [optionId], confidence: 0.8 } });
const adoption = { status: 'eligible', evidenceDigest: digest('test-only-admitted-evidence') };

function setup({ register = true, database = new DatabaseSync(':memory:'), cleanup = true } = {}) {
  if (cleanup) onTestFinished(() => database.close());
  const store = new ModelRoutingStore(database);
  const writer = new RegisteredDecisionWriter(store, { read: () => adoption });
  const routingRequest = request();
  const routingEnvironment = environment({ now: NOW, capabilities: [
    capability({ actorId: 'actor-terra', sessionId: 'session-terra' }),
    capability({ actorId: 'actor-sol', sessionId: 'session-sol' },
      { model: 'gpt-5.6-sol', resolvedModel: 'gpt-5.6-sol' }),
  ] });
  const baseline = resolveV2(routingRequest, routingEnvironment);
  store.saveDecision(routingRequest, routingEnvironment, baseline, NOW);
  const pool = collectEligibleCandidatesV2(routingRequest, routingEnvironment);
  const metadata = getBaselineCandidateMetadataV2(pool.candidates, routingRequest, routingEnvironment);
  const projection = projectSemanticCandidatesV1(pool.candidates, metadata);
  const prepared = resealRequest({
    ...contracts().request, evaluationId: 't02-evaluation',
    binding: structuredClone(routingRequest.binding),
    effectiveRoutingRequestDigest: digest(routingRequest),
    catalogDigest: routingEnvironment.catalog.catalogDigest,
    routingPolicyDigest: digest(routingEnvironment.policy),
    capabilitySetDigest: pool.capabilitySetDigest,
    eligibleSet: projection.eligibleSet, options: projection.options,
    reducerVersion: SEMANTIC_REDUCER_VERSION_V1,
  });
  const intents = new SemanticEvaluationIntentStore(database);
  intents.begin('t02-idempotency', prepared);
  const claim = intents.claim(prepared.evaluationId, prepared.requestDigest, 'runner-t02');
  intents.recordResult(prepared.evaluationId, prepared.requestDigest, claim.claimId,
    rawResult(prepared.options[0].optionId));
  const admission = new SemanticAdviceAdmissionStore(database, () => LATER);
  const registered = register ? admission.register(prepared.evaluationId) : null;
  const input = { evaluationId: prepared.evaluationId,
    registrationId: registered?.registrationId ?? 'missing-registration',
    baselineDecisionDigest: baseline.decisionDigest, decisionTime: LATER };
  return { database, store, writer, routingRequest, routingEnvironment, baseline, prepared, registered, input };
}
function counts(database) {
  return {
    decisions: database.prepare('SELECT COUNT(*) AS n FROM ags_model_decisions_v2').get().n,
    references: database.prepare('SELECT COUNT(*) AS n FROM ags_model_decision_refs_v3').get().n,
  };
}

test('only registered advice and the stored v2 environment produce an atomic v3 decision', () => {
  const { database, store, writer, baseline, registered, input } = setup();
  const decision = writer.write(input);
  assert.equal(decision.schemaVersion, '3.0.0');
  assert.equal(decision.semantic.adviceDigest, registered.advice.adviceDigest);
  assert.equal(decision.semantic.baselineDecisionDigest, baseline.decisionDigest);
  assert.deepEqual(store.decision(decision.decisionDigest).decision, decision);
  assert.deepEqual(counts(database), { decisions: 2, references: 1 });
  const ref = database.prepare('SELECT * FROM ags_model_decision_refs_v3').get();
  assert.equal(ref.registration_id, registered.registrationId);
  assert.equal(ref.decision_digest, decision.decisionDigest);
});

test('caller-made v3 fixture and missing or partial registration references are rejected', () => {
  const f = setup();
  const decision = f.writer.write(f.input);
  assert.throws(() => f.store.saveDecision(f.routingRequest, f.routingEnvironment, decision, LATER),
    { code: 'V3_WRITER_REQUIRED' });
  assert.equal(f.store.saveRegisteredDecisionV3, undefined);
  assert.throws(() => f.writer.write({ ...f.input, decision }), /Only registered decision references/);
  assert.throws(() => f.writer.write({ ...f.input, adoption }), /Only registered decision references/);
  assert.throws(() => new RegisteredDecisionWriter(f.store).write(f.input), /service-admitted/);
  assert.throws(() => f.writer.write({ ...f.input, registrationId: 'missing-registration' }));
  assert.throws(() => f.writer.write({ ...f.input, baselineDecisionDigest: digest('missing-baseline') }));
  assert.deepEqual(counts(f.database), { decisions: 2, references: 1 });
  const unregistered = setup({ register: false });
  assert.throws(() => unregistered.writer.write(unregistered.input), /registered runner advice/);
  assert.deepEqual(counts(unregistered.database), { decisions: 1, references: 0 });
});

test('schema-valid tampering of a stored v2 baseline cannot produce v3 rows or references', () => {
  const f = setup();
  const changedSeal = { ...f.baseline, decisionDigest: digest('changed-seal') };
  f.database.prepare('UPDATE ags_model_decisions_v2 SET payload=? WHERE decision_digest=?')
    .run(canonical(changedSeal), f.baseline.decisionDigest);
  assert.throws(() => f.writer.write(f.input), { code: 'DIGEST_MISMATCH' });
  assert.deepEqual(counts(f.database), { decisions: 1, references: 0 });

  const resealed = seal({ ...f.baseline, requestDigest: digest('changed-request') }, 'decisionDigest');
  f.database.prepare('UPDATE ags_model_decisions_v2 SET payload=? WHERE decision_digest=?')
    .run(canonical(resealed), f.baseline.decisionDigest);
  assert.throws(() => f.writer.write(f.input), { code: 'BASELINE_MISMATCH' });
  assert.deepEqual(counts(f.database), { decisions: 1, references: 0 });
});

test('identical retry is idempotent; conflicting stored bytes are rejected', () => {
  const f = setup(), first = f.writer.write(f.input);
  assert.deepEqual(f.writer.write(f.input), first);
  assert.deepEqual(counts(f.database), { decisions: 2, references: 1 });
  f.database.prepare('UPDATE ags_model_decisions_v2 SET environment_json=? WHERE decision_digest=?')
    .run('{}', first.decisionDigest);
  assert.throws(() => f.writer.write(f.input), { code: 'DECISION_CONFLICT' });
  assert.deepEqual(counts(f.database), { decisions: 2, references: 1 });
});

test('a reference insert failure rolls back the v3 decision row', () => {
  const f = setup();
  f.database.exec(`CREATE TRIGGER reject_t02_ref BEFORE INSERT ON ags_model_decision_refs_v3
    BEGIN SELECT RAISE(ABORT, 'fixture reference failure'); END;`);
  assert.throws(() => f.writer.write(f.input), /fixture reference failure/);
  assert.deepEqual(counts(f.database), { decisions: 1, references: 0 });
});

test('two connections serialize the same registered write without a partial row', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ags-t02-'));
  const file = join(directory, 'routing.sqlite3');
  const firstDb = new DatabaseSync(file);
  let secondDb;
  try {
    const first = setup({ database: firstDb, cleanup: false });
    secondDb = new DatabaseSync(file);
    const secondStore = new ModelRoutingStore(secondDb);
    const secondWriter = new RegisteredDecisionWriter(secondStore, { read: () => adoption });
    const decision = first.writer.write(first.input);
    assert.deepEqual(secondWriter.write(first.input), decision);
    assert.deepEqual(counts(secondDb), { decisions: 2, references: 1 });
  } finally {
    secondDb?.close();
    firstDb.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
