import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { scoreCase, aggregate, oracleDigest, sameSet } from './evaluation.js';
import { loadSkillInventory } from '../../mcp-server/src/skill-classification/inventory.js';
import { createClassificationRequest, projectClassificationRequest } from '../../mcp-server/src/skill-classification/request.js';
import { SkillClassificationService, InMemoryClassificationBudget } from '../../mcp-server/src/skill-classification/service.js';
import { RuntimeSkillClassificationGateway, readClassificationRuntime } from '../../mcp-server/src/skill-classification/gateway.js';
import { validateClassificationResponse } from '../../mcp-server/src/skill-classification/validation.js';
import { digestProviderProfileConfiguration } from '../../mcp-server/src/skill-classification/profiles.js';
import { buildVendorMessages, unknownUsage } from '../../mcp-server/src/skill-classification/providers.js';

const corpus = JSON.parse(readFileSync('tests/skill-classification/fixtures.json', 'utf8'));
const fixture = corpus.cases.find((c: any) => c.caseId === 'SS02');
const records: any[] = [];
const hash = (bytes: any) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
let inventory: any;
let request: any;
beforeAll(async () => {
  inventory = await loadSkillInventory({root: process.cwd()});
  request = createClassificationRequest({requestId: 'SS02-base-offline', operationId: 'SS02-base-offline', originalPrompt: fixture.originalPrompt, inventory, classificationCriteriaRef: 'skills/orchestrator/references/skill-classification.md'});
  writeFileSync('./.ss02-evidence/SS02.request.json', JSON.stringify(request, null, 2));
});
afterAll(() => writeFileSync('./.ss02-evidence/SS02.checks.json', JSON.stringify(records, null, 2)));
function record(id: string, input: any, expected: any, observed: any) {
  records.push({caseId: 'SS02', variantId: 'base', checkId: id, executionKind: 'offline-mock', input, expected, observed, isHostEvidence: false});
}
function observation(ids: string[] | null, overrides: any = {}) {
  return {caseId: 'SS02', layer: 'vendorRaw', state: 'PASS', skillIds: ids, selectionStatus: ids === null ? 'NEEDS_INPUT' : 'SELECTED', reasonCodes: [], selectionReasons: [], executionKind: 'offline-mock', host: null, hostReceipt: null, requestDigest: request.requestDigest, inventoryDigest: inventory.inventoryDigest, conditionDigest: hash('SS02-offline'), stageEvidence: {read: false, applied: false, verified: false}, ...overrides};
}
function profile() {
  const p: any = {profileId: 'SS02-synthetic-vendor', providerKind: 'vendor', vendorId: 'SS02-offline-vendor', modelId: 'SS02-mock', modelRevision: 'SS02-mock', reasoningEffort: null, supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: 'mock-only', qualificationRevision: 'synthetic-not-production', qualification: {status: 'PASS', inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: 'SS02-mock', promptRevision: 'mock', validUntil: '2099-01-01T00:00:00Z', profileConfigurationDigest: ''}, adapterRevision: 'mock', promptRevision: 'mock', maximumInputBytes: 1048576, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: null};
  p.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(p); return p;
}
function evaluation(req = request) {
  return {response: {schemaVersion: '1.0.0', requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest, status: 'SUCCESS', judgments: req.skills.map((s: any) => ({skillId: s.skillId, judgment: s.skillId === 'ponytail' ? 'needed' : 'not-needed', reasonRefs: ['SS02-synthetic-oracle-control'], uncertaintyReason: null})), unresolvedItems: [], error: null}, usage: {...unknownUsage(), actualCostUsd: 0.125}, dispatchState: 'started', diagnostics: null} as any;
}
function harness(transform = (e: any) => e) {
  const counters = {mockAvailability: 0, mockClassify: 0, externalApi: 0};
  const provider: any = {availability: async () => {counters.mockAvailability++; return {available: true, approved: true, routeKind: 'remote', reasonCode: null};}, classify: async (req: any) => {counters.mockClassify++; return transform(evaluation(req));}};
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {'SS02-offline-vendor': {limitUsd: 1, spentUsd: 0}}});
  const service = new SkillClassificationService({providers: {vendor: provider}, budget});
  const runtime: any = {config: {jevEnabled: false, mode: 'select', providerProfileRegistryRef: 'synthetic', externalClassificationAllowed: true, configRevision: 'SS02-mock', timeoutMs: 3000}, registry: {schemaVersion: '1.0.0', profileRevision: 'SS02-mock', profiles: [profile()]}, allowRemotePrivateContent: true};
  return {counters, budget, service, runtime, input: {request, config: runtime.config, registry: runtime.registry, currentVendorId: 'SS02-offline-vendor'}};
}
const intake = () => ({schemaVersion: '1.0.0', requestId: request.requestId, operationId: request.operationId, originalPrompt: fixture.originalPrompt, confirmedContext: request.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: 'SS02-offline-vendor', reference: 'synthetic-only'}, publicSynthetic: true});

describe('SS02 independent base and derived boundary controls', () => {
  it('SS02 frozen bytes, oracle, embedded fields, only base variant', () => {
    const actual = {fixtureSha: hash(readFileSync('tests/skill-classification/fixtures.json')), oracleSha: oracleDigest(corpus), variants: fixture.variants, fields: Object.keys(fixture.sourceSpec.fields), specPresent: existsSync(fixture.sourceSpec.path)};
    record('frozen-binding', {caseId: 'SS02'}, {fixtureSha: 'sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9', oracleSha: 'sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055', variants: ['base'], specPresent: false}, actual);
    expect(actual.fixtureSha).toBe('sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
    expect(actual.oracleSha).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
    expect(actual.variants).toEqual(['base']); expect(actual.fields).toHaveLength(8); expect(actual.specPresent).toBe(false);
  });
  it('SS02 all eight source references bind actual bytes', () => {
    const refs = fixture.oracle.sourceRefs.map((ref: any) => ({...ref, observedDigest: hash(readFileSync(ref.path))}));
    record('source-bindings', fixture.oracle.sourceRefs, 'all source byte digests equal frozen references', refs);
    expect(refs).toHaveLength(8); for (const ref of refs) expect(ref.observedDigest).toBe(ref.digest);
  });
  it('SS02 exact prompt, negation, unknown null and all inventory reach wire without oracle', () => {
    const projected = projectClassificationRequest(request);
    const wire = JSON.parse(buildVendorMessages(request)[1]!.content);
    const observed = {prompt: wire.originalPrompt, context: wire.confirmedContext, skillIds: wire.skills.map((s: any) => s.skillId).sort(), payloadBytes: projected.payloadBytes, oraclePresent: Object.hasOwn(wire, 'oracle'), probabilityPresent: Object.hasOwn(wire, 'probability')};
    record('request-wire', {originalPrompt: fixture.originalPrompt}, {prompt: fixture.originalPrompt, allSkills: corpus.inventorySkillIds, contextFields: 'null', oraclePresent: false, probabilityPresent: false}, observed);
    expect(inventory.issues).toEqual([]); expect(observed.prompt).toBe(fixture.originalPrompt); expect(observed.skillIds).toEqual([...corpus.inventorySkillIds].sort()); expect(Object.values(wire.confirmedContext).every(x => x === null)).toBe(true); expect(observed.oraclePresent).toBe(false); expect(observed.probabilityPresent).toBe(false);
  });
  it('SS02 exact R mock is raw evaluator PASS, selected without receipt is FAIL', () => {
    const raw = scoreCase(fixture, observation(['ponytail']) as any, corpus.inventorySkillIds);
    const selected = scoreCase(fixture, observation(['ponytail'], {layer: 'selected'}) as any, corpus.inventorySkillIds);
    record('advice-versus-selection', {skillIds: ['ponytail'], hostReceipt: null}, {raw: 'PASS', selected: 'FAIL'}, {raw, selected});
    expect(raw.verdict).toBe('PASS'); expect(selected.verdict).toBe('FAIL'); expect(selected.reasons).toContain('HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH');
  });
  it.each(fixture.oracle.forbidden)('SS02 rejects forbidden extra %s', (id: string) => {
    const observed = scoreCase(fixture, observation(['ponytail', id]) as any, corpus.inventorySkillIds);
    record('forbidden-' + id, {skillIds: ['ponytail', id]}, {verdict: 'FAIL', forbidden: [id]}, observed);
    expect(observed.verdict).toBe('FAIL'); expect(observed.forbidden).toEqual([id]);
  });
  it('SS02 missing target does not turn null or empty selection into success', () => {
    const nullScore = scoreCase(fixture, observation(null) as any, corpus.inventorySkillIds);
    const emptyScore = scoreCase(fixture, observation([]) as any, corpus.inventorySkillIds);
    record('null-versus-empty', {missingCodeTarget: true, values: [null, []]}, {equal: false, null: 'FAIL', empty: 'FAIL'}, {equal: sameSet(null, []), nullScore, emptyScore});
    expect(sameSet(null, [])).toBe(false); expect(nullScore.verdict).toBe('FAIL'); expect(nullScore.abstained).toBe(true); expect(emptyScore.verdict).toBe('FAIL'); expect(emptyScore.abstained).toBe(false); expect(emptyScore.missingRequired).toEqual(['ponytail']);
  });
  it('SS02 unknown alias and unadjudicated extra keep their distinct status', () => {
    const alias = scoreCase(fixture, observation(['P']) as any, corpus.inventorySkillIds);
    const extra = scoreCase(fixture, observation(['ponytail', 'session-board']) as any, corpus.inventorySkillIds);
    record('alias-and-unadjudicated', {alias: ['P'], extra: ['ponytail', 'session-board']}, {alias: 'FAIL', extra: 'REVIEW_REQUIRED'}, {alias, extra});
    expect(alias.reasons).toContain('UNKNOWN_CANONICAL_ID'); expect(extra.verdict).toBe('REVIEW_REQUIRED');
  });
  it('SS02 declared stage flags without selection evidence earn zero stage coverage', () => {
    const row = observation(['ponytail'], {layer: 'selected', stageEvidence: {read: true, applied: true, verified: true}});
    const scored = aggregate([fixture], [row] as any, 'selected', corpus.inventorySkillIds);
    record('unproven-stage-flags', row, {stageCoverage: {read: 0, applied: 0, verified: 0}, verdict: 'INCOMPLETE_OR_FAIL'}, scored);
    expect(scored.stageCoverage).toEqual({read: 0, applied: 0, verified: 0}); expect(scored.verdict).toBe('INCOMPLETE_OR_FAIL');
  });
  it('SS02 rejects incomplete and duplicated candidate judgments', () => {
    const base = evaluation().response;
    const missing = validateClassificationResponse(request, {...base, judgments: base.judgments.filter((j: any) => j.skillId !== 'ponytail')});
    const duplicate = validateClassificationResponse(request, {...base, judgments: [...base.judgments, base.judgments[0]]});
    record('response-completeness', {missingId: 'ponytail', duplicateId: base.judgments[0].skillId}, {missing: 'MISSING_CANDIDATE_JUDGMENT', duplicate: 'DUPLICATE_SKILL_ID'}, {missing, duplicate});
    expect(missing).toContain('MISSING_CANDIDATE_JUDGMENT'); expect(duplicate).toContain('DUPLICATE_SKILL_ID');
  });
  it('SS02 service transports synthetic advice once, and creates no AGENT selection', async () => {
    const h = harness(); const result = await h.service.classify(h.input);
    record('service-base', {originalPrompt: fixture.originalPrompt, providerResponse: 'synthetic R only, all candidates adjudicated'}, {responseStatus: 'SUCCESS', mockClassify: 1, externalApi: 0, selectionProperty: false}, {result, counters: h.counters, selectionProperty: Object.hasOwn(result, 'agentSelectedSkillIds')});
    expect(result.response.status).toBe('SUCCESS'); expect(h.counters.mockClassify).toBe(1); expect(h.counters.externalApi).toBe(0); expect(result).not.toHaveProperty('agentSelectedSkillIds');
  });
  it('SS02 gateway retains null selection and refuses missing host observation', async () => {
    const h = harness(); const gateway = new RuntimeSkillClassificationGateway({root: process.cwd(), service: h.service, readRuntime: async () => h.runtime});
    const result: any = await gateway.classify(intake());
    const accepted = await gateway.accept({schemaVersion: '1.0.0', operationId: request.operationId, decision: {schemaVersion: '1.0.0', classificationResponseRef: result.classificationResponseRef, requestDigest: result.result.request.requestDigest, inventoryDigest: result.result.request.inventoryDigest, taskRevision: null, configRevision: h.runtime.config.configRevision, profileRevision: h.runtime.registry.profileRevision, explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: ['ponytail'], selectionReasons: [{skillId: 'ponytail', reason: 'synthetic intent'}], applicabilityChecks: [{skillId: 'ponytail', applies: true, excluded: false, reasonRefs: ['synthetic-only']}], unresolvedSkillReferences: [], selectionStatus: 'SELECTED', adviceApplied: false, hostReceipt: null}}, null);
    record('gateway-no-host', {originalPrompt: fixture.originalPrompt, observation: null, hostReceipt: null}, {selected: null, status: 'PROPOSED', acceptValid: false}, {result, accepted, counters: h.counters});
    expect(result.agentSelectedSkillIds).toBeNull(); expect(result.selectionStatus).toBe('PROPOSED'); expect(accepted).toMatchObject({valid: false, errors: ['HOST_SELECTION_NOT_OBSERVED'], agentSelectedSkillIds: null});
  });
  it('SS02 current unconfigured runtime is unavailable, provider/host calls zero', async () => {
    const runtime = await readClassificationRuntime(undefined, process.cwd());
    const service = new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})});
    const result = await service.classify({request, config: runtime.config, registry: runtime.registry, currentVendorId: 'openai'});
    record('unconfigured-runtime', {classificationConfigPresent: Boolean(process.env.AGENT_GOVERNANCE_CLASSIFICATION_CONFIG)}, {code: 'PROFILE_UNAVAILABLE', attempts: []}, result);
    expect(result.response.error?.code).toBe('PROFILE_UNAVAILABLE'); expect(result.attempts).toEqual([]);
  });
  it('SS02 known cost must survive invalid response [existing defect]', async () => {
    const h = harness(e => ({...e, response: {...e.response, judgments: e.response.judgments.filter((j: any) => j.skillId !== 'ponytail')}}));
    const result = await h.service.classify(h.input);
    record('known-cost-invalid-response', {prompt: fixture.originalPrompt, usage: {actualCostUsd: 0.125}, missingJudgment: 'ponytail'}, {code: 'INVALID_PROVIDER_RESPONSE', recordedCost: 0.125, spentUsd: 0.125}, {result, budget: h.budget.snapshot(), counters: h.counters});
    expect(result.response.error?.code).toBe('INVALID_PROVIDER_RESPONSE'); expect(result.attempts[0]?.usage.actualCostUsd).toBe(0.125); expect(h.budget.snapshot().limits['vendor:SS02-offline-vendor']?.spentUsd).toBe(0.125);
  });
  it('SS02 gateway must use observed empty host membership [existing supply gap]', async () => {
    const h = harness(); const gateway = new RuntimeSkillClassificationGateway({root: process.cwd(), service: h.service, readRuntime: async () => h.runtime});
    const defaultInventory: any = await gateway.inventory();
    const explicitInventory = await loadSkillInventory({root: process.cwd(), installedSkillIds: [], hostSupportedSkillIds: []});
    const gatewayP = defaultInventory.skills.find((s: any) => s.skillId === 'ponytail');
    const observedP = explicitInventory.skills.find((s: any) => s.skillId === 'ponytail');
    record('host-membership-supply-gap', {installedSkillIds: [], hostSupportedSkillIds: [], source: 'synthetic observed empty host'}, {gatewayP: {installed: false, hostSupported: false}}, {gatewayP, explicitInventoryP: observedP, gatewayOptionHasHostMembershipInput: false});
    expect(observedP).toMatchObject({installed: false, hostSupported: false}); expect(gatewayP).toMatchObject({installed: false, hostSupported: false});
  });
});
