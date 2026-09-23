import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { onTestFinished, test } from 'vitest';

import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import { readDecision } from '../../../mcp-server/src/routing-v3/decision-codec.ts';
import { canonical, digest, seal } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { ModelRoutingStore } from '../../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { fixture, NOW } from '../model-routing-v2/fixtures.mjs';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';

const validator = new ContractValidator();
function setup() {
  const db = new DatabaseSync(':memory:');
  onTestFinished(() => db.close());
  return { db, store: new ModelRoutingStore(db) };
}
function insert(db, request, environment, decision) {
  db.prepare('INSERT INTO ags_model_decisions_v2 VALUES (?,?,?,?,?,?)').run(
    decision.decisionDigest, digest(decision.binding), canonical(request), canonical(environment), canonical(decision), NOW,
  );
}

test('existing v2 row is read without a shape change', () => {
  const { db, store } = setup(), { req, env, decision } = fixture();
  insert(db, req, env, decision);
  assert.deepEqual(store.decision(decision.decisionDigest), { request: req, environment: env, decision, resolvedAt: NOW });
  assert.deepEqual(readDecision(store, decision.decisionDigest, validator)?.decision, decision);
});

test('v3 row retains semantic and auxiliary decision fields', () => {
  const { db, store } = setup(), { legacy, decision } = contracts();
  insert(db, legacy.req, legacy.env, decision);
  const entry = readDecision(store, decision.decisionDigest, validator);
  assert.deepEqual(entry?.decision, decision);
  assert.deepEqual(entry?.decision.semantic, decision.semantic);
  assert.deepEqual(entry?.decision.rejectedCandidates, decision.rejectedCandidates);
});

test('v3 missing or malformed mandatory semantic references are rejected', () => {
  for (const mutation of [
    semantic => { delete semantic.adviceDigest; },
    semantic => { semantic.selectedOptionId = ''; },
    semantic => { semantic.optionMappingDigest = 'not-a-digest'; },
  ]) {
    const { db, store } = setup(), { legacy, decision } = contracts();
    const semantic = structuredClone(decision.semantic);
    mutation(semantic);
    const malformed = seal({ ...decision, semantic }, 'decisionDigest');
    insert(db, legacy.req, legacy.env, malformed);
    assert.throws(() => store.decision(malformed.decisionDigest));
    assert.throws(() => readDecision(store, malformed.decisionDigest, validator));
  }
});

test('store and typed codec both reject a resealed v3 row with an invalid selected field', () => {
  const { db, store } = setup(), { legacy, decision } = contracts();
  const malformed = seal({ ...decision, selected: null }, 'decisionDigest');
  insert(db, legacy.req, legacy.env, malformed);
  assert.throws(() => store.decision(malformed.decisionDigest));
  assert.throws(() => readDecision(store, malformed.decisionDigest, validator));
});

test('unsupported decision version is rejected instead of read as v2', () => {
  const { db, store } = setup(), { legacy, decision } = contracts();
  const unsupported = { ...decision, schemaVersion: '4.0.0' };
  insert(db, legacy.req, legacy.env, unsupported);
  assert.throws(() => store.decision(unsupported.decisionDigest), error => error.code === 'UNSUPPORTED_DECISION_VERSION');
  assert.throws(() => readDecision(store, unsupported.decisionDigest, validator));
});
