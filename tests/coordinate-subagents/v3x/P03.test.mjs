import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadCatalog } from '../../../skills/coordinate-subagents/scripts/model-catalog.mjs';
import { projectSemanticState } from '../../../mcp-server/src/semantic/state-projection.ts';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

function input() {
  const { legacy, question } = contracts();
  return { routingRequest: legacy.req, catalog: loadCatalog(),
    eligibleModelIds: ['claude-opus-5-5', 'claude-fable-5-1'], question };
}

test('P03 projects task requirements and sourced model descriptions without claiming live support', () => {
  const args = input();
  const original = structuredClone(args);
  const result = projectSemanticState(args);
  const text = JSON.parse(result.state.text);
  assert.equal(text.projectionVersion, result.projectionVersion);
  assert.equal(text.task.role, args.routingRequest.role);
  assert.deepEqual(text.task.requirements.inputModalities, args.routingRequest.requirements.inputModalities);
  assert.deepEqual(text.task.requirements.requireObservable, args.routingRequest.requirements.requireObservable);
  assert.deepEqual(text.models.map(model => model.id), args.eligibleModelIds);
  for (const model of text.models) {
    assert.ok(model.officialPositioning);
    assert.ok(model.recommendationBasis.includes('policy class'));
    assert.ok(model.sources.some(source => source.evidenceKind === 'official-document'));
    assert.equal(model.hostCapability, 'requires-current-capability-snapshot');
    assert.equal(model.measuredAbilityScore, null);
    assert.ok(model.catalogVerification.includes('documented'));
    assert.ok(!model.catalogVerification.includes('live-verified'));
  }
  assert.equal(text.models[1].policyStatus, 'seed');
  assert.equal(result.state.sources[0].digest, args.routingRequest.binding.inputDigest);
  assert.equal(result.state.sources[1].digest, args.catalog.catalogDigest);
  assert.ok(!result.state.text.includes('quota'));
  assert.ok(!result.state.text.includes('excludedActors'));
  assert.deepEqual(args, original);

  const { request } = contracts();
  const prepared = resealRequest({ ...request, state: result.state, question: result.question });
  assert.equal(prepared.stateDigest, result.stateDigest);
  assert.equal(prepared.questionDigest, result.questionDigest);
  assert.deepEqual(new ContractValidator().semanticDecisionRequestV1(prepared), prepared);
});

test('P03 changes digest for description, evidence and projection version, preserving old snapshots', () => {
  const args = input();
  const first = projectSemanticState(args);
  const snapshot = structuredClone(first);
  const changedDescription = structuredClone(args);
  changedDescription.catalog.models.find(model => model.id === 'claude-opus-5-5').officialPositioning += ' Updated.';
  assert.notEqual(projectSemanticState(changedDescription).stateDigest, first.stateDigest);
  const changedEvidence = structuredClone(args);
  changedEvidence.catalog.sources.find(source => source.id === 'CLAUDE-OPUS-55').checkedAt = '2026-09-24T00:00:00.000Z';
  assert.notEqual(projectSemanticState(changedEvidence).stateDigest, first.stateDigest);
  assert.notEqual(projectSemanticState({ ...args, projectionVersion: '1.0.1' }).stateDigest, first.stateDigest);
  const changedQuestion = structuredClone(args);
  changedQuestion.question.version = '1.0.1';
  assert.notEqual(projectSemanticState(changedQuestion).questionDigest, first.questionDigest);
  assert.deepEqual(first, snapshot);
});

test('P03 excludes unrelated and secret catalog fields and rejects missing model evidence', () => {
  const args = input();
  const first = projectSemanticState(args);
  const expanded = structuredClone(args);
  expanded.catalog.secretToken = 'never-project-this';
  expanded.catalog.models.find(model => model.id === 'claude-opus-5-5').secretToken = 'never-project-this';
  expanded.catalog.models.find(model => model.id === 'claude-opus-5-5').quota = 999;
  assert.equal(projectSemanticState(expanded).stateDigest, first.stateDigest);
  assert.ok(!projectSemanticState(expanded).state.text.includes('never-project-this'));
  const missingSource = structuredClone(args);
  missingSource.catalog.sources = missingSource.catalog.sources.filter(source => source.id !== 'CLAUDE-OPUS-55');
  assert.throws(() => projectSemanticState(missingSource), /Missing catalog source/);
  assert.throws(() => projectSemanticState({ ...args, eligibleModelIds: ['unknown-model'] }), /Unknown eligible model/);
  assert.throws(() => projectSemanticState({ ...args, projectionVersion: '' }), /Invalid semantic state projection input/);
});
