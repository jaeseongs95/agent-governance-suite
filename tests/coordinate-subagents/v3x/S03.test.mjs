import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { test, vi } from 'vitest';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import {
  canonical, collectEligibleCandidatesV2, digest, getBaselineCandidateMetadataV2,
} from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { projectSemanticCandidatesV1 } from '../../../skills/coordinate-subagents/scripts/semantic/candidate-projection.mjs';
import { assertPreparedSemanticInputV1 } from '../../../skills/coordinate-subagents/scripts/semantic/prepared-input-check.mjs';
import { capability, environment, NOW, LATER, END } from '../model-routing-v2/fixtures.mjs';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

const validator = new ContractValidator();
function preparedFixture() {
  const base = contracts(), routingRequest = base.legacy.req;
  const env = environment({ capabilities: [
    capability({ sessionId: 'terra' }),
    capability({ sessionId: 'sol' }, { model: 'gpt-5.6-sol', resolvedModel: 'gpt-5.6-sol' }),
  ] });
  const pool = collectEligibleCandidatesV2(routingRequest, env);
  const metadata = getBaselineCandidateMetadataV2(pool.candidates, routingRequest, env);
  const mapping = projectSemanticCandidatesV1(pool.candidates, metadata);
  const prepared = resealRequest({
    ...base.request, binding: structuredClone(routingRequest.binding),
    effectiveRoutingRequestDigest: digest(routingRequest),
    catalogDigest: env.catalog.catalogDigest, routingPolicyDigest: digest(env.policy),
    capabilitySetDigest: pool.capabilitySetDigest,
    eligibleSet: mapping.eligibleSet, options: mapping.options,
    requestedAt: NOW, expiresAt: END,
  });
  validator.semanticDecisionRequestV1(prepared);
  return { prepared, routingRequest, env };
}
const check = ({ prepared, routingRequest, env }, at = env.now) =>
  assertPreparedSemanticInputV1(prepared, routingRequest, env, at);
function forged(fixture, edit) {
  const prepared = structuredClone(fixture.prepared);
  edit(prepared);
  const resealed = resealRequest(prepared);
  validator.semanticDecisionRequestV1(resealed); // Contract-valid forgery must still fail recomputation.
  return { ...fixture, prepared: resealed };
}

test('recomputes matching candidates and digests at an explicit time without mutation or wall clock', () => {
  const fixture = preparedFixture(), before = canonical(fixture);
  assert.notEqual(fixture.routingRequest.binding.candidateDigest, digest(fixture.prepared.eligibleSet));
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Implicit wall-clock read'); });
  try {
    assert.equal(check(fixture), true);
    assert.equal(check({ ...fixture, env: { ...fixture.env, now: LATER } }, LATER), true);
    assert.equal(canonical(fixture), before);
  } finally { spy.mockRestore(); }
});

test('rejects schema-valid forged eligible candidate and baseline rank', () => {
  const fixture = preparedFixture();
  const candidate = forged(fixture, prepared => {
    const old = prepared.eligibleSet[0].candidateKey;
    prepared.eligibleSet[0].candidateKey = 'forged-candidate';
    for (const option of prepared.options) option.candidateKeys = option.candidateKeys.map(key => key === old ? 'forged-candidate' : key);
  });
  assert.throws(() => check(candidate), { code: 'PREPARED_INPUT_MISMATCH' });
  const rank = forged(fixture, prepared => {
    [prepared.eligibleSet[0].baselineRank, prepared.eligibleSet[1].baselineRank] =
      [prepared.eligibleSet[1].baselineRank, prepared.eligibleSet[0].baselineRank];
  });
  assert.throws(() => check(rank), { code: 'PREPARED_INPUT_MISMATCH' });
});

test('rejects schema-valid forged option mapping and changed routing binding', () => {
  const fixture = preparedFixture();
  const options = forged(fixture, prepared => { prepared.options[0].optionId = 'forged-option'; });
  assert.throws(() => check(options), { code: 'PREPARED_INPUT_MISMATCH' });
  const binding = forged(fixture, prepared => { prepared.binding.candidateDigest = digest('forged-candidate-digest'); });
  assert.throws(() => check(binding), { code: 'BINDING_MISMATCH' });
  assert.equal(fixture.routingRequest.binding.candidateDigest, fixture.prepared.binding.candidateDigest);
});

test('rejects explicit time mismatch, expired preparation, and an empty fresh pool', () => {
  const fixture = preparedFixture();
  assert.throws(() => check({ ...fixture, env: { ...fixture.env, now: LATER } }, NOW), { code: 'EVALUATION_TIME_MISMATCH' });
  assert.throws(() => check(fixture, END), { code: 'EVALUATION_TIME_MISMATCH' });
  assert.throws(() => check({ ...fixture, env: { ...fixture.env, capabilities: [] } }), { code: 'NO_ELIGIBLE_CANDIDATE' });
});

test('prepared input check declaration takes typed routing inputs without authority', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const virtual = path.join(root, 'contracts', '__s03_virtual.ts');
  const source = `
    import { assertPreparedSemanticInputV1 } from '../skills/coordinate-subagents/scripts/semantic/prepared-input-check.mjs';
    import type { SemanticDecisionRequestV1, ModelSelectionRequestV2 } from './types.js';
    import type { RoutingEnvironmentV2 } from '../skills/coordinate-subagents/scripts/model-routing-core.mjs';
    declare const prepared: SemanticDecisionRequestV1;
    declare const routing: ModelSelectionRequestV2;
    declare const env: RoutingEnvironmentV2;
    const checked: true = assertPreparedSemanticInputV1(prepared, routing, env, env.now);
    // @ts-expect-error A match assertion is not execution authority.
    const authority: true = checked.executionAuthorized;
  `;
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options);
  const originalGet = host.getSourceFile.bind(host), originalExists = host.fileExists.bind(host);
  host.fileExists = file => path.normalize(file) === virtual || originalExists(file);
  host.getSourceFile = (file, version, onError, shouldCreate) => path.normalize(file) === virtual
    ? ts.createSourceFile(file, source, version, true) : originalGet(file, version, onError, shouldCreate);
  const errors = ts.getPreEmitDiagnostics(ts.createProgram([virtual], options, host))
    .filter(item => item.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')), []);
});
