import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { test } from 'vitest';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import { canonical, digest, seal } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { assessSemanticAdoptionV1 } from '../../../skills/coordinate-subagents/scripts/semantic/adoption-guard.mjs';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

const validator = new ContractValidator();
function fixture() {
  const base = contracts(), evidenceDigest = digest('fixture-evidence');
  const policy = {
    ...base.policy, mode: 'assist',
    adoption: { status: 'validated', minimumConfidence: 0.75, evidenceDigest,
      provider: structuredClone(base.request.provider), questionDigest: base.request.questionDigest,
      reducerVersion: base.request.reducerVersion },
    egress: { enabled: true, allowedProviders: [base.request.provider.id] },
  };
  const prepared = resealRequest({ ...base.request, semanticPolicyDigest: digest(policy) });
  const advice = seal({ ...base.advice, semanticPolicyDigest: prepared.semanticPolicyDigest,
    semanticRequestDigest: prepared.requestDigest }, 'adviceDigest');
  validator.semanticDecisionPolicyV1(policy);
  validator.semanticDecisionRequestV1(prepared);
  validator.semanticDecisionAdviceV1(advice);
  return { policy, routingRequest: base.legacy.req, prepared, advice,
    admission: { status: 'admitted', evidenceDigest } };
}
const assess = ({ policy, routingRequest, prepared, advice, admission }) =>
  assessSemanticAdoptionV1(policy, routingRequest, prepared, advice, admission);
const baseline = reasonCode => ({ status: 'baseline', reasonCode });

test('off and shadow never adopt; validated policy alone does not admit evidence', () => {
  const input = fixture(), before = canonical(input);
  assert.deepEqual(assess({ ...input, policy: { ...input.policy, mode: 'off' } }), baseline('POLICY_OFF'));
  assert.deepEqual(assess({ ...input, policy: { ...input.policy, mode: 'shadow' } }), baseline('SHADOW_ONLY'));
  assert.deepEqual(assess({ ...input, policy: { ...input.policy, adoption: { status: 'unvalidated', minimumConfidence: null, evidenceDigest: null } } }), baseline('ADOPTION_UNVALIDATED'));
  assert.deepEqual(assess({ ...input, policy: { ...input.policy, adoption: { ...input.policy.adoption, evidenceDigest: 'unverified' } } }), baseline('ADOPTION_UNVALIDATED'));
  assert.deepEqual(assess({ ...input, admission: null }), baseline('EVIDENCE_NOT_ADMITTED'));
  assert.deepEqual(assess({ ...input, admission: { status: 'admitted', evidenceDigest: digest('other') } }), baseline('EVIDENCE_NOT_ADMITTED'));
  assert.deepEqual(assess(input), { status: 'eligible', evidenceDigest: input.admission.evidenceDigest });
  assert.equal(canonical(input), before);
});

test('high risk and independent audit are excluded; required and preferred scope is preserved', () => {
  const input = fixture();
  assert.deepEqual(assess({ ...input, routingRequest: { ...input.routingRequest, highRisk: true } }), baseline('HIGH_RISK_EXCLUDED'));
  assert.deepEqual(assess({ ...input, routingRequest: { ...input.routingRequest, role: 'independent-audit' } }), baseline('INDEPENDENT_AUDIT_EXCLUDED'));
  for (const [strength, flag] of [['required', 'preserveRequired'], ['preferred', 'preservePreferred']]) {
    const requested = { ...input, routingRequest: { ...input.routingRequest, user: { strength, model: 'gpt-5.6-terra' } } };
    assert.equal(assess(requested).status, 'eligible');
    assert.deepEqual(assess({ ...requested, policy: { ...input.policy, assistScope: { ...input.policy.assistScope, [flag]: false } } }), baseline('SCOPE_NOT_PRESERVED'));
  }
});

test('confidence null, below threshold, and equality are distinct', () => {
  const input = fixture();
  assert.deepEqual(assess({ ...input, advice: { ...input.advice, choice: { ...input.advice.choice, confidence: null } } }), baseline('CONFIDENCE_UNKNOWN'));
  assert.deepEqual(assess({ ...input, advice: { ...input.advice, choice: { ...input.advice.choice, confidence: 0.749 } } }), baseline('CONFIDENCE_BELOW_MINIMUM'));
  assert.equal(assess(input).status, 'eligible'); // Exactly 0.75 meets the configured 0.75 threshold.
});

test('provider, question, reducer and request binding mismatches are separated', () => {
  const input = fixture();
  const adoption = input.policy.adoption;
  assert.deepEqual(assess({ ...input, policy: { ...input.policy, adoption: { ...adoption, provider: { ...adoption.provider, model: 'other-model' } } } }), baseline('PROVIDER_MISMATCH'));
  assert.deepEqual(assess({ ...input, policy: { ...input.policy, adoption: { ...adoption, questionDigest: digest('other-question') } } }), baseline('QUESTION_MISMATCH'));
  assert.deepEqual(assess({ ...input, policy: { ...input.policy, adoption: { ...adoption, reducerVersion: 'other-reducer' } } }), baseline('REDUCER_MISMATCH'));
  assert.deepEqual(assess({ ...input, advice: { ...input.advice, semanticRequestDigest: digest('other-request') } }), baseline('REQUEST_BINDING_MISMATCH'));
  assert.deepEqual(assess({ ...input, policy: { ...input.policy, egress: { enabled: false, allowedProviders: [] } } }), baseline('PROVIDER_NOT_ALLOWED'));
});

test('admitted evidence is a separate service input in the declaration', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const virtual = path.join(root, 'contracts', '__s04_virtual.ts');
  const source = `
    import { assessSemanticAdoptionV1, type ServiceAdmittedSemanticEvidenceV1 } from '../skills/coordinate-subagents/scripts/semantic/adoption-guard.mjs';
    import type { SemanticDecisionPolicyV1, SemanticDecisionRequestV1, SemanticDecisionAdviceV1, ModelSelectionRequestV2 } from './types.js';
    declare const policy: SemanticDecisionPolicyV1;
    declare const routing: ModelSelectionRequestV2;
    declare const prepared: SemanticDecisionRequestV1;
    declare const advice: SemanticDecisionAdviceV1;
    declare const admission: ServiceAdmittedSemanticEvidenceV1;
    const assessment = assessSemanticAdoptionV1(policy, routing, prepared, advice, admission);
    if (assessment.status === 'eligible') { const digest: string = assessment.evidenceDigest; }
    // @ts-expect-error A raw digest is not a service admission.
    assessSemanticAdoptionV1(policy, routing, prepared, advice, 'sha256:raw');
    // @ts-expect-error An assessment grants no execution authority.
    const authority: true = assessment.executionAuthorized;
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
