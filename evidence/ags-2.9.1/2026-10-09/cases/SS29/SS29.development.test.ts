import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {createClassificationRequest} from '../mcp-server/src/skill-classification/request.js';
import {jevNoulWireAdapter, unknownUsage} from '../mcp-server/src/skill-classification/providers.js';
import {InMemoryClassificationBudget, SkillClassificationService} from '../mcp-server/src/skill-classification/service.js';
import {digestProviderProfileConfiguration, validateProviderProfile} from '../mcp-server/src/skill-classification/profiles.js';
import {validateClassificationResponse} from '../mcp-server/src/skill-classification/validation.js';
import {loadSkillInventory} from '../mcp-server/src/skill-classification/inventory.js';
import {RuntimeSkillClassificationGateway} from '../mcp-server/src/skill-classification/gateway.js';
import {oracleDigest, scoreCase} from './skill-classification/evaluation.js';
import type {ProviderProfile, ProviderEvaluation, SkillMetadata} from '../mcp-server/src/skill-classification/types.js';

const output = process.env.SS29_OUTPUT_DIRECTORY ?? 'SS29-output';
const bytes = readFileSync('tests/skill-classification/fixtures.json');
const corpus = JSON.parse(bytes.toString());
const source = corpus.cases.find((c: {caseId: string}) => c.caseId === 'SS29');
// SS29.originalPrompt is null. Use the embedded INPUT verbatim as explicitly
// derived mechanical input; never present it as an original user host request.
const originalPrompt = source.sourceSpec.fields['입력'];
function record(name: string, data: unknown) {
  writeFileSync(`${output}/${name}.observation.json`, JSON.stringify(data, null, 2) + '\n');
}
const metadata = (id: string): SkillMetadata => ({skillId: id, version: 'synthetic-1', description: 'synthetic review', enabled: true, installed: true, hostSupported: true,
  capabilities: ['review'], actions: ['review'], targets: ['diff'], constraints: [], applicability: ['fixed diff'], exclusions: ['implementation'], dependencies: [], phases: [], sourceRefs: []});
function fixture(kind: 'jev' | 'vendor' = 'jev', ids = ['review']) {
  const request = createClassificationRequest({requestId: 'SS29-mock-request', operationId: 'SS29-mock-operation', originalPrompt,
    inventory: {skills: ids.map(metadata), inventoryDigest: `sha256:${'a'.repeat(64)}`, taxonomyRevision: 'SS29-synthetic-taxonomy', issues: []}, classificationCriteriaRef: 'SS29:embedded-spec'});
  const profile: ProviderProfile = {profileId: `SS29-mock-${kind}`, providerKind: kind, vendorId: kind === 'jev' ? 'typesafe' : 'SS29-mock-vendor', modelId: 'SS29-mock-model', modelRevision: 'SS29-mock-model', reasoningEffort: kind === 'jev' ? null : 'low',
    supportedOptions: {reasoningEfforts: kind === 'jev' ? [null] : ['low'], structuredOutput: true}, approvedRouteRef: 'SS29-synthetic-route', qualificationRevision: 'SS29-synthetic-q1',
    qualification: {status: 'PASS', inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: 'SS29-mock-model', promptRevision: 'SS29-mock-p1', validUntil: '2099-01-01T00:00:00Z', profileConfigurationDigest: ''},
    adapterRevision: 'SS29-mock-a1', promptRevision: 'SS29-mock-p1', maximumInputBytes: 1000000, maximumOutputTokens: 1000, maximumCostUsd: 0, judgmentPolicy: kind === 'jev' ? {neededAt: .8, notNeededAt: .2} : null};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const config = {jevEnabled: kind === 'jev', mode: 'shadow' as const, providerProfileRegistryRef: 'SS29-mock-registry', externalClassificationAllowed: false, configRevision: 'SS29-mock-c1', timeoutMs: 1000};
  const registry = {schemaVersion: '1.0.0' as const, profileRevision: 'SS29-mock-pr1', profiles: [profile]};
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 0, spentUsd: 0}, vendors: {'SS29-mock-vendor': {limitUsd: 0, spentUsd: 0}}, nativeAllowances: {[profile.profileId]: {approvalRef: 'SS29-synthetic-allowance', remainingCalls: 2}}});
  return {request, profile, config, registry, budget};
}
function noul(f: ReturnType<typeof fixture>, value: number): ProviderEvaluation {
  return jevNoulWireAdapter.decode({model: f.profile.modelRevision, answers: Object.fromEntries(f.request.skills.map(s => [s.skillId, {type: 'noul', noul: value}])), usage: {}}, f.request, f.profile);
}
function vendorEvaluation(f: ReturnType<typeof fixture>, scoreKind: string | null, value: number | null): ProviderEvaluation {
  return {response: {schemaVersion: '1.0.0', requestId: f.request.requestId, operationId: f.request.operationId, requestDigest: f.request.requestDigest, inventoryDigest: f.request.inventoryDigest,
    status: 'SUCCESS', judgments: f.request.skills.map(s => ({skillId: s.skillId, judgment: 'needed', reasonRefs: ['SS29:synthetic-purpose'], uncertaintyReason: null})), unresolvedItems: [], error: null},
    usage: {...unknownUsage(), actualCostUsd: 0}, dispatchState: 'started', diagnostics: scoreKind === null ? null : {scoreKind, scores: f.request.skills.map(s => ({skillId: s.skillId, value: value!}))}};
}
function service(f: ReturnType<typeof fixture>, evaluation: ProviderEvaluation) {
  const provider = {availability: vi.fn(async () => ({available: true, approved: true, routeKind: 'native' as const, reasonCode: null})), classify: vi.fn(async () => evaluation)};
  return {provider, service: new SkillClassificationService({providers: {[f.profile.providerKind]: provider}, budget: f.budget, now: () => Date.parse('2026-10-09T00:00:00Z')})};
}
const noClaim = {selected: 'NOTRUN', read: 'NOTRUN', applied: 'NOTRUN', verified: 'NOTRUN', agentSelectedSkillIds: null, hostReceipt: null};
describe('SS29 frozen operational score contract only', () => {
  it('SS29 binding and null semantic oracle are preserved', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
    expect(oracleDigest(corpus)).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
    expect(source.variants).toEqual(['cosine', 'logit', 'noul', 'score-absent', 'threshold-uncertain']);
    expect(source.originalPrompt).toBeNull(); expect(source.oracle).toBeNull();
    expect(() => scoreCase(source, undefined, corpus.inventorySkillIds)).toThrow('NO_SEMANTIC_ORACLE:SS29');
  });
  it.each([
    ['cosine', 'vendor', 'cosine_similarity', .82],
    ['logit', 'vendor', 'classifier_score', 2.4],
    ['noul', 'jev', 'noul_probability', .82],
    ['score-absent', 'vendor', null, null],
    ['threshold-uncertain', 'jev', 'noul_probability', .5],
  ] as const)('SS29 variant %s preserves score meaning through serialized service output', async (variant, kind, scoreKind, value) => {
    const f = fixture(kind);
    const evaluation = kind === 'jev' ? noul(f, value!) : vendorEvaluation(f, scoreKind, value);
    const s = service(f, evaluation);
    const result = await s.service.classify({request: f.request, config: f.config, registry: f.registry, currentVendorId: f.profile.vendorId});
    // Exclude echoed REQ: seeing the input prompt in REQ does not communicate
    // the actual provider result or its uncertainty to the agent.
    const outward = {response: result.response, attempts: result.attempts, profileRevision: result.profileRevision, snapshot: result.snapshot};
    record(variant, {caseId: 'SS29', variant, input: {originalPrompt: null, derivedMechanicalPrompt: originalPrompt, providerKind: kind, scoreKind, value, semantics: variant === 'logit' ? 'raw logit; no calibration evidence' : variant === 'cosine' ? 'cosine similarity; no calibration evidence' : 'raw yes probability or absent score', policy: f.profile.judgmentPolicy},
      expected: {scoreKind, value, probabilityRebranding: false, finalSelectionObserved: false}, providerEvaluation: evaluation, serviceOutput: result,
      observed: {diagnosticsPresentInServiceOutput: Object.hasOwn(result, 'diagnostics'), finalSelection: noClaim}, apiCalls: 0, ...noClaim});
    expect(s.provider.classify).toHaveBeenCalledTimes(1);
    expect(validateClassificationResponse(f.request, result.response)).toEqual([]);
    expect(result.response.status).toBe(variant === 'threshold-uncertain' ? 'UNCERTAIN' : 'SUCCESS');
    expect(JSON.stringify(outward)).not.toMatch(/confidence|success_probability|safety_probability|82%/u);
    expect(result).not.toHaveProperty('agentSelectedSkillIds');
    if (scoreKind !== null) {
      // Contract assertion is shape-independent: the serialized result must
      // retain the provider's score kind, not an invented output field name.
      expect(JSON.stringify(outward), 'SS29_SCORE_KIND_LOST_AT_PUBLIC_SERVICE_BOUNDARY').toContain(scoreKind);
      expect(JSON.stringify(outward)).toContain(String(value));
    } else {
      expect(evaluation.diagnostics).toBeNull();
      expect(JSON.stringify(outward)).not.toMatch(/scoreKind|"score"/u);
    }
  });
  it.each([[0,'not-needed'], [.2,'not-needed'], [.20000000000000004,'uncertain'], [.5,'uncertain'], [.7999999999999999,'uncertain'], [.8,'needed'], [1,'needed']] as const)('SS29 Noul threshold boundary %s stays %s without fabricated confidence', (value, judgment) => {
    const f = fixture(); const result = noul(f, value);
    record(`threshold-${value}`, {value, expectedJudgment: judgment, observed: result, apiCalls: 0, ...noClaim});
    expect(result.response.judgments[0].judgment).toBe(judgment);
    expect(result.diagnostics).toEqual({scoreKind: 'noul_probability', scores: [{skillId: 'review', value}]});
    expect(JSON.stringify(result)).not.toContain('confidence');
  });
  it('SS29 all candidates below positive threshold remain unresolved and never select no-skill', async () => {
    const f = fixture('jev', ['review', 'tests', 'audit']); const evaluation = noul(f, .5); const s = service(f, evaluation);
    const result = await s.service.classify({request: f.request, config: f.config, registry: f.registry, currentVendorId: f.profile.vendorId});
    record('all-threshold-uncertain', {input: {scores: [.5,.5,.5], policy: f.profile.judgmentPolicy}, result, baselineFallback: 'NOTRUN: AGENT baseline is not invoked by this offline service test', apiCalls: 0, ...noClaim});
    expect(result.response.status).toBe('UNCERTAIN'); expect(result.response.judgments.every(j => j.judgment === 'uncertain')).toBe(true);
    expect(result.response.unresolvedItems).toHaveLength(3); expect(validateClassificationResponse(f.request, result.response)).toEqual([]);
    expect(result).not.toHaveProperty('agentSelectedSkillIds');
  });
  it('SS29 policy change is digest-bound and stale qualification is refused', () => {
    const f = fixture(); const before = digestProviderProfileConfiguration(f.profile);
    f.profile.judgmentPolicy = {neededAt: .9, notNeededAt: .1};
    record('policy-binding', {originalDigest: before, changedDigest: digestProviderProfileConfiguration(f.profile), validation: validateProviderProfile(f.profile, f.request, Date.parse('2026-10-09T00:00:00Z')), apiCalls: 0});
    expect(digestProviderProfileConfiguration(f.profile)).not.toBe(before);
    expect(validateProviderProfile(f.profile, f.request, Date.parse('2026-10-09T00:00:00Z'))).toBe('QUALIFICATION_CONFIGURATION_MISMATCH');
  });
  it('SS29 RESP refuses invented confidence field', () => {
    const f = fixture(); const resp = {...noul(f,.82).response, confidence: .82};
    expect(validateClassificationResponse(f.request, resp)).toEqual(['INVALID_RESPONSE_SCHEMA']);
  });
  it('SS29 gateway with complete real inventory must preserve actual Noul score meaning', async () => {
    const inventory = await loadSkillInventory({root: process.cwd()}); expect(inventory.issues).toEqual([]);
    const f = fixture(); f.request = createClassificationRequest({requestId: 'SS29-gateway', operationId: 'SS29-gateway', originalPrompt, inventory, classificationCriteriaRef: 'skills/orchestrator/references/skill-classification.md'});
    f.profile.qualification.inventoryDigest = inventory.inventoryDigest; f.profile.qualification.taxonomyRevision = inventory.taxonomyRevision;
    f.profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(f.profile);
    const evaluation = noul(f,.82); const s = service(f, evaluation);
    const gateway = new RuntimeSkillClassificationGateway({root: process.cwd(), service: s.service, readRuntime: async () => ({config: f.config, registry: f.registry, allowRemotePrivateContent: false})});
    const result = await gateway.classify({schemaVersion: '1.0.0', requestId: f.request.requestId, operationId: f.request.operationId, originalPrompt,
      confirmedContext: f.request.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: 'typesafe', reference: 'SS29:mock-only'}, publicSynthetic: true});
    record('gateway', {inventorySkillIds: inventory.skills.map(s => s.skillId), providerEvaluation: evaluation, gatewayOutput: result, apiCalls: 0, ...noClaim});
    expect(result.agentSelectedSkillIds).toBeNull(); expect(result.selectionStatus).toBe('PROPOSED'); expect(result.adviceApplied).toBe(false);
    const outward = {...result, result: {...result.result, request: undefined}};
    expect(JSON.stringify(outward), 'SS29_SCORE_KIND_LOST_AT_GATEWAY_BOUNDARY').toContain('noul_probability');
  });
});
