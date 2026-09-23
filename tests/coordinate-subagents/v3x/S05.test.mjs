import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { test } from 'vitest';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import {
  canonical, collectEligibleCandidatesV2, digest, getBaselineCandidateMetadataV2,
  resolveV2, seal, verifySeal,
} from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { projectSemanticCandidatesV1 } from '../../../skills/coordinate-subagents/scripts/semantic/candidate-projection.mjs';
import { reduceSemanticDecisionV1 } from '../../../skills/coordinate-subagents/scripts/semantic/reducer.mjs';
import { capability, environment, request } from '../model-routing-v2/fixtures.mjs';
import { bindingFields, contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

const validator = new ContractValidator();
function fixture(preferred = false) {
  const req = request(preferred ? { user: { strength: 'preferred', model: 'gpt-5.6-terra' } } : {});
  const env = environment({ capabilities: [
    capability({ actorId: 'actor-a', sessionId: 'session-a' }),
    capability({ actorId: 'actor-b', sessionId: 'session-b', host: 'anthropic-claude-code' }),
    capability({ actorId: 'actor-c', sessionId: 'session-c' }, { model: 'gpt-5.6-sol', resolvedModel: 'gpt-5.6-sol' }),
    capability({ actorId: 'actor-d', sessionId: 'session-d' }, { model: 'gpt-6-astra', resolvedModel: 'gpt-6-astra' }),
  ] });
  const pool = collectEligibleCandidatesV2(req, env);
  const mapping = projectSemanticCandidatesV1(pool.candidates, getBaselineCandidateMetadataV2(pool.candidates, req, env));
  const base = contracts();
  const prepared = resealRequest({
    ...base.request, binding: structuredClone(req.binding), effectiveRoutingRequestDigest: digest(req),
    catalogDigest: env.catalog.catalogDigest, routingPolicyDigest: digest(env.policy),
    capabilitySetDigest: pool.capabilitySetDigest, eligibleSet: mapping.eligibleSet, options: mapping.options,
  });
  const advice = seal({
    ...base.advice, ...Object.fromEntries(bindingFields.map(key => [key, structuredClone(prepared[key])])),
    semanticRequestDigest: prepared.requestDigest,
    choice: { kind: 'Choice', selectedOptionIds: mapping.options.map(option => option.optionId), confidence: 0.75 },
  }, 'adviceDigest');
  validator.semanticDecisionRequestV1(prepared);
  validator.semanticDecisionAdviceV1(advice);
  return { prepared, advice, adoption: { status: 'eligible', evidenceDigest: digest('admitted-evidence') },
    baselineDecision: resolveV2(req, env), candidates: pool.candidates };
}
const changeChoice = (input, selectedOptionIds) => ({
  ...input, advice: seal({ ...input.advice, choice: { ...input.advice.choice, selectedOptionIds } }, 'adviceDigest'),
});
const permutations = values => values.length === 0 ? [[]]
  : values.flatMap((value, index) => permutations(values.filter((_, other) => other !== index))
    .map(tail => [value, ...tail]));

test('every ordering of co-best options selects the same existing concrete binding', () => {
  const input = fixture(), before = canonical(input);
  const ids = input.prepared.options.map(option => option.optionId);
  assert.equal(ids.length, 3);
  const decisions = permutations(ids).map(order => reduceSemanticDecisionV1(changeChoice(input, order)));
  assert.equal(decisions.length, 6);
  for (const decision of decisions) {
    assert.deepEqual(decision.selected, decisions[0].selected);
    assert.deepEqual(decision.target, decisions[0].target);
    assert.equal(decision.semantic.selectedOptionId, decisions[0].semantic.selectedOptionId);
  }
  const winner = input.candidates.find(candidate => candidate.snapshot.sessionId === decisions[0].target.sessionId);
  assert(winner);
  assert.equal(decisions[0].selected.resolvedModel, winner.binding.resolvedModel);
  assert.deepEqual(decisions[0].selected.nativeReasoning, winner.binding.nativeReasoning);
  assert.equal(decisions[0].selected.runtimeMode, winner.binding.runtimeMode);
  assert.equal(decisions[0].invocationSurface, winner.binding.invocationSurface);
  assert.equal(decisions[0].executionAuthorized, false);
  assert.equal(decisions[0].trustedGateSatisfied, false);
  validator.modelRoutingDecisionV3(decisions[0]);
  verifySeal(decisions[0], 'decisionDigest');
  assert.equal(canonical(input), before);
});

test('baseline rank chooses the concrete candidate within the selected model option', () => {
  const input = fixture();
  const terra = input.prepared.options.find(option => option.model === 'gpt-5.6-terra');
  assert.equal(terra.candidateKeys.length, 2);
  const decision = reduceSemanticDecisionV1(changeChoice(input, [terra.optionId]));
  const expected = input.prepared.eligibleSet.find(item => item.model === terra.model);
  const candidate = input.candidates.find(item => item.key === expected.candidateKey);
  assert.equal(decision.target.sessionId, candidate.snapshot.sessionId);
  assert.equal(decision.semantic.selectedOptionId, terra.optionId);
  assert.equal(decision.semantic.baselineDecisionDigest, input.baselineDecision.decisionDigest);
  validator.modelRoutingDecisionV3(decision);
});

test('preferred surviving group cannot be crossed by advice', () => {
  const input = fixture(true);
  assert.deepEqual([...new Set(input.prepared.eligibleSet.map(item => item.preferenceGroup))], [0, 1]);
  const terra = input.prepared.options.find(option => option.model === 'gpt-5.6-terra');
  const sol = input.prepared.options.find(option => option.model === 'gpt-5.6-sol');
  assert.throws(() => reduceSemanticDecisionV1(changeChoice(input, [sol.optionId])), { code: 'PREFERENCE_GROUP_VIOLATION' });
  const accepted = reduceSemanticDecisionV1(changeChoice(input, [sol.optionId, terra.optionId]));
  assert.equal(accepted.selected.resolvedModel, terra.model);
  assert.equal(accepted.semantic.selectedOptionId, terra.optionId);
});

test('non-adoption, unknown option, altered mapping or concrete binding cannot produce v3', () => {
  const input = fixture();
  assert.throws(() => reduceSemanticDecisionV1({ ...input, adoption: { status: 'baseline', reasonCode: 'SHADOW_ONLY' } }), { code: 'ADOPTION_NOT_ELIGIBLE' });
  assert.throws(() => reduceSemanticDecisionV1(changeChoice(input, ['unknown-option'])), { code: 'UNKNOWN_OPTION' });
  const mapping = structuredClone(input.prepared);
  mapping.options[0].candidateKeys.pop();
  assert.throws(() => reduceSemanticDecisionV1({ ...input, prepared: resealRequest(mapping) }), { code: 'ADVICE_BINDING_MISMATCH' });
  const candidates = structuredClone(input.candidates);
  candidates[0].binding.nativeReasoning.value = 'medium';
  assert.throws(() => reduceSemanticDecisionV1({ ...input, candidates }), { code: 'DIGEST_MISMATCH' });
});

test('declaration requires an eligible adoption and returns non-authorizing v3', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const virtual = path.join(root, 'contracts', '__s05_virtual.ts');
  const source = `
    import { reduceSemanticDecisionV1 } from '../skills/coordinate-subagents/scripts/semantic/reducer.mjs';
    import type { SemanticDecisionRequestV1, SemanticDecisionAdviceV1, ModelRoutingDecisionV2 } from './types.js';
    import type { EligibleCandidateV2 } from '../skills/coordinate-subagents/scripts/model-routing-core.mjs';
    declare const prepared: SemanticDecisionRequestV1;
    declare const advice: SemanticDecisionAdviceV1;
    declare const baselineDecision: ModelRoutingDecisionV2;
    declare const candidates: EligibleCandidateV2[];
    const common = { prepared, advice, baselineDecision, candidates };
    const result = reduceSemanticDecisionV1({ ...common, adoption: { status: 'eligible', evidenceDigest: 'sha256:fixture' } });
    const version: '3.0.0' = result.schemaVersion;
    // @ts-expect-error Baseline/non-adoption is not a reducer input.
    reduceSemanticDecisionV1({ ...common, adoption: { status: 'baseline', reasonCode: 'SHADOW_ONLY' } });
    // @ts-expect-error Reduction does not grant execution authority.
    const authority: true = result.executionAuthorized;
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
