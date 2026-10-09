// PUBLIC REPRODUCTION ADAPTATION. Existing assertions/fixtures retained; NOT EXECUTED during publication.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.env.SS13_PRODUCT_ROOT!);
const outputRoot = resolve(process.env.SS13_OUTPUT_ROOT!);
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const { loadSkillInventory } = await import(pathToFileURL(resolve(root, 'mcp-server/src/skill-classification/inventory.ts')).href);
const { createClassificationRequest, digestClassificationValue, projectClassificationRequest } = await import(pathToFileURL(resolve(root, 'mcp-server/src/skill-classification/request.ts')).href);
const { digestProviderProfileConfiguration } = await import(pathToFileURL(resolve(root, 'mcp-server/src/skill-classification/profiles.ts')).href);
const { SkillClassificationService, InMemoryClassificationBudget } = await import(pathToFileURL(resolve(root, 'mcp-server/src/skill-classification/service.ts')).href);
const { RuntimeSkillClassificationGateway, readClassificationRuntime } = await import(pathToFileURL(resolve(root, 'mcp-server/src/skill-classification/gateway.ts')).href);
const { validateClassificationResponse, validateDecision } = await import(pathToFileURL(resolve(root, 'mcp-server/src/skill-classification/validation.ts')).href);
const { buildVendorMessages, classificationState, jevNoulWireAdapter, unknownUsage, unavailableResponse, ClassificationProviderError } = await import(pathToFileURL(resolve(root, 'mcp-server/src/skill-classification/providers.ts')).href);
const { oracleDigest, scoreCase, sameSet } = await import(pathToFileURL(resolve(root, 'tests/skill-classification/evaluation.ts')).href);
type ProviderProfile = any;
type SkillClassificationResponseV1 = any;
type SkillSelectionDecisionV1 = any;
type ProviderEvaluation = any;

const corpus = JSON.parse(readFileSync(`${root}/tests/skill-classification/fixtures.json`, 'utf8'));
const fixture = corpus.cases.find((c: any) => c.caseId === 'SS13');
const inventory = await loadSkillInventory({ root });
const request = createClassificationRequest({ requestId: 'SS13-offline', operationId: 'SS13-base', originalPrompt: fixture.originalPrompt, inventory, classificationCriteriaRef: 'skills/orchestrator/references/skill-classification.md' });
const observations: any[] = [];
const capture = (id: string, input: unknown, expected: unknown, observed: unknown) => observations.push({ caseId: 'SS13', fixtureVariant: 'base', boundaryId: id, executionKind: 'offline-mock', input, expected, observed, actualApiCalls: 0, hostReceipt: null });
afterAll(() => writeFileSync(resolve(outputRoot, 'SS13.observations.json'), JSON.stringify({ request, inventory, fixture, observations, apiCalls: { jev: 0, vendor: 0, claude: 0 }, realAgentStages: { selected: 'NOTRUN', read: 'NOTRUN', applied: 'NOTRUN', verified: 'NOTRUN' } }, null, 2)));

function profile(kind: 'jev' | 'vendor' = 'vendor'): ProviderProfile {
  const p: ProviderProfile = { profileId: `SS13-mock-${kind}`, providerKind: kind, vendorId: kind === 'jev' ? 'typesafe' : 'offline-vendor', modelId: 'mock-fixed', modelRevision: 'mock-fixed', reasoningEffort: kind === 'jev' ? null : 'low', supportedOptions: { reasoningEfforts: kind === 'jev' ? [null] : ['low'], structuredOutput: true }, approvedRouteRef: 'offline-only', qualificationRevision: 'synthetic-only-not-production', qualification: { status: 'PASS', inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: 'mock-fixed', promptRevision: 'mock-p1', validUntil: '2099-01-01T00:00:00Z', profileConfigurationDigest: '' }, adapterRevision: 'mock-a1', promptRevision: 'mock-p1', maximumInputBytes: 1000000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: kind === 'jev' ? { neededAt: 0.8, notNeededAt: 0.2 } : null };
  p.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(p);
  return p;
}
function response(): SkillClassificationResponseV1 {
  return { schemaVersion: '1.0.0', requestId: request.requestId, operationId: request.operationId, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: 'SUCCESS', judgments: request.skills.map(s => ({ skillId: s.skillId, judgment: 'not-needed', reasonRefs: ['fixture:SS13:recipe-outside-AGS-scope'], uncertaintyReason: null })), unresolvedItems: [], error: null };
}
function harness(r: SkillClassificationResponseV1 = response(), cost = 0.1, failure?: string) {
  const budget = new InMemoryClassificationBudget({ jev: { limitUsd: 5, spentUsd: 0 }, vendors: { 'offline-vendor': { limitUsd: 2, spentUsd: 0 } } });
  const provider = { availability: vi.fn(async () => ({ available: true, approved: true, routeKind: 'remote' as const, reasonCode: null })), classify: vi.fn(async (req: any): Promise<ProviderEvaluation> => {
    if (failure) throw new ClassificationProviderError(failure, 'started');
    return { response: { ...r, requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest }, usage: { ...unknownUsage(), actualCostUsd: cost }, dispatchState: 'started', diagnostics: null };
  }) };
  const jev = { availability: vi.fn(async () => { throw new Error('JEV must not run'); }), classify: vi.fn(async () => { throw new Error('JEV must not run'); }) };
  const runtime = { config: { jevEnabled: false, mode: 'select' as const, providerProfileRegistryRef: 'offline-only', externalClassificationAllowed: true, configRevision: 'offline-c1', timeoutMs: 1000 }, registry: { schemaVersion: '1.0.0' as const, profileRevision: 'offline-pr1', profiles: [profile()] }, allowRemotePrivateContent: false, approvedPublicRequestDigests: [request.requestDigest] };
  const service = new SkillClassificationService({ providers: { vendor: provider, jev }, budget });
  return { service, provider, jev, budget, runtime, input: { request, ...runtime, currentVendorId: 'offline-vendor' } };
}
function observation(ids: string[] | null, layer: 'combined' | 'selected' = 'combined', state: 'PASS' | 'FAIL' = 'PASS'): any {
  return { caseId: 'SS13', layer, state, skillIds: ids, selectionStatus: ids === null ? 'NEEDS_INPUT' : 'SELECTED', reasonCodes: [], selectionReasons: [], executionKind: 'offline-mock', host: null, hostReceipt: null, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, conditionDigest: 'offline-only', stageEvidence: { read: false, applied: false, verified: false } };
}
function decision(result: any, ids: string[] | null): SkillSelectionDecisionV1 {
  const { cancelled, ...binding } = result.snapshot;
  return { schemaVersion: '1.0.0', classificationResponseRef: digestClassificationValue(result.response), ...binding, explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: ids, selectionReasons: [], applicabilityChecks: [], unresolvedSkillReferences: [], selectionStatus: 'SELECTED', adviceApplied: false, hostReceipt: null };
}

describe('SS13 base: full-inventory no-skill support and negative controls; never host-live', () => {
  it('binds the single variant and all cited source bytes to the frozen fixture/oracle', () => {
    const digest = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
    const observed = { fixtureDigest: digest(readFileSync(`${root}/tests/skill-classification/fixtures.json`)), oracleDigest: oracleDigest(corpus), variants: fixture.variants, sourceBindings: fixture.oracle.sourceRefs.map((s: any) => ({ path: s.path, expected: s.digest, actual: digest(readFileSync(`${root}/${s.path}`)) })) };
    capture('frozen-bindings', { fixturePath: 'tests/skill-classification/fixtures.json', sourceSpec: fixture.sourceSpec }, { fixtureDigest: 'sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9', oracleDigest: 'sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055', variants: ['base'] }, observed);
    expect(observed.fixtureDigest).toBe('sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
    expect(observed.oracleDigest).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
    expect(fixture.variants).toEqual(['base']);
    expect(observed.sourceBindings.every((s: any) => s.expected === s.actual)).toBe(true);
  });
  it('preserves original egg exclusion, unknown context, and every inventory candidate in both provider wires', () => {
    const j: any = jevNoulWireAdapter.encode(request, profile('jev'));
    const v = JSON.parse(buildVendorMessages(request)[1]!.content);
    const projected = projectClassificationRequest(request);
    capture('full-inventory-wire', { originalPrompt: fixture.originalPrompt, inventoryDigest: inventory.inventoryDigest }, { ids: corpus.inventorySkillIds, confirmedContext: 'all null', eggExclusion: 'unaltered' }, { inventoryIssues: inventory.issues, jevIds: Object.keys(j.questions), vendorIds: v.skills.map((s: any) => s.skillId), jevState: classificationState(request), vendorPrompt: v.originalPrompt, payloadBytes: projected.payloadBytes });
    expect(inventory.issues).toEqual([]);
    expect(request.skills.map(s => s.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
    expect(Object.keys(j.questions).sort()).toEqual([...corpus.inventorySkillIds].sort());
    expect(v.skills.map((s: any) => s.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
    expect(v.originalPrompt).toBe('달걀을 쓰지 않는 파스타 레시피 하나 알려 줘.');
    expect(j.state.originalPrompt).toBe(fixture.originalPrompt);
    expect(Object.values(request.confirmedContext).every(x => x === null)).toBe(true);
  });
  it('accepts explicit all-negative JEV judgments without choosing a nearest skill', () => {
    const p = profile('jev');
    const body = { model: p.modelRevision, answers: Object.fromEntries(request.skills.map(s => [s.skillId, { type: 'noul', noul: 0.1 }])), usage: { input_tokens: 100, output_tokens: 0 } };
    const decoded = jevNoulWireAdapter.decode(body, request, p);
    capture('all-negative-jev-decode', body, { status: 'SUCCESS', neededSkillIds: [], allCandidatesEvaluated: true }, decoded);
    expect(validateClassificationResponse(request, decoded.response)).toEqual([]);
    expect(decoded.response.status).toBe('SUCCESS');
    expect(decoded.response.judgments).toHaveLength(corpus.inventorySkillIds.length);
    expect(decoded.response.judgments.every(j => j.judgment === 'not-needed')).toBe(true);
    expect(decoded).not.toHaveProperty('agentSelectedSkillIds');
  });
  it('keeps service SUCCESS/all-negative separate from AGENT choice with JEV OFF', async () => {
    const f = harness(); const result = await f.service.classify(f.input);
    capture('service-success-no-skill', request, { status: 'SUCCESS', neededSkillIds: [], selected: 'not created by classifier', jevMockInvocations: 0 }, { result, budget: f.budget.snapshot() });
    expect(result.response.status).toBe('SUCCESS');
    expect(result.response.judgments.every(j => j.judgment === 'not-needed')).toBe(true);
    expect(result).not.toHaveProperty('agentSelectedSkillIds');
    expect(f.jev.availability).not.toHaveBeenCalled(); expect(f.jev.classify).not.toHaveBeenCalled();
    expect(f.provider.classify).toHaveBeenCalledExactlyOnceWith(request, f.runtime.registry.profiles[0], expect.any(AbortSignal));
    expect(f.budget.snapshot().limits['vendor:offline-vendor'].spentUsd).toBe(0.1);
  });
  it.each(['empty', 'missing-last', 'duplicate', 'invented-cooking', 'no-reason', 'wrong-inventory'] as const)('rejects %s response as incomplete or invalid, never valid no-skill', boundary => {
    const r = response();
    if (boundary === 'empty') r.judgments = [];
    if (boundary === 'missing-last') r.judgments.pop();
    if (boundary === 'duplicate') r.judgments.push({ ...r.judgments[0]! });
    if (boundary === 'invented-cooking') r.judgments.push({ skillId: 'cooking', judgment: 'needed', reasonRefs: ['invented'], uncertaintyReason: null });
    if (boundary === 'no-reason') r.judgments[0]!.reasonRefs = [];
    if (boundary === 'wrong-inventory') r.inventoryDigest = `sha256:${'0'.repeat(64)}`;
    const errors = validateClassificationResponse(request, r);
    const expected = { empty: 'MISSING_CANDIDATE_JUDGMENT', 'missing-last': 'MISSING_CANDIDATE_JUDGMENT', duplicate: 'DUPLICATE_SKILL_ID', 'invented-cooking': 'UNKNOWN_SKILL_ID', 'no-reason': 'MISSING_JUDGMENT_REASON', 'wrong-inventory': 'RESPONSE_BINDING_inventoryDigest' }[boundary];
    capture(boundary, r, { error: expected }, { errors });
    expect(errors).toContain(expected);
  });
  it('distinguishes provider failure with [] judgments from SUCCESS and keeps evaluator null distinct', async () => {
    const f = harness(response(), 0.1, 'API_UNAVAILABLE'); const result = await f.service.classify(f.input);
    const emptySupport = scoreCase(fixture, observation([]), corpus.inventorySkillIds);
    const nullSupport = scoreCase(fixture, observation(null), corpus.inventorySkillIds);
    const failedEmpty = scoreCase(fixture, observation([], 'combined', 'FAIL'), corpus.inventorySkillIds);
    capture('failure-versus-empty', { failure: 'API_UNAVAILABLE', successAdviceIds: [], unobservedIds: null }, { failureStatus: 'UNAVAILABLE', emptySupport: 'PASS', nullSupport: 'FAIL', failedEmpty: 'FAIL', nullEqualsEmpty: false }, { result, emptySupport, nullSupport, failedEmpty, nullEqualsEmpty: sameSet(null, []) });
    expect(result.response.status).toBe('UNAVAILABLE'); expect(result.response.error?.code).toBe('API_UNAVAILABLE');
    expect(result.response.judgments).toEqual([]);
    expect(emptySupport.verdict).toBe('PASS'); expect(nullSupport.verdict).toBe('FAIL'); expect(failedEmpty.verdict).toBe('FAIL'); expect(sameSet(null, [])).toBe(false);
  });
  it.each(['ponytail', 'cs-engineering', 'orchestrator', 'cooking'])('rejects forced nearest or invented %s in SS13 oracle controls', id => {
    const result = scoreCase(fixture, observation([id]), corpus.inventorySkillIds);
    capture(`forbidden-selection-${id}`, { skillIds: [id], oracle: fixture.oracle }, { verdict: 'FAIL' }, result);
    expect(result.verdict).toBe('FAIL');
  });
  it('rejects purported selected [] and null without manufacturing a host receipt', async () => {
    const f = harness(); const result = await f.service.classify(f.input);
    const checkedEmpty = validateDecision(result, decision(result, []), result.snapshot);
    const checkedNull = validateDecision(result, decision(result, null), result.snapshot);
    const scored = scoreCase(fixture, observation([], 'selected'), corpus.inventorySkillIds);
    capture('no-receipt-no-selection', { proposedEmpty: [], proposedNull: null, hostReceipt: null }, { emptyError: 'HOST_RECEIPT_MISMATCH', nullError: 'SELECTION_NOT_OBSERVED', selectedScore: 'FAIL' }, { checkedEmpty, checkedNull, scored });
    expect(checkedEmpty.errors).toContain('HOST_RECEIPT_MISMATCH');
    expect(checkedNull.errors).toContain('SELECTION_NOT_OBSERVED'); expect(scored.verdict).toBe('FAIL');
  });
  it('gateway SUCCESS leaves selected null and refuses unattested empty acceptance', async () => {
    const f = harness();
    const gateway = new RuntimeSkillClassificationGateway({ root, service: f.service, readRuntime: async () => f.runtime });
    const input = { schemaVersion: '1.0.0', requestId: request.requestId, operationId: request.operationId, originalPrompt: request.originalPrompt, confirmedContext: request.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: { vendorId: 'offline-vendor', reference: 'offline-only' }, publicSynthetic: true };
    const classified: any = await gateway.classify(input);
    const accepted: any = await gateway.accept({ schemaVersion: '1.0.0', operationId: request.operationId, decision: decision(classified.result, []) }, null);
    capture('gateway-unattested', input, { response: 'SUCCESS', agentSelectedSkillIds: null, acceptanceError: 'HOST_SELECTION_NOT_OBSERVED' }, { classified, accepted });
    expect(classified.result.response.status).toBe('SUCCESS'); expect(classified.agentSelectedSkillIds).toBeNull(); expect(classified.selectionStatus).toBe('PROPOSED');
    expect(accepted).toEqual({ valid: false, errors: ['HOST_SELECTION_NOT_OBSERVED'], agentSelectedSkillIds: null });
  });
  it('unconfigured gateway remains unavailable instead of accepted [] without provider dispatch', async () => {
    const runtime = await readClassificationRuntime(undefined, root); const f = harness();
    const gateway = new RuntimeSkillClassificationGateway({ root, service: f.service, readRuntime: async () => runtime });
    const classified: any = await gateway.classify({ schemaVersion: '1.0.0', requestId: 'SS13-unconfigured', operationId: 'SS13-unconfigured', originalPrompt: request.originalPrompt, confirmedContext: request.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: { vendorId: 'offline-vendor', reference: 'offline-only' }, publicSynthetic: true });
    capture('unconfigured', { config: 'absent', originalPrompt: request.originalPrompt }, { status: 'UNAVAILABLE', agentSelectedSkillIds: null, mockDispatches: 0 }, classified);
    expect(classified.result.response.status).toBe('UNAVAILABLE'); expect(classified.agentSelectedSkillIds).toBeNull(); expect(f.provider.classify).not.toHaveBeenCalled();
  });
  it('KNOWN DEFECT: invalid RESP must preserve independently valid actual cost', async () => {
    const invalid = response(); invalid.judgments = [];
    const f = harness(invalid, 0.1); const result = await f.service.classify(f.input);
    capture('known-defect-valid-cost-lost', { response: invalid, usage: { ...unknownUsage(), actualCostUsd: 0.1 }, dispatchState: 'started' }, { status: 'INVALID', errorCode: 'INVALID_PROVIDER_RESPONSE', attemptCostUsd: 0.1, spentUsd: 0.1, reservations: [] }, { result, budget: f.budget.snapshot() });
    expect(result.response.status).toBe('INVALID'); expect(result.response.error?.code).toBe('INVALID_PROVIDER_RESPONSE');
    expect(result.attempts[0]!.usage.actualCostUsd, 'known valid cost must survive invalid semantic RESP').toBe(0.1);
    expect(f.budget.snapshot().limits['vendor:offline-vendor'].spentUsd).toBe(0.1); expect(f.budget.snapshot().reservations).toEqual([]);
  });
});
