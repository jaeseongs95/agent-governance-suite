import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ContractValidator, contractSchemas } from '../../../mcp-server/src/schema-validator.ts';
import { digest, seal } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { bindingFields, contracts, resealRequest } from './fixtures/contracts.mjs';

const validator = new ContractValidator();
const registrations = [
  ['semanticDecisionQuestionV1', 'question'], ['semanticDecisionPolicyV1', 'policy'],
  ['semanticDecisionRequestV1', 'request'], ['semanticDecisionAdviceV1', 'advice'],
  ['semanticModelAssignmentRequestV1', 'assignment'], ['modelRoutingDecisionV3', 'decision'],
  ['modelApplicationRequestV3', 'application'], ['modelApplicationRecordV3', 'record'],
];
const invalid = fn => assert.throws(fn, error => error.code === 'INVALID_INPUT');

for (const [method, field] of registrations) {
  test(`${method}: accepts the explicit fixture without mutating it`, () => {
    const value = contracts()[field], before = structuredClone(value);
    assert.equal(validator[method](value), value);
    assert.deepEqual(value, before);
  });
  test(`${method}: rejects every missing required top-level field`, () => {
    for (const key of contractSchemas[method].required) {
      const value = contracts()[field]; delete value[key];
      invalid(() => validator[method](value));
    }
  });
  test(`${method}: rejects extra fields and incompatible schema versions`, () => {
    const value = contracts()[field];
    invalid(() => validator[method]({ ...value, authority: true }));
    invalid(() => validator[method]({ ...value, schemaVersion: '2.0.0' }));
    invalid(() => validator[method]({ ...value, schemaVersion: '9.0.0' }));
  });
}

test('explicit MCP input accepts only the routing request and constrained task references', () => {
  const { assignment, request } = contracts();
  const keys = ['policy', 'capabilities', 'eligibleSet', 'options', 'admission', 'state', 'provider', 'advice', 'semanticPolicyDigest'];
  for (const key of keys) invalid(() => validator.semanticModelAssignmentRequestV1({ ...assignment, [key]: request[key] ?? {} }));
  invalid(() => validator.semanticModelAssignmentRequestV1({ ...assignment, taskRef: { taskId: 'other-task' } }));
  invalid(() => validator.semanticModelAssignmentRequestV1({ ...assignment, taskRef: { taskId: assignment.taskRef.taskId, url: 'https://not-fetched.invalid/' } }));
  validator.semanticModelAssignmentRequestV1({ ...assignment, taskRef: { ...assignment.taskRef, frameId: 'frame-1', artifactIds: ['artifact-1'] } });
});

test('default policy is off with no fabricated threshold or egress permission', () => {
  const { policy } = contracts();
  assert.equal(policy.mode, 'off'); assert.equal(policy.adoption.status, 'unvalidated');
  assert.equal(policy.adoption.minimumConfidence, null); assert.equal(policy.adoption.evidenceDigest, null);
  assert.deepEqual(policy.egress, { enabled: false, allowedProviders: [] });
  invalid(() => validator.semanticDecisionPolicyV1({ ...policy, mode: 'assist' }));
  invalid(() => validator.semanticDecisionPolicyV1({ ...policy, adoption: { ...policy.adoption, minimumConfidence: 0.9 } }));
  for (const key of ['highRisk', 'independentAudit', 'preserveRequired', 'preservePreferred']) {
    const changed = structuredClone(policy); changed.assistScope[key] = !changed.assistScope[key];
    invalid(() => validator.semanticDecisionPolicyV1(changed));
  }
});

test('a structurally validated opt-in policy still requires explicit provider allowlisting', () => {
  const { policy, request } = contracts();
  const validated = { ...policy, mode: 'assist', adoption: { status: 'validated', minimumConfidence: 1,
    evidenceDigest: digest('fixture-only-not-evaluation-evidence'), provider: request.provider,
    questionDigest: request.questionDigest, reducerVersion: request.reducerVersion },
    egress: { enabled: true, allowedProviders: [request.provider.id] } };
  validator.semanticDecisionPolicyV1(validated);
  invalid(() => validator.semanticDecisionPolicyV1({ ...validated, egress: { enabled: true, allowedProviders: ['someone-else'] } }));
  invalid(() => validator.semanticDecisionPolicyV1({ ...validated, egress: { ...validated.egress, enabled: false } }));
  invalid(() => validator.semanticDecisionPolicyV1({ ...validated, adoption: { ...validated.adoption, evidenceDigest: null } }));
});

for (const value of [null, 0, 1]) test(`Choice confidence boundary ${value} is well formed, not authority`, () => {
  const { request, advice } = contracts(); advice.choice.confidence = value;
  const checked = validator.semanticDecisionAdviceForRequestV1(seal(advice, 'adviceDigest'), request);
  assert.equal(checked.choice.confidence, value);
  assert.equal(Object.hasOwn(checked, 'executionAuthorized'), false);
});
for (const value of [NaN, Infinity, -Infinity, -0.001, 1.001, '0.75']) test(`reject invalid confidence ${value}`, () => {
  const { advice } = contracts(); advice.choice.confidence = value;
  invalid(() => validator.semanticDecisionAdviceV1(advice));
});

test('canonical JSON guards reject cycles, class instances, undefined and sparse arrays', () => {
  const cases = [];
  const cyclic = contracts().request; cyclic.state.loop = cyclic; cases.push(cyclic);
  const date = contracts().request; date.state = new Date(); cases.push(date);
  const undefinedValue = contracts().request; undefinedValue.state.text = undefined; cases.push(undefinedValue);
  const sparse = contracts().request; sparse.options = Array(2); cases.push(sparse);
  for (const request of cases) invalid(() => validator.semanticDecisionRequestV1(request));
});

test('Choice cannot be replaced with Score, Noul, an empty choice or duplicate choices', () => {
  const { advice } = contracts();
  for (const choice of [{ kind: 'Score', score: 1 }, { kind: 'Noul', value: true },
    { kind: 'Choice', selectedOptionIds: [], confidence: null },
    { kind: 'Choice', selectedOptionIds: ['option-a', 'option-a'], confidence: 1 }]) {
    invalid(() => validator.semanticDecisionAdviceV1(seal({ ...advice, choice }, 'adviceDigest')));
  }
});

test('a digest-valid unknown option is rejected by request/advice binding', () => {
  const { request, advice } = contracts(); advice.choice.selectedOptionIds = ['not-an-option'];
  const forged = seal(advice, 'adviceDigest'); validator.semanticDecisionAdviceV1(forged);
  invalid(() => validator.semanticDecisionAdviceForRequestV1(forged, request));
});

test('co-best choices are representable without inventing a reducer or a host binding', () => {
  const { request, advice } = contracts(); advice.choice.selectedOptionIds = ['option-b', 'option-a'];
  validator.semanticDecisionAdviceForRequestV1(seal(advice, 'adviceDigest'), request);
});

for (const field of [...bindingFields, 'semanticRequestDigest', 'expiresAt']) test(`reject resealed cross-request advice: ${field}`, () => {
  const { request, advice } = contracts();
  if (field === 'binding') advice.binding.taskId = 'other-task';
  else if (field === 'provider') advice.provider.adapterVersion = 'different-adapter';
  else if (field === 'expiresAt') advice.expiresAt = '2026-09-21T12:05:00.000Z';
  else advice[field] = field.endsWith('Digest') ? digest(`other:${field}`) : `other-${field}`;
  invalid(() => validator.semanticDecisionAdviceForRequestV1(seal(advice, 'adviceDigest'), request));
});

test('every original binding dimension remains distinct from eligibleSetDigest', () => {
  for (const key of Object.keys(contracts().request.binding)) {
    const { request, advice } = contracts();
    advice.binding[key] = key === 'revision' ? 2 : key.endsWith('Digest') ? digest(key) : `other-${key}`;
    invalid(() => validator.semanticDecisionAdviceForRequestV1(seal(advice, 'adviceDigest'), request));
  }
  assert.notEqual(contracts().request.binding.candidateDigest, contracts().request.eligibleSetDigest);
});

for (const [label, edit] of [
  ['duplicate candidate key', r => { r.eligibleSet[1].candidateKey = r.eligibleSet[0].candidateKey; }],
  ['duplicate rank', r => { r.eligibleSet[1].baselineRank = 0; }],
  ['non-contiguous rank', r => { r.eligibleSet[1].baselineRank = 3; }],
  ['preference group inversion', r => { r.eligibleSet[0].preferenceGroup = 2; }],
  ['missing candidate', r => { r.options[0].candidateKeys.pop(); }],
  ['foreign candidate', r => { r.options[0].candidateKeys[0] = 'foreign-candidate'; }],
  ['different model', r => { r.options[0].model = 'wrong-model'; }],
  ['duplicate option ID', r => { r.options[1].optionId = r.options[0].optionId; }],
  ['duplicate model option', r => { r.options[1].model = r.options[0].model; }],
  ['different task source', r => { r.state.sources[0].id = 'other-task'; }],
]) test(`reject self-consistent but invalid prepared request: ${label}`, () => {
  const { request } = contracts(); edit(request);
  invalid(() => validator.semanticDecisionRequestV1(resealRequest(request)));
});

test('nested fields cannot smuggle authority or native control into state, provider or options', () => {
  for (const mutate of [r => { r.provider.admission = true; }, r => { r.state.approval = true; },
    r => { r.options[0].nativeReasoning = { kind: 'enum', value: 'high' }; },
    r => { r.eligibleSet[0].trustedGateSatisfied = true; }]) {
    const { request } = contracts(); mutate(request);
    invalid(() => validator.semanticDecisionRequestV1(resealRequest(request)));
  }
});

test('all content digests and optional summary digest detect tampering after resealing', () => {
  for (const key of ['stateDigest', 'questionDigest', 'eligibleSetDigest', 'optionMappingDigest']) {
    const { request } = contracts(); request[key] = digest('tampered');
    invalid(() => validator.semanticDecisionRequestV1(seal(request, 'requestDigest')));
  }
  const { request } = contracts(); request.state.summaryDigest = digest(request.state.text);
  validator.semanticDecisionRequestV1(resealRequest(request));
  request.state.summaryDigest = digest('different summary');
  invalid(() => validator.semanticDecisionRequestV1(resealRequest(request)));
});

test('seals reject modifications while format validation rejects noncanonical digests', () => {
  for (const [method, key, field] of [['semanticDecisionRequestV1', 'request', 'requestDigest'],
    ['semanticDecisionAdviceV1', 'advice', 'adviceDigest'], ['modelRoutingDecisionV3', 'decision', 'decisionDigest'],
    ['modelApplicationRecordV3', 'record', 'recordDigest']]) {
    const value = contracts()[key]; value[field] = digest('other'); invalid(() => validator[method](value));
    value[field] = 'A'.repeat(64); invalid(() => validator[method](value));
  }
});

test('timestamps enforce ordering and canonical UTC without consulting the current clock', () => {
  for (const expiresAt of ['2026-09-21T12:00:00.000Z', '2026-09-21T11:59:00.000Z', '2026-09-21T12:04:00Z', '2026-02-30T12:04:00.000Z']) {
    const { request } = contracts(); request.expiresAt = expiresAt;
    invalid(() => validator.semanticDecisionRequestV1(seal(request, 'requestDigest')));
  }
  const { request, advice } = contracts();
  advice.evaluatedAt = '2026-09-21T11:59:00.000Z';
  invalid(() => validator.semanticDecisionAdviceForRequestV1(seal(advice, 'adviceDigest'), request));
  advice.evaluatedAt = advice.expiresAt;
  invalid(() => validator.semanticDecisionAdviceV1(seal(advice, 'adviceDigest')));
  // Historical, now-expired bytes remain valid for future historical replay.
  validator.semanticDecisionAdviceForRequestV1(contracts().advice, contracts().request);
});

test('v3 decision/application/record bind the same advice without granting authority', () => {
  const { request, advice, decision, application, record } = contracts();
  validator.modelRoutingDecisionForAdviceV3(decision, advice, request);
  validator.modelApplicationRequestForDecisionV3(application, decision);
  validator.modelApplicationRecordForDecisionV3(record, decision);
  assert.equal(decision.executionAuthorized, false); assert.equal(decision.trustedGateSatisfied, false);
  assert.equal(record.trustedGateSatisfied, false); assert.equal(record.observationAdmitted, false);
});

test('v3 cannot use shadow, blocked/null selection or execution authority', () => {
  const { request, advice, decision } = contracts('shadow');
  invalid(() => validator.modelRoutingDecisionForAdviceV3(decision, advice, request));
  for (const patch of [{ selected: null }, { target: null }, { status: 'blocked' }, { executionAuthorized: true },
    { trustedGateSatisfied: true }, { fallbackReason: 'fallback' }, { capabilitySnapshotDigest: null },
    { semantic: { ...decision.semantic, mode: 'off' } }]) {
    invalid(() => validator.modelRoutingDecisionV3(seal({ ...decision, ...patch }, 'decisionDigest')));
  }
});

test('v3 cannot bind a different choice, request, semantic version or provider artifact', () => {
  const { request, advice, decision } = contracts();
  const edits = [d => { d.selected.model = 'fixture-other-model'; }, d => { d.requestDigest = digest('other'); },
    d => { d.semantic.adviceDigest = digest('other'); }, d => { d.semantic.selectedOptionId = 'option-b'; },
    d => { d.semantic.reducerVersion = 'other-version'; }];
  for (const edit of edits) { const d = structuredClone(decision); edit(d); invalid(() => validator.modelRoutingDecisionForAdviceV3(seal(d, 'decisionDigest'), advice, request)); }
});

test('v3 application detects foreign binding, advice, target and dispatched control', () => {
  const { application, decision } = contracts();
  for (const edit of [a => { a.binding.attemptId = 'different-attempt'; }, a => { a.target.instanceId = 'different-instance'; },
    a => { a.semanticAdviceDigest = digest('other'); }, a => { a.decisionDigest = digest('other'); },
    a => { a.dispatched.runtimeMode = 'other-mode'; }]) {
    const a = structuredClone(application); edit(a); invalid(() => validator.modelApplicationRequestForDecisionV3(a, decision));
  }
});

test('v3 record rejects a resealed foreign advice or actual observation reference', () => {
  const { record, decision } = contracts(); record.semantic.adviceDigest = digest('foreign');
  invalid(() => validator.modelApplicationRecordForDecisionV3(seal(record, 'recordDigest'), decision));
  invalid(() => validator.modelApplicationRecordV3(seal({ ...record, trustedGateSatisfied: true }, 'recordDigest')));
});
