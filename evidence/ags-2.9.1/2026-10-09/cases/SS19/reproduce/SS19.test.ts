import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadSkillInventory} from '../../mcp-server/src/skill-classification/inventory.js';
import {createClassificationRequest} from '../../mcp-server/src/skill-classification/request.js';
import {digestProviderProfileConfiguration} from '../../mcp-server/src/skill-classification/profiles.js';
import {SkillClassificationService} from '../../mcp-server/src/skill-classification/service.js';
import {createClassificationProviderRuntime} from '../../mcp-server/src/skill-classification/runtime.js';
import {RuntimeSkillClassificationGateway} from '../../mcp-server/src/skill-classification/gateway.js';
import {buildVendorMessages} from '../../mcp-server/src/skill-classification/providers.js';
import {oracleDigest} from '../skill-classification/evaluation.js';
import type {ProviderProfile, ProviderEvaluation, SkillInventory} from '../../mcp-server/src/skill-classification/types.js';

// SS19 only. Its referenced prompts are inputs, not independently executed SS cases.
// Real request/inventory/profile/runtime/route/service/gateway; transport, credentials,
// qualification and usage are synthetic. No real host selection or API calls.
const root = process.cwd();
const out = process.env.SS19_EVIDENCE_DIR ?? './ss19-evidence';
const bytes = readFileSync(`${root}/tests/skill-classification/fixtures.json`);
const corpus = JSON.parse(bytes.toString('utf8'));
const ss19 = corpus.cases.find((x: any) => x.caseId === 'SS19');
const ids = ['SS03', 'SS04', 'SS09', 'SS10'];
const rows: any[] = [];
let inventory: SkillInventory;
const stages = {selected: 'NOTRUN', read: 'NOTRUN', applied: 'NOTRUN', verified: 'NOTRUN'};

beforeAll(async () => {
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
  expect(oracleDigest(corpus)).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
  expect(ss19.originalPrompt).toBeNull(); expect(ss19.oracle).toBeNull();
  expect(ss19.variants).toEqual(['off-allowed', 'off-egress-denied-no-native']);
  inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
});
afterAll(() => writeFileSync(`${out}/observations.json`, JSON.stringify({caseId: 'SS19', inventory, rows}, null, 2)));

function fixture(id: string, allowed = true, registerAdapter = true, routeApproved = true, budgetSpent: number | null = 0) {
  const source = corpus.cases.find((x: any) => x.caseId === id);
  const request = createClassificationRequest({requestId: `SS19/${id}`, operationId: `SS19/${id}`,
    originalPrompt: source.originalPrompt, inventory, classificationCriteriaRef: 'skills/orchestrator/references/skill-classification.md'});
  const profile = (kind: 'jev' | 'vendor'): ProviderProfile => {
    const p: ProviderProfile = {profileId: `SS19-${kind}`, providerKind: kind, vendorId: kind === 'jev' ? 'typesafe' : 'synthetic-vendor',
      modelId: `${kind}-fixed`, modelRevision: `${kind}-fixed`, reasoningEffort: kind === 'jev' ? null : 'low',
      supportedOptions: {reasoningEfforts: kind === 'jev' ? [null] : ['low'], structuredOutput: true},
      approvedRouteRef: `${kind}-route`, qualificationRevision: 'synthetic-Q1', qualification: {status: 'PASS', inventoryDigest: inventory.inventoryDigest,
        taxonomyRevision: inventory.taxonomyRevision, modelRevision: `${kind}-fixed`, promptRevision: 'p1', validUntil: '2099-01-01T00:00:00Z', profileConfigurationDigest: ''},
      adapterRevision: 'a1', promptRevision: 'p1', maximumInputBytes: 1000000, maximumOutputTokens: 1000, maximumCostUsd: 0.4,
      judgmentPolicy: kind === 'jev' ? {neededAt: 0.8, notNeededAt: 0.2} : null};
    p.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(p); return p;
  };
  const mockEvaluation: ProviderEvaluation = {response: {schemaVersion: '1.0.0', requestId: request.requestId, operationId: request.operationId,
    requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: 'SUCCESS',
    judgments: inventory.skills.map(s => ({skillId: s.skillId, judgment: source.oracle.required.includes(s.skillId) ? 'needed' : 'not-needed',
      reasonRefs: ['synthetic-transport-response'], uncertaintyReason: null})), unresolvedItems: [], error: null},
    usage: {inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, actualCostUsd: 0.1}, dispatchState: 'started', diagnostics: null};
  const fetcher = vi.fn(async () => new Response(JSON.stringify(mockEvaluation), {status: 200}));
  const credentials = vi.fn(async (_name: string) => 'synthetic-token');
  const runtimeConfig = {schemaVersion: '1.0.0', routes: (['jev', 'vendor'] as const).map(kind => ({routeRef: `${kind}-route`, approvalRef: 'synthetic-approval',
    approved: routeApproved, providerKind: kind, vendorId: kind === 'jev' ? 'typesafe' : 'synthetic-vendor', adapterRevision: 'a1', modelIds: [`${kind}-fixed`],
    reasoningEfforts: kind === 'jev' ? [null] : ['low'], structuredOutput: true, kind: 'remote', endpoint: `https://${kind}.invalid/classify`,
    credentialEnvName: `${kind.toUpperCase()}_SYNTHETIC`, wireAdapterRef: kind === 'jev' ? 'jev-noul-v1' : 'synthetic-vendor-wire'})),
    budget: {jev: {limitUsd: null, spentUsd: null}, vendors: {'synthetic-vendor': {limitUsd: 2, spentUsd: budgetSpent}}, nativeAllowances: {}}};
  const runtime = createClassificationProviderRuntime(runtimeConfig, {fetcher: fetcher as any, getCredentialByEnvName: credentials,
    wireAdapters: registerAdapter ? new Map([['synthetic-vendor-wire', {
      encode: (r: any, p: ProviderProfile) => ({model: p.modelId, effort: p.reasoningEffort, messages: buildVendorMessages(r)}),
      decode: (body: unknown) => body as ProviderEvaluation}]]) : new Map()});
  const jevAvailability = vi.spyOn(runtime.providers.jev, 'availability'), jevClassify = vi.spyOn(runtime.providers.jev, 'classify');
  const vendorAvailability = vi.spyOn(runtime.providers.vendor, 'availability'), vendorClassify = vi.spyOn(runtime.providers.vendor, 'classify');
  const input = {request, config: {jevEnabled: false, mode: 'select' as const, providerProfileRegistryRef: 'synthetic', externalClassificationAllowed: allowed,
    configRevision: 'SS19-c1', timeoutMs: 1000}, registry: {schemaVersion: '1.0.0' as const, profileRevision: 'SS19-pr1', profiles: [profile('jev'), profile('vendor')]}, currentVendorId: 'synthetic-vendor'};
  const service = new SkillClassificationService({...runtime, now: () => Date.parse('2026-10-09T00:00:00Z')});
  return {source, request, mockEvaluation, runtimeConfig, runtime, fetcher, credentials, jevAvailability, jevClassify, vendorAvailability, vendorClassify, input, service};
}
function record(name: string, f: ReturnType<typeof fixture>, result: any, expected: unknown, extra = {}) {
  const row = {name, caseId: 'SS19', sourceInputId: f.source.caseId, executionKind: 'offline-mock-new-variant', API0: true,
    input: f.input, expected, observed: {result, budget: f.runtime.budget.snapshot(), jevAvailabilityCount: f.jevAvailability.mock.calls.length,
      jevCallCount: f.jevClassify.mock.calls.length, jevCredentialReadCount: f.credentials.mock.calls.filter(c => c[0] === 'JEV_SYNTHETIC').length,
      vendorClassifierCallCount: f.vendorClassify.mock.calls.length, vendorCredentialReadCount: f.credentials.mock.calls.filter(c => c[0] === 'VENDOR_SYNTHETIC').length,
      mockFetchCount: f.fetcher.mock.calls.length, nativeCalls: 0, agentSelectedSkillIds: null, hostReceipt: null}, stages, ...extra};
  rows.push(row); return row;
}
function noJev(f: ReturnType<typeof fixture>) {
  expect(f.jevAvailability).not.toHaveBeenCalled(); expect(f.jevClassify).not.toHaveBeenCalled();
  expect(f.credentials.mock.calls.filter(c => c[0] === 'JEV_SYNTHETIC')).toEqual([]);
}

describe('SS19 all frozen variants', () => {
  for (const variant of ss19.variants) for (const id of ids) it(`${variant}/${id}`, async () => {
    const allowed = variant === 'off-allowed', f = fixture(id, allowed);
    const gateway = new RuntimeSkillClassificationGateway({root, service: f.service, readRuntime: async () => ({config: f.input.config, registry: f.input.registry,
      allowRemotePrivateContent: false, approvedPublicRequestDigests: [f.request.requestDigest]})});
    const result = await gateway.classify({schemaVersion: '1.0.0', requestId: f.request.requestId, operationId: f.request.operationId,
      originalPrompt: f.request.originalPrompt, confirmedContext: f.request.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [],
      vendorContext: {vendorId: 'synthetic-vendor', reference: 'synthetic-reference'}, publicSynthetic: true}) as any;
    const rawIds = allowed ? result.result.response.judgments.filter((j: any) => j.judgment === 'needed').map((j: any) => j.skillId) : null;
    record(`${variant}/${id}`, f, result, {status: allowed ? 'SUCCESS' : 'UNAVAILABLE', errorCode: allowed ? null : 'EXTERNAL_CLASSIFICATION_BLOCKED',
      jevCallCount: 0, jevCredentialReadCount: 0, vendorClassifierCallCount: allowed ? 1 : 0, mockFetchCount: allowed ? 1 : 0,
      rawMockIds: allowed ? f.source.oracle.required : null, agentSelectedSkillIds: null}, {variant, rawMockIds: rawIds});
    noJev(f); expect(result.agentSelectedSkillIds).toBeNull(); expect(result.selectionStatus).toBe('PROPOSED'); expect(result.adviceApplied).toBe(false);
    expect(f.vendorClassify).toHaveBeenCalledTimes(allowed ? 1 : 0); expect(f.fetcher).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(result.result.response.status).toBe(allowed ? 'SUCCESS' : 'UNAVAILABLE');
    expect(result.result.response.error?.code ?? null).toBe(allowed ? null : 'EXTERNAL_CLASSIFICATION_BLOCKED');
    if (allowed) {
      const wire = JSON.parse((f.fetcher.mock.calls[0] as any)[1].body);
      const payload = JSON.parse(wire.messages[1].content);
      expect(payload.originalPrompt).toBe(f.source.originalPrompt); expect(payload.skills.map((s: any) => s.skillId)).toEqual(inventory.skills.map(s => s.skillId));
      expect(payload.confirmedContext.actions).toBeNull(); expect(wire.model).toBe('vendor-fixed'); expect(wire.effort).toBe('low');
      expect(f.vendorClassify.mock.calls[0]![1]).toEqual(f.input.registry.profiles[1]);
      expect([...rawIds].sort()).toEqual([...f.source.oracle.required].sort());
      expect(f.runtime.budget.snapshot().limits['vendor:synthetic-vendor']!.spentUsd).toBe(0.1);
      expect(f.runtime.budget.snapshot().reservations).toEqual([]);
    } else {
      expect(result.result.response.judgments).toEqual([]); expect(rawIds).toBeNull();
      expect(f.runtime.budget.snapshot().reservations).toEqual([]);
      expect(result.result.attempts[0].dispatchState).toBe('not-started');
    }
  });
});

describe('SS19 uncovered hold boundaries', () => {
  it.each(['PROFILE_UNQUALIFIED', 'COST_UNKNOWN', 'UNSUPPORTED_OPTIONS', 'ROUTE_NOT_APPROVED', 'BUDGET_UNAVAILABLE', 'ADAPTER_UNREGISTERED'])('%s', async code => {
    const f = fixture('SS03', true, code !== 'ADAPTER_UNREGISTERED', code !== 'ROUTE_NOT_APPROVED', code === 'BUDGET_UNAVAILABLE' ? null : 0), p = f.input.registry.profiles[1]!;
    if (code === 'PROFILE_UNQUALIFIED') p.qualification.status = 'NOT_RUN';
    if (code === 'COST_UNKNOWN') {p.maximumCostUsd = null; p.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(p);}
    if (code === 'UNSUPPORTED_OPTIONS') {p.supportedOptions.reasoningEfforts = [null]; p.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(p);}
    const result = await f.service.classify(f.input);
    const expectedCode = code === 'ADAPTER_UNREGISTERED' ? 'ROUTE_NOT_APPROVED' : code;
    record(code, f, result, {status: 'UNAVAILABLE', errorCode: expectedCode, vendorClassifierCallCount: 0});
    noJev(f); expect(result.response.error?.code).toBe(expectedCode); expect(f.vendorClassify).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe('SS19 known defect probes through OFF vendor', () => {
  it('valid cost survives invalid RESP', async () => {
    const f = fixture('SS03'); f.mockEvaluation.response.judgments = [];
    const result = await f.service.classify(f.input);
    record('invalid-RESP-valid-cost', f, result, {status: 'INVALID', errorCode: 'INVALID_PROVIDER_RESPONSE', actualCostUsd: 0.1, spentUsd: 0.1}, {knownFinding: 'valid-cost-lost-with-invalid-RESP'});
    noJev(f); expect(result.response.error?.code).toBe('INVALID_PROVIDER_RESPONSE'); expect(f.vendorClassify).toHaveBeenCalledTimes(1);
    expect(result.attempts[0]!.usage.actualCostUsd).toBe(0.1); expect(f.runtime.budget.snapshot().limits['vendor:synthetic-vendor']!.spentUsd).toBe(0.1);
  });
  it('timeout overflow is rejected before vendor dispatch', async () => {
    const f = fixture('SS03'); f.input.config.timeoutMs = 2147483648;
    f.vendorClassify.mockImplementation(async () => new Promise(() => {}));
    const result = await f.service.classify(f.input);
    record('timeout-overflow', f, result, {errorCode: 'INVALID_TIMEOUT', vendorClassifierCallCount: 0}, {knownFinding: 'timeout-overflow'});
    noJev(f); expect(result.response.error?.code).toBe('INVALID_TIMEOUT'); expect(f.vendorClassify).not.toHaveBeenCalled();
  });
  it('rechecks task immediately before vendor dispatch after reserve', async () => {
    const f = fixture('SS03');
    const snapshot = {taskRevision: f.request.confirmedContext.taskRevision, requestDigest: f.request.requestDigest, inventoryDigest: inventory.inventoryDigest,
      configRevision: f.input.config.configRevision, profileRevision: f.input.registry.profileRevision, cancelled: false};
    const reserve = f.runtime.budget.reserve.bind(f.runtime.budget);
    vi.spyOn(f.runtime.budget, 'reserve').mockImplementation((...args) => {const value = reserve(...args); snapshot.cancelled = true; return value;});
    const result = await f.service.classify({...f.input, getCurrentSnapshot: () => snapshot});
    record('pre-dispatch-recheck-gap', f, result, {errorCode: 'STALE_CLASSIFICATION', vendorClassifierCallCount: 0}, {knownFinding: 'pre-dispatch-recheck-gap'});
    noJev(f); expect(result.response.error?.code).toBe('STALE_CLASSIFICATION'); expect(f.vendorClassify).not.toHaveBeenCalled();
  });
});
