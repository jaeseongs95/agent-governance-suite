import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadSkillInventory } from '../mcp-server/src/skill-classification/inventory.js';
import { createClassificationRequest, projectClassificationRequest, digestClassificationValue } from '../mcp-server/src/skill-classification/request.js';
import { InMemoryClassificationBudget, SkillClassificationService } from '../mcp-server/src/skill-classification/service.js';
import { RuntimeSkillClassificationGateway, readClassificationRuntime } from '../mcp-server/src/skill-classification/gateway.js';
import { digestProviderProfileConfiguration } from '../mcp-server/src/skill-classification/profiles.js';
import { unknownUsage } from '../mcp-server/src/skill-classification/providers.js';
import { aggregate, scoreCase, oracleDigest, sameSet, type Observation } from './skill-classification/evaluation.js';
import type { SkillInventory, SkillClassificationRequestV1, ProviderProfile, ProviderEvaluation, SkillSelectionDecisionV1 } from '../mcp-server/src/skill-classification/types.js';

// Only SS03. All provider judgments/qualification are injected test data, never model evidence.
// New tests neither fabricate accepted host receipts nor invoke an external/native provider.
const root = process.cwd();
const evidence = './SS03-evidence';
const corpus = JSON.parse(readFileSync(`${root}/tests/skill-classification/fixtures.json`, 'utf8'));
const c = corpus.cases.find((x: {caseId: string}) => x.caseId === 'SS03');
const R = ['ponytail', 'cs-engineering', 'test-engineering', 'orchestrator'];
let inventory: SkillInventory;
let request: SkillClassificationRequestV1;
// Keep evidence from the separately executed control and known-defect groups.
const journal: unknown[] = (() => {
  try { return JSON.parse(readFileSync(`${evidence}/observations.json`, 'utf8')); }
  catch { return []; }
})();
const record = (id: string, input: unknown, expected: unknown, observed: unknown) => {
  journal.push({caseId: 'SS03', variantId: 'base', controlId: id, executionKind: 'offline-mock', input, expected, observed});
  writeFileSync(`${evidence}/observations.json`, JSON.stringify(journal, null, 2) + '\n');
};
beforeAll(async () => {
  inventory = await loadSkillInventory({root});
  request = createClassificationRequest({requestId: 'SS03-base', operationId: 'SS03-base', originalPrompt: c.originalPrompt,
    inventory, classificationCriteriaRef: 'skills/orchestrator/references/skill-classification.md'});
  writeFileSync(`${evidence}/SS03.request.json`, JSON.stringify(request, null, 2) + '\n');
});
afterEach(() => vi.unstubAllGlobals());
function observation(ids: string[] | null, layer: Observation['layer'] = 'vendorRaw'): Observation {
  return {caseId: 'SS03', layer, state: 'PASS', skillIds: ids, selectionStatus: ids === null ? 'NEEDS_INPUT' : 'SELECTED',
    reasonCodes: [], selectionReasons: [], executionKind: 'offline-mock', host: null, hostReceipt: null,
    requestDigest: request.requestDigest, inventoryDigest: inventory.inventoryDigest, conditionDigest: 'SS03-offline',
    stageEvidence: {read: false, applied: false, verified: false}};
}
function harness(ids = R, malformed = false) {
  const p: ProviderProfile = {profileId: 'SS03-test-profile', providerKind: 'vendor', vendorId: 'SS03-test-vendor',
    modelId: 'synthetic-SS03-no-model', modelRevision: 'synthetic-SS03-no-model', reasoningEffort: 'low',
    supportedOptions: {reasoningEfforts: ['low'], structuredOutput: true}, approvedRouteRef: 'synthetic-only',
    qualificationRevision: 'synthetic-only', qualification: {status: 'PASS', inventoryDigest: inventory.inventoryDigest,
      taxonomyRevision: inventory.taxonomyRevision, modelRevision: 'synthetic-SS03-no-model', promptRevision: 'synthetic-only',
      validUntil: '2099-01-01T00:00:00Z', profileConfigurationDigest: ''}, adapterRevision: 'synthetic-only',
    promptRevision: 'synthetic-only', maximumInputBytes: 1_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: null};
  p.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(p);
  const classify = vi.fn(async (req: SkillClassificationRequestV1): Promise<ProviderEvaluation> => ({
    response: {schemaVersion: '1.0.0', requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest,
      inventoryDigest: req.inventoryDigest, status: 'SUCCESS', judgments: malformed ? [] : req.skills.map(s => ({
        skillId: s.skillId, judgment: ids.includes(s.skillId) ? 'needed' : 'not-needed', reasonRefs: ['synthetic-SS03-control'], uncertaintyReason: null})),
      unresolvedItems: [], error: null}, usage: {...unknownUsage(), actualCostUsd: 0.1}, dispatchState: 'started', diagnostics: null}));
  const availability = vi.fn(async () => ({available: true, approved: true, routeKind: 'remote' as const, reasonCode: null}));
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 0, spentUsd: 0}, vendors: {'SS03-test-vendor': {limitUsd: 2, spentUsd: 0}}});
  const service = new SkillClassificationService({providers: {vendor: {availability, classify}}, budget, now: () => Date.parse('2026-10-09T00:00:00Z')});
  const runtime = {config: {jevEnabled: false, mode: 'select' as const, providerProfileRegistryRef: 'synthetic-only',
      externalClassificationAllowed: true, configRevision: 'synthetic-only', timeoutMs: 1000},
    registry: {schemaVersion: '1.0.0' as const, profileRevision: 'synthetic-only', profiles: [p]}, allowRemotePrivateContent: true};
  return {classify, availability, budget, service, runtime, input: {request, config: runtime.config, registry: runtime.registry, currentVendorId: p.vendorId}};
}

describe('SS03 offline controls', () => {
  it('binds exact fixture, embedded spec, oracle, and relevant source bytes', () => {
    expect(createHash('sha256').update(readFileSync(`${root}/tests/skill-classification/fixtures.json`)).digest('hex')).toBe('17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
    expect(oracleDigest(corpus)).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
    expect(c.oracle.required).toEqual(R); expect(c.variants).toEqual(['base']);
    expect(Object.keys(c.sourceSpec.fields)).toHaveLength(8);
    for (const s of c.oracle.sourceRefs) expect(`sha256:${createHash('sha256').update(readFileSync(`${root}/${s.path}`)).digest('hex')}`).toBe(s.digest);
    record('frozen-integrity', c, {required: R, variants: ['base']}, {required: c.oracle.required, variants: c.variants, oracle: oracleDigest(corpus)});
  });
  it('preserves every skill, original prompt, and unknown cause/target without inventing context', () => {
    expect(inventory.issues).toEqual([]);
    expect(inventory.skills.map(s => s.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
    const compact = projectClassificationRequest(request);
    expect(compact.payload.originalPrompt).toBe(c.originalPrompt);
    expect(request.confirmedContext).toEqual({taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null});
    expect(compact.payload.skills).toHaveLength(24);
    expect(compact.payload.originalPrompt).toContain('ACK 뒤 crash');
    expect(compact.payload.originalPrompt).toContain('중복 완료되지 않아야 해');
    for (const id of R) expect(compact.payload.skills.find(s => s.skillId === id)?.applicability.length).toBeGreaterThan(0);
    record('base-request', request, {exactPrompt: c.originalPrompt, skillCount: 24, context: 'all null'}, compact);
  });
  it('accepts the four required injected recommendations only as an offline scoring control', () => {
    const scored = scoreCase(c, observation(R), corpus.inventorySkillIds);
    record('exact-R', R, {verdict: 'PASS', missingRequired: []}, scored);
    expect(scored.verdict).toBe('PASS'); expect(scored.requiredHits).toBe(4);
  });
  it.each(R)('detects missing required %s', missing => {
    const ids = R.filter(x => x !== missing), scored = scoreCase(c, observation(ids), corpus.inventorySkillIds);
    record(`missing-${missing}`, ids, {verdict: 'FAIL', missingRequired: [missing]}, scored);
    expect(scored.verdict).toBe('FAIL'); expect(scored.missingRequired).toEqual([missing]);
  });
  it('rejects P-only and keeps unknown field cause independent of applicability', async () => {
    const h = harness(['ponytail']); const result = await h.service.classify(h.input);
    const ids = result.response.judgments.filter(x => x.judgment === 'needed').map(x => x.skillId);
    const scored = scoreCase(c, observation(ids), corpus.inventorySkillIds);
    record('P-only-CS-regression', {prompt: request.originalPrompt, context: request.confirmedContext, injected: ['ponytail']}, {verdict: 'FAIL', missingRequired: R.slice(1)}, {result, scored});
    expect(scored.verdict).toBe('FAIL'); expect(scored.missingRequired).toEqual(R.slice(1));
    expect(result.request.confirmedContext.targets).toBeNull(); expect(result.request.confirmedContext.background).toBeNull();
  });
  it('rejects select-all and leaves unadjudicated extras unscored', () => {
    const all = aggregate([c], [observation(corpus.inventorySkillIds)], 'vendorRaw', corpus.inventorySkillIds);
    record('select-all', corpus.inventorySkillIds, {falsePositives: 3, precision: null, verdict: 'INCOMPLETE_OR_FAIL'}, all);
    expect(all.truePositives).toBe(4); expect(all.falsePositives).toBe(3); expect(all.precision).toBeNull(); expect(all.verdict).toBe('INCOMPLETE_OR_FAIL');
    expect(scoreCase(c, observation([...R, 'session-board']), corpus.inventorySkillIds).verdict).toBe('REVIEW_REQUIRED');
  });
  it('separately rejects each reviewed incompatible extra', () => {
    for (const extra of c.oracle.notApplicable) {
      const scored = scoreCase(c, observation([...R, extra]), corpus.inventorySkillIds);
      record(`extra-${extra}`, [...R, extra], {verdict: 'FAIL', unnecessary: [extra]}, scored);
      expect(scored.verdict).toBe('FAIL'); expect(scored.unnecessary).toEqual([extra]);
    }
  });
  it('distinguishes null and empty [] and preserves missing observation as NOT_RUN', () => {
    const nullScore = scoreCase(c, observation(null), corpus.inventorySkillIds);
    const emptyScore = scoreCase(c, observation([]), corpus.inventorySkillIds);
    const absent = scoreCase(c, undefined, corpus.inventorySkillIds);
    record('null-empty-notrun', [null, []], {sameSet: false, nullAbstained: true, emptyAbstained: false, absent: 'NOT_RUN'}, {nullScore, emptyScore, absent});
    expect(sameSet(null, [])).toBe(false); expect(nullScore.abstained).toBe(true); expect(emptyScore.abstained).toBe(false);
    expect(nullScore.verdict).toBe('FAIL'); expect(emptyScore.verdict).toBe('FAIL'); expect(absent.verdict).toBe('NOT_RUN');
  });
  it('cannot promote recommendations to selected/read/applied/verified without host evidence', () => {
    const o = {...observation(R, 'selected'), stageEvidence: {read: true, applied: true, verified: true}};
    const score = scoreCase(c, o, corpus.inventorySkillIds);
    const report = aggregate([c], [o], 'selected', corpus.inventorySkillIds);
    record('no-receipt-no-stages', o, {verdict: 'FAIL', stageCoverage: {read: 0, applied: 0, verified: 0}}, {score, report});
    expect(score.reasons).toContain('HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH');
    expect(report.stageCoverage).toEqual({read: 0, applied: 0, verified: 0});
  });
  it('retains the raw CS omission when a separate combined control is corrected', () => {
    const raw = aggregate([c], [observation(['ponytail'])], 'vendorRaw', corpus.inventorySkillIds);
    const combined = aggregate([c], [observation(R, 'combined')], 'combined', corpus.inventorySkillIds);
    record('raw-versus-corrected', {raw: ['ponytail'], combined: R}, {rawRecall: 0.25, combinedRecall: 1}, {raw, combined});
    expect(raw.requiredRecall).toBe(0.25); expect(raw.verdict).toBe('INCOMPLETE_OR_FAIL'); expect(combined.requiredRecall).toBe(1);
  });
  it('runs real service/gateway boundaries with injected RESP while final selection stays null', async () => {
    const network = vi.fn(() => {throw new Error('SS03_NETWORK_FORBIDDEN');}); vi.stubGlobal('fetch', network);
    const h = harness(); const gateway = new RuntimeSkillClassificationGateway({root, service: h.service, readRuntime: async () => h.runtime});
    const result = await gateway.classify({schemaVersion: '1.0.0', requestId: request.requestId, operationId: request.operationId,
      originalPrompt: c.originalPrompt, confirmedContext: request.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [],
      vendorContext: {vendorId: 'SS03-test-vendor', reference: 'synthetic-only'}, publicSynthetic: true});
    expect(result).toHaveProperty('agentSelectedSkillIds', null); expect(result).toHaveProperty('selectionStatus', 'PROPOSED'); expect(result).toHaveProperty('adviceApplied', false);
    expect(h.classify).toHaveBeenCalledTimes(1); expect(h.classify.mock.calls[0][0].skills).toHaveLength(24);
    const decision: SkillSelectionDecisionV1 = {schemaVersion: '1.0.0', classificationResponseRef: digestClassificationValue(result.result!.response),
      requestDigest: request.requestDigest, inventoryDigest: inventory.inventoryDigest, taskRevision: null, configRevision: 'synthetic-only', profileRevision: 'synthetic-only',
      explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: R, selectionReasons: R.map(skillId => ({skillId, reason: 'synthetic test only'})),
      applicabilityChecks: R.map(skillId => ({skillId, applies: true, excluded: false, reasonRefs: ['synthetic-only']})), unresolvedSkillReferences: [], selectionStatus: 'SELECTED', adviceApplied: false, hostReceipt: null};
    const rejected = await gateway.accept({schemaVersion: '1.0.0', operationId: request.operationId, decision}, null);
    record('gateway-no-agent-receipt', {prompt: c.originalPrompt, injectedRecommendations: R, observation: null}, {selected: null, proposed: true, rejection: 'HOST_SELECTION_NOT_OBSERVED'}, {result, rejected});
    expect(rejected).toMatchObject({valid: false, agentSelectedSkillIds: null, errors: ['HOST_SELECTION_NOT_OBSERVED']}); expect(network).not.toHaveBeenCalled();
  });
  it('observes the actual unconfigured default without calling a provider', async () => {
    const runtime = await readClassificationRuntime(undefined, root);
    const service = new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})});
    const result = await service.classify({request, config: runtime.config, registry: runtime.registry, currentVendorId: 'unconfigured'});
    record('unconfigured', {configSupplied: false, request: request.requestDigest}, {attempts: [], error: 'PROFILE_UNAVAILABLE'}, result);
    expect(result.attempts).toEqual([]); expect(result.response.error?.code).toBe('PROFILE_UNAVAILABLE');
  });
});

describe('SS03 known-defect reproductions', () => {
  it('preserves valid actual cost even when the SS03 provider RESP is invalid', async () => {
    const h = harness(R, true); const result = await h.service.classify(h.input); const budget = h.budget.snapshot();
    record('known-invalid-RESP-valid-cost-loss', {prompt: c.originalPrompt, judgments: [], actualCostUsd: 0.1},
      {responseError: 'INVALID_PROVIDER_RESPONSE', actualCostUsd: 0.1, spentUsd: 0.1}, {result, budget});
    expect(result.response.error?.code).toBe('INVALID_PROVIDER_RESPONSE');
    expect.soft(result.attempts[0].usage.actualCostUsd).toBe(0.1);
    expect.soft(budget.limits['vendor:SS03-test-vendor'].spentUsd).toBe(0.1);
  });
  it('rechecks cancellation immediately before sending after budget reservation', async () => {
    const h = harness(); let cancelled = false; const reserve = h.budget.reserve.bind(h.budget);
    vi.spyOn(h.budget, 'reserve').mockImplementation((...args) => {const ok = reserve(...args); cancelled = true; return ok;});
    const snapshot = {taskRevision: null, configRevision: h.runtime.config.configRevision, profileRevision: h.runtime.registry.profileRevision,
      inventoryDigest: request.inventoryDigest, requestDigest: request.requestDigest, cancelled: false};
    const result = await h.service.classify({...h.input, getCurrentSnapshot: () => ({...snapshot, cancelled})});
    record('known-before-dispatch-recheck-gap', {prompt: c.originalPrompt, cancellationPoint: 'budget.reserve returns, before provider.classify'},
      {providerCalls: 0, error: 'STALE_CLASSIFICATION'}, {providerCalls: h.classify.mock.calls.length, result, budget: h.budget.snapshot()});
    expect(result.response.error?.code).toBe('STALE_CLASSIFICATION'); expect(h.classify).not.toHaveBeenCalled();
  });
});
