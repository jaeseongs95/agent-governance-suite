import {afterAll, describe, expect, it, vi} from 'vitest';
import {writeFileSync} from 'node:fs';
import {ApprovedRouteClassificationProvider, jevNoulWireAdapter, unknownUsage} from '../../mcp-server/src/skill-classification/providers.js';
import {SkillClassificationService, InMemoryClassificationBudget} from '../../mcp-server/src/skill-classification/service.js';
import {createClassificationRequest} from '../../mcp-server/src/skill-classification/request.js';
import {digestProviderProfileConfiguration} from '../../mcp-server/src/skill-classification/profiles.js';
import {validateClassificationResponse} from '../../mcp-server/src/skill-classification/validation.js';
import type {ProviderProfile, ProviderEvaluation} from '../../mcp-server/src/skill-classification/types.js';

// SS30 only. All profiles, approval refs, credentials, bodies and transport are synthetic.
// No host receipt is generated; observations of AGENT selection/read/applied/verified stay null/NOTRUN.
const observations: any[] = [];
afterAll(() => writeFileSync(new URL('./observations.json', import.meta.url), JSON.stringify(observations, null, 2) + '\n'));
const cases = [
  {id: '401', http: 401, payload: 'SECRET_SENTINEL', status: 'UNAVAILABLE', code: 'AUTH_UNAVAILABLE', dispatch: 'started'},
  {id: '403', http: 403, payload: 'SECRET_SENTINEL', status: 'UNAVAILABLE', code: 'AUTH_UNAVAILABLE', dispatch: 'started'},
  {id: '5xx', http: 500, payload: 'SECRET_SENTINEL', status: 'UNAVAILABLE', code: 'API_UNAVAILABLE', dispatch: 'started'},
  {id: 'not-dispatched', http: null, payload: null, status: 'UNAVAILABLE', code: 'CREDENTIAL_UNAVAILABLE', dispatch: 'not-started'},
  {id: 'refusal', http: 200, payload: JSON.stringify({refusal: 'synthetic refusal'}), status: 'INVALID', code: 'INVALID_PROVIDER_RESPONSE', dispatch: 'started'},
  {id: 'empty', http: 200, payload: '', status: 'INVALID', code: 'INVALID_PROVIDER_RESPONSE', dispatch: 'started'},
  {id: 'malformed', http: 200, payload: '{"answers":', status: 'INVALID', code: 'INVALID_PROVIDER_RESPONSE', dispatch: 'started'},
  {id: 'missing-questions', http: 200, payload: JSON.stringify({model: 'jev-fixed', answers: {alpha: {type: 'noul', noul: .9}}, usage: {input_tokens: 10, output_tokens: 2}}), status: 'INVALID', code: 'INVALID_PROVIDER_RESPONSE', dispatch: 'started'},
];
function fixture(id: string, fallback: boolean) {
  // The embedded SS30 originalPrompt is null. This is an explicit new synthetic probe, not an original prompt or semantic golden.
  const request = createClassificationRequest({requestId: `SS30-${id}-${fallback}`, operationId: `SS30-${id}-${fallback}`,
    originalPrompt: '합성 시험: alpha와 beta의 분류 응답 계약만 확인한다. 제품 수정 금지.',
    inventory: {skills: ['alpha', 'beta'].map(skillId => ({skillId, version: '1', description: 'synthetic error-classification probe',
      enabled: true, installed: true, hostSupported: true, capabilities: ['synthetic'], actions: ['inspect'], targets: ['fixture'], constraints: ['read-only'],
      applicability: ['synthetic fixture'], exclusions: ['product mutation'], dependencies: [], phases: [], sourceRefs: []})),
      inventoryDigest: `sha256:${'a'.repeat(64)}`, taxonomyRevision: 'SS30-synthetic', issues: []}, classificationCriteriaRef: 'embedded-SS30'});
  function profile(kind: 'jev' | 'vendor'): ProviderProfile {
    const p: ProviderProfile = {profileId: kind, providerKind: kind, vendorId: kind === 'jev' ? 'typesafe' : 'current-vendor', modelId: `${kind}-fixed`, modelRevision: `${kind}-fixed`,
      reasoningEffort: kind === 'jev' ? null : 'low', supportedOptions: {reasoningEfforts: kind === 'jev' ? [null] : ['low'], structuredOutput: true},
      approvedRouteRef: `${kind}-synthetic-route`, qualificationRevision: 'synthetic-not-live', qualification: {status: 'PASS', inventoryDigest: request.inventoryDigest,
        taxonomyRevision: request.taxonomyRevision, modelRevision: `${kind}-fixed`, promptRevision: 'synthetic-p1', validUntil: '2099-01-01T00:00:00Z', profileConfigurationDigest: ''},
      adapterRevision: 'synthetic-a1', promptRevision: 'synthetic-p1', maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: .4,
      judgmentPolicy: kind === 'jev' ? {neededAt: .8, notNeededAt: .2} : null};
    p.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(p); return p;
  }
  const evaluation = (): ProviderEvaluation => ({response: {schemaVersion: '1.0.0', requestId: request.requestId, operationId: request.operationId,
    requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: 'SUCCESS', judgments: request.skills.map(s => ({skillId: s.skillId,
      judgment: 'not-needed', reasonRefs: ['synthetic-only'], uncertaintyReason: null})), unresolvedItems: [], error: null},
    usage: {...unknownUsage(), inputTokens: 10, outputTokens: 2, actualCostUsd: .1}, dispatchState: 'started', diagnostics: null});
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: 0}, vendors: {'current-vendor': {limitUsd: 2, spentUsd: 0}}});
  const vendor = {availability: vi.fn(async () => ({available: true, approved: true, routeKind: 'remote' as const, reasonCode: null})), classify: vi.fn(async () => evaluation())};
  const input = {request, config: {jevEnabled: fallback, mode: 'select' as const, providerProfileRegistryRef: 'synthetic-profiles', externalClassificationAllowed: true,
    configRevision: 'SS30-synthetic-c1', timeoutMs: 1000}, registry: {schemaVersion: '1.0.0' as const, profileRevision: 'synthetic-pr1', profiles: [profile('jev'), profile('vendor')]}, currentVendorId: 'current-vendor'};
  return {request, input, evaluation, budget, vendor};
}
function observe(id: string, path: string, f: ReturnType<typeof fixture>, result: any, expected: any, input: any, extra = {}) {
  observations.push({caseId: 'SS30', variantId: id, path, executionKind: 'new-offline-mock', input, request: f.request, expected, observed: result,
    budget: f.budget.snapshot(), agentSelectedSkillIds: null, selected: 'NOTRUN', read: 'NOTRUN', applied: 'NOTRUN', verified: 'NOTRUN', API0: true, ...extra});
}
describe('SS30 independent error variants', () => {
  for (const c of cases) for (const fallback of [true, false]) {
    it(`SS30 ${c.id} ${fallback ? 'JEV-to-vendor' : 'vendor-failure-final'}`, async () => {
      const f = fixture(c.id, fallback), p = f.input.registry.profiles[fallback ? 0 : 1]!;
      let keyCalls = 0;
      const payload = c.id === 'missing-questions' ? c.payload!.replace('jev-fixed', p.modelRevision) : c.payload;
      const fetcher = vi.fn<typeof fetch>(async () => new Response(payload, {status: c.http!}));
      const route = {routeRef: p.approvedRouteRef, approvalRef: 'synthetic-only', approved: true, kind: 'remote' as const, providerKind: p.providerKind,
        vendorId: p.vendorId, adapterRevision: p.adapterRevision, modelIds: [p.modelId], reasoningEfforts: [p.reasoningEffort], structuredOutput: true,
        endpoint: 'https://ss30.example.invalid/mock', getCredential: async () => (++keyCalls, c.id === 'not-dispatched' && keyCalls > 1 ? null : 'SYNTHETIC_KEY'),
        adapter: jevNoulWireAdapter};
      const failing = new ApprovedRouteClassificationProvider([route], fetcher);
      const service = new SkillClassificationService({providers: fallback ? {jev: failing, vendor: f.vendor} : {vendor: failing}, budget: f.budget});
      const result = await service.classify(f.input);
      observe(c.id, fallback ? 'JEV-to-vendor' : 'vendor-failure-final', f, result,
        {failureStatus: c.status, errorCode: c.code, dispatchState: c.dispatch, finalStatus: fallback ? 'SUCCESS' : c.status, agentSelectedSkillIds: null},
        {http: c.http, body: payload === 'SECRET_SENTINEL' ? '[synthetic secret body redacted]' : payload, credentialDisappearsAfterAvailability: c.id === 'not-dispatched'},
        {mockFetchCalls: fetcher.mock.calls.length, mockVendorCalls: f.vendor.classify.mock.calls.length});
      expect(result.attempts[0]).toMatchObject({status: c.status, errorCode: c.code, dispatchState: c.dispatch, timedOut: false});
      expect(fetcher).toHaveBeenCalledTimes(c.id === 'not-dispatched' ? 0 : 1);
      expect(result.response.status).toBe(fallback ? 'SUCCESS' : c.status);
      expect(validateClassificationResponse(f.request, result.response)).toEqual([]);
      expect(result).not.toHaveProperty('agentSelectedSkillIds');
      expect(JSON.stringify(result)).not.toMatch(/SECRET_SENTINEL|SYNTHETIC_KEY/);
      if (fallback) {
        expect(result.attempts).toHaveLength(2); expect(f.vendor.classify).toHaveBeenCalledTimes(1);
        expect(result.attempts.map(a => a.providerKind)).toEqual(['jev', 'vendor']);
        expect(result.response.error).toBeNull();
        // Explicit complete not-needed judgments are not an observed AGENT [] selection.
        expect(result.response.judgments).toHaveLength(2);
      } else {
        expect(result.attempts).toHaveLength(1); expect(f.vendor.classify).not.toHaveBeenCalled();
        expect(result.response.error).toEqual({code: c.code, retryable: false, dispatchState: c.dispatch});
        expect(result.response.unresolvedItems).toEqual([{skillId: null, reasonCode: c.code}]);
        expect(result.response.judgments).toEqual([]);
      }
      expect(f.budget.snapshot().reservations).toHaveLength(c.id === 'not-dispatched' ? 0 : 1);
    });
  }
  it('SS30 connection-before-send confirmed only by pre-fetch credential failure; fetch rejection remains unknown', async () => {
    const f = fixture('transport-rejection', false), p = f.input.registry.profiles[1]!;
    const fetcher = vi.fn<typeof fetch>(async () => {throw new Error('SECRET_SENTINEL');});
    const provider = new ApprovedRouteClassificationProvider([{routeRef: p.approvedRouteRef, approvalRef: 'synthetic', approved: true, kind: 'remote',
      providerKind: 'vendor', vendorId: p.vendorId, adapterRevision: p.adapterRevision, modelIds: [p.modelId], reasoningEfforts: [p.reasoningEffort], structuredOutput: true,
      endpoint: 'https://ss30.example.invalid/mock', getCredential: async () => 'SYNTHETIC_KEY', adapter: jevNoulWireAdapter}], fetcher);
    const result = await new SkillClassificationService({providers: {vendor: provider}, budget: f.budget}).classify(f.input);
    observe('not-dispatched', 'fetch-rejection-extra-boundary', f, result, {status: 'UNAVAILABLE', code: 'TRANSPORT_UNAVAILABLE', dispatchState: 'unknown'}, {fetchRejects: true});
    expect(result.response).toMatchObject({status: 'UNAVAILABLE', error: {code: 'TRANSPORT_UNAVAILABLE', dispatchState: 'unknown'}});
    expect(fetcher).toHaveBeenCalledTimes(1); expect(f.budget.snapshot().reservations).toHaveLength(1);
  });
  it.each(['UNCERTAIN', 'PARTIAL'] as const)('SS30 semantic refusal %s preserves bound unresolved evidence and skips fallback', async status => {
    const f = fixture(`semantic-refusal-${status}`, true), e = f.evaluation();
    e.response.status = status;
    e.response.judgments = e.response.judgments.map((j, i) => status === 'PARTIAL' && i === 0 ? j : {...j, judgment: 'uncertain', reasonRefs: [], uncertaintyReason: 'MODEL_REFUSAL'});
    e.response.unresolvedItems = e.response.judgments.filter(j => j.judgment === 'uncertain').map(j => ({skillId: j.skillId, reasonCode: 'MODEL_REFUSAL'}));
    const result = await new SkillClassificationService({providers: {jev: {...f.vendor, classify: vi.fn(async () => e)}, vendor: f.vendor}, budget: f.budget}).classify(f.input);
    observe('refusal', `common-RESP-${status}`, f, result, {status, error: null, unresolvedCount: status === 'PARTIAL' ? 1 : 2, fallbackCalls: 0}, {evaluation: e});
    expect(result.response).toEqual(e.response); expect(result.attempts).toHaveLength(1); expect(f.vendor.classify).not.toHaveBeenCalled();
  });
  it('SS30 RED known valid cost is retained when candidate judgment is missing', async () => {
    const f = fixture('known-cost-invalid-response', true), e = f.evaluation(); e.response.judgments.pop();
    const result = await new SkillClassificationService({providers: {jev: {...f.vendor, classify: vi.fn(async () => e)}, vendor: f.vendor}, budget: f.budget}).classify(f.input);
    observe('missing-questions', 'known-cost-invalid-response', f, result, {errorCode: 'INVALID_PROVIDER_RESPONSE', actualCostUsd: .1, jevSpent: .1, pendingReservations: 0}, {evaluation: e},
      {existingFinding: 'valid-cost-lost-with-invalid-RESP'});
    expect(result.attempts[0]).toMatchObject({status: 'INVALID', errorCode: 'INVALID_PROVIDER_RESPONSE', usage: {actualCostUsd: .1}});
    expect(f.budget.snapshot().limits.jev?.spentUsd).toBe(.1); expect(f.budget.snapshot().reservations).toHaveLength(0);
  });
  it('SS30 RED semantic uncertainty must bind the uncertain skill to unresolvedItems', async () => {
    const f = fixture('unbound-refusal', true), e = f.evaluation(); e.response.status = 'PARTIAL';
    e.response.judgments[1] = {...e.response.judgments[1]!, judgment: 'uncertain', reasonRefs: [], uncertaintyReason: 'MODEL_REFUSAL'};
    // Malformed common RESP: evidence exists only on judgment; unresolvedItems is empty.
    const result = await new SkillClassificationService({providers: {jev: {...f.vendor, classify: vi.fn(async () => e)}, vendor: f.vendor}, budget: f.budget}).classify(f.input);
    observe('refusal', 'unbound-unresolvedItems', f, result, {invalidCommonRESP: true, fallbackCalls: 1}, {evaluation: e});
    expect(validateClassificationResponse(f.request, e.response).length).toBeGreaterThan(0);
    expect(result.attempts[0]?.status).toBe('INVALID'); expect(f.vendor.classify).toHaveBeenCalledTimes(1);
  });
});
