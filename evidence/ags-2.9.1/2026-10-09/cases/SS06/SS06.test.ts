import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {beforeAll, afterAll, describe, expect, it} from 'vitest';
import {loadSkillInventory} from '../../../../../mcp-server/src/skill-classification/inventory.js';
import {createClassificationRequest, projectClassificationRequest, validateClassificationRequest, digestClassificationValue} from '../../../../../mcp-server/src/skill-classification/request.js';
import {validateClassificationResponse} from '../../../../../mcp-server/src/skill-classification/validation.js';
import {RuntimeSkillClassificationGateway, readClassificationRuntime} from '../../../../../mcp-server/src/skill-classification/gateway.js';
import {SkillClassificationService, InMemoryClassificationBudget} from '../../../../../mcp-server/src/skill-classification/service.js';
import {digestProviderProfileConfiguration} from '../../../../../mcp-server/src/skill-classification/profiles.js';
import {scoreCase, aggregate, oracleDigest, canonicalSet, sameSet} from '../../../../../tests/skill-classification/evaluation.js';
import type {Observation} from '../../../../../tests/skill-classification/evaluation.js';
import type {ProviderProfile, SkillInventory, SkillClassificationRequestV1} from '../../../../../mcp-server/src/skill-classification/types.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const sha = (s: string | Buffer) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const fixtureBytes = readFileSync(root + '/tests/skill-classification/fixtures.json');
const corpus = JSON.parse(fixtureBytes.toString());
const c = corpus.cases.find((c: any) => c.caseId === 'SS06');
const evidence: any[] = [];
let inventory: SkillInventory;
let request: SkillClassificationRequestV1;
const record = (id: string, input: unknown, expected: unknown, observed: unknown) => evidence.push({caseId: 'SS06', variantId: id, executionKind: 'offline-isolated-test', input, expected, observed});
const observation = (skillIds: string[] | null, layer: Observation['layer'] = 'combined'): Observation => ({
  caseId: 'SS06', layer, state: 'PASS', skillIds, selectionStatus: skillIds === null ? 'NEEDS_INPUT' : 'SELECTED',
  reasonCodes: [], selectionReasons: [], executionKind: 'offline-mock', host: null, hostReceipt: null,
  requestDigest: request.requestDigest, inventoryDigest: inventory.inventoryDigest, conditionDigest: 'offline-only',
  stageEvidence: {read: false, applied: false, verified: false},
});
const response = (req: SkillClassificationRequestV1, ids: string[]) => ({schemaVersion: '1.0.0' as const,
  requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest,
  status: 'SUCCESS' as const, judgments: req.skills.map(s => ({skillId: s.skillId, judgment: ids.includes(s.skillId) ? 'needed' as const : 'not-needed' as const,
  reasonRefs: ['synthetic:SS06-purpose-control'], uncertaintyReason: null})), unresolvedItems: [], error: null});

beforeAll(async () => {
  inventory = await loadSkillInventory({root});
  request = createClassificationRequest({requestId: 'SS06-base-request', operationId: 'SS06-base-operation', originalPrompt: c.originalPrompt,
    inventory, classificationCriteriaRef: 'skills/orchestrator/references/skill-classification.md'});
});
afterAll(() => writeFileSync(fileURLToPath(new URL('./SS06.reproduced-observations.json', import.meta.url)), JSON.stringify({caseId: 'SS06',
  syntheticControlsOnly: true, providerLiveObservations: [], hostLiveObservations: [], hostReceipt: null,
  API: {jev: 0, externalVendor: 0, claude: 0}, records: evidence}, null, 2) + '\n'));

describe('SS06 only: frozen base and derived offline boundary controls', () => {
  it('binds SS06 to the frozen source and oracle', () => {
    expect(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim()).toBe('c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6');
    expect(execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {cwd: root, encoding: 'utf8'}).trim()).toBe('28f2f2ed8a864405320f6d20e7bc5004e8466ad3');
    expect(sha(fixtureBytes)).toBe('sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
    expect(oracleDigest(corpus)).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
    expect(c.variants).toEqual(['base']); expect(c.oracle.required).toEqual(['test-engineering']); expect(c.oracle.allowed).toEqual([]);
    for (const ref of c.oracle.sourceRefs) expect(sha(readFileSync(root + '/' + ref.path))).toBe(ref.digest);
    record('base-provenance', {sourceSpec: c.sourceSpec, originalPrompt: c.originalPrompt, oracle: c.oracle, variants: c.variants},
      'fixed commit/tree/fixture/oracle + all SS06 source bytes match', {sourceRefsChecked: c.oracle.sourceRefs.length, status: 'PASS'});
  });
  it('preserves base prompt, prohibitions, all candidates and unknown parser context', () => {
    expect(inventory.issues).toEqual([]); expect(inventory.skills.map(s => s.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
    const projected = projectClassificationRequest(request);
    expect(projected.payload.originalPrompt).toBe(c.originalPrompt);
    expect(projected.payload.originalPrompt.endsWith('제품 코드와 테스트 코드를 쓰거나 실행하지는 마.')).toBe(true);
    expect(projected.payload.confirmedContext).toEqual({taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null});
    expect(projected.payload.skills).toHaveLength(inventory.skills.length);
    expect(projected.payload.skills.find(s => s.skillId === 'test-engineering')?.dependencies).toEqual([]);
    record('base', {originalPrompt: c.originalPrompt, context: request.confirmedContext},
      {promptUnchanged: true, allCandidates: corpus.inventorySkillIds.length, parserContext: null, autoOrchestratorDependency: false},
      {prompt: projected.payload.originalPrompt, inventoryDigest: inventory.inventoryDigest, candidateCount: projected.payload.skills.length, payloadBytes: projected.payloadBytes});
  });
  it('does not silently truncate a prompt or inventory at a byte boundary', () => {
    const p = projectClassificationRequest(request);
    expect(projectClassificationRequest(request, p.payloadBytes).payload).toEqual(p.payload);
    let error: any; try {projectClassificationRequest(request, p.payloadBytes - 1);} catch (e) {error = e;}
    expect(error.message).toBe('INPUT_TOO_LONG'); expect(error.omittedRanges).toEqual([]);
    expect(() => validateClassificationRequest({...request, originalPrompt: c.originalPrompt.replace('쓰거나 실행하지는 마', '쓰고 실행해')})).toThrow('REQUEST_INTEGRITY_FAILED');
    record('byte-boundary', {bytes: p.payloadBytes, lowerLimit: p.payloadBytes - 1}, 'exact limit preserved; lower limit rejects without truncation',
      {exactLimit: 'PASS', lowerLimitError: error.message, omittedRanges: error.omittedRanges});
  });
  it('keeps unknown null distinct from sourced empty context', () => {
    const req = createClassificationRequest({requestId: 'SS06-empty', operationId: 'SS06-empty', originalPrompt: c.originalPrompt, inventory,
      classificationCriteriaRef: request.classificationCriteriaRef, confirmedContext: {targets: [], prohibitedActions: []},
      contextSources: [{field: 'targets', reference: 'synthetic:confirmed-empty'}, {field: 'prohibitedActions', reference: 'synthetic:confirmed-empty'}]});
    expect(projectClassificationRequest(req).payload.confirmedContext.targets).toEqual([]);
    expect(request.confirmedContext.targets).toBeNull(); expect(sameSet(null, [])).toBe(false); expect(canonicalSet(null)).toBeNull();
    expect(() => createClassificationRequest({requestId: 'SS06-unsourced', operationId: 'SS06-unsourced', originalPrompt: c.originalPrompt,
      inventory, classificationCriteriaRef: request.classificationCriteriaRef, confirmedContext: {targets: ['invented-parser-source']}})).toThrow('CONTEXT_SOURCE_MISSING');
    record('context-null-empty', {unknown: null, syntheticConfirmedEmpty: []}, 'preserve null/[] and reject invented parser context',
      {unknown: request.confirmedContext.targets, confirmedEmpty: req.confirmedContext.targets, unsourcedError: 'CONTEXT_SOURCE_MISSING'});
  });
  it('passes only the frozen T set as an offline evaluator positive control', () => {
    const score = scoreCase(c, observation(['test-engineering']), corpus.inventorySkillIds);
    expect(score.verdict).toBe('PASS'); expect(score.requiredHits).toBe(1); expect(score.falsePositives).toBe(0);
    record('base-positive-control', ['test-engineering'], 'PASS in synthetic combined layer only', score);
  });
  it.each(['ponytail', 'code-review', 'software-security-auditor', 'orchestrator'])('rejects forbidden extra %s', forbidden => {
    const ids = ['test-engineering', forbidden], score = scoreCase(c, observation(ids), corpus.inventorySkillIds);
    expect(score.verdict).toBe('FAIL'); expect(score.forbidden).toEqual([forbidden]); expect(score.requiredHits).toBe(1);
    record('forbidden-' + forbidden, ids, {verdict: 'FAIL', forbidden: [forbidden]}, score);
  });
  it.each(['cs-engineering', 'korean-prose-editor', 'change-scope-guardian'])('rejects not-applicable extra %s', extra => {
    const ids = ['test-engineering', extra], score = scoreCase(c, observation(ids), corpus.inventorySkillIds);
    expect(score.verdict).toBe('FAIL'); expect(score.unnecessary).toEqual([extra]);
    record('not-applicable-' + extra, ids, {verdict: 'FAIL', unnecessary: [extra]}, score);
  });
  it('keeps T required with parser absent; does not equate empty to abstention', () => {
    const empty = scoreCase(c, observation([]), corpus.inventorySkillIds), abstain = scoreCase(c, observation(null), corpus.inventorySkillIds);
    expect(empty.verdict).toBe('FAIL'); expect(empty.abstained).toBe(false); expect(empty.missingRequired).toEqual(['test-engineering']);
    expect(abstain.verdict).toBe('FAIL'); expect(abstain.abstained).toBe(true); expect(abstain.unnecessaryAbstention).toBe(true);
    expect(scoreCase(c, undefined, corpus.inventorySkillIds).verdict).toBe('NOT_RUN');
    record('missing-parser-boundary', {baseContext: request.confirmedContext, inputs: [[], null]},
      'T applicability survives absent parser; [] and null each fail for distinct reasons', {empty, abstain, notObserved: 'NOT_RUN'});
  });
  it('separates response structural validity from SS06 semantic correctness', () => {
    const rsp = response(request, ['test-engineering', 'orchestrator']);
    expect(validateClassificationResponse(request, rsp)).toEqual([]);
    const score = scoreCase(c, observation(rsp.judgments.filter(s => s.judgment === 'needed').map(s => s.skillId)), corpus.inventorySkillIds);
    expect(score.verdict).toBe('FAIL');
    record('advice-over-selection', {syntheticResponse: rsp}, 'schema can accept bad semantic advice; oracle rejects O', {schemaErrors: [], score});
  });
  it('never promotes unsupported selected/read/applied/verified declarations', () => {
    const obs = observation(['test-engineering'], 'selected'); obs.stageEvidence = {read: true, applied: true, verified: true};
    const report = aggregate([c], [obs], 'selected', corpus.inventorySkillIds);
    expect(report.scores[0].reasons).toContain('HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH');
    expect(report.stageCoverage).toEqual({read: 0, applied: 0, verified: 0});
    record('unobserved-stages', obs, 'no promotion without actual host receipt and phase evidence', {score: report.scores[0], stageCoverage: report.stageCoverage});
  });
  it('runs real request/service/gateway with synthetic provider but leaves selected null', async () => {
    const profile: ProviderProfile = {profileId: 'SS06-synthetic', providerKind: 'vendor', vendorId: 'mock-only', modelId: 'mock-only', modelRevision: 'mock-only', reasoningEffort: 'low',
      supportedOptions: {reasoningEfforts: ['low'], structuredOutput: true}, approvedRouteRef: 'synthetic:offline', qualificationRevision: 'synthetic:offline',
      qualification: {status: 'PASS', inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: 'mock-only', promptRevision: '1', validUntil: '2099-01-01T00:00:00Z', profileConfigurationDigest: 'sha256:' + '0'.repeat(64)},
      adapterRevision: '1', promptRevision: '1', maximumInputBytes: 2000000, maximumOutputTokens: 1000, maximumCostUsd: 0, judgmentPolicy: null};
    profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
    const runtime = {config: {jevEnabled: false, mode: 'select' as const, providerProfileRegistryRef: 'synthetic:offline', externalClassificationAllowed: false, configRevision: 'offline', timeoutMs: 2000},
      registry: {schemaVersion: '1.0.0' as const, profileRevision: 'offline', profiles: [profile]}, allowRemotePrivateContent: false};
    let mockCalls = 0;
    const service = new SkillClassificationService({providers: {vendor: {availability: async () => ({available: true, approved: true, routeKind: 'native', reasonCode: null}),
      classify: async req => {mockCalls++; return {response: response(req, ['test-engineering']), usage: {inputTokens: null, outputTokens: null, cachedInputTokens: null, actualCostUsd: 0}, dispatchState: 'started', diagnostics: null};}}},
      budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}, nativeAllowances: {'SS06-synthetic': {approvalRef: 'synthetic:offline', remainingCalls: 1}}})});
    const gateway = new RuntimeSkillClassificationGateway({root, service, readRuntime: async () => runtime});
    const advice: any = await gateway.classify({schemaVersion: '1.0.0', requestId: request.requestId, operationId: request.operationId,
      originalPrompt: c.originalPrompt, confirmedContext: request.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [],
      vendorContext: {vendorId: 'mock-only', reference: 'synthetic:offline'}, publicSynthetic: true});
    expect(advice.result.response.status).toBe('SUCCESS'); expect(mockCalls).toBe(1);
    expect(advice.agentSelectedSkillIds).toBeNull(); expect(advice.selectionStatus).toBe('PROPOSED'); expect(advice.adviceApplied).toBe(false);
    const accepted = await gateway.accept({schemaVersion: '1.0.0', operationId: request.operationId, decision: {
      schemaVersion: '1.0.0', classificationResponseRef: advice.classificationResponseRef,
      requestDigest: advice.result.snapshot.requestDigest, inventoryDigest: advice.result.snapshot.inventoryDigest,
      taskRevision: advice.result.snapshot.taskRevision, configRevision: advice.result.snapshot.configRevision, profileRevision: advice.result.snapshot.profileRevision,
      explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: ['test-engineering'],
      selectionReasons: [{skillId: 'test-engineering', reason: 'synthetic control, not real AGENT selection'}],
      applicabilityChecks: [{skillId: 'test-engineering', applies: true, excluded: false, reasonRefs: ['synthetic:purpose']}],
      unresolvedSkillReferences: [], selectionStatus: 'SELECTED', adviceApplied: false, hostReceipt: null,
    }}, null);
    expect(accepted).toMatchObject({valid: false, errors: ['HOST_SELECTION_NOT_OBSERVED'], agentSelectedSkillIds: null});
    record('base-gateway-synthetic', {originalPrompt: c.originalPrompt, providerBoundary: 'synthetic in-process port'},
      'mock advice SUCCESS; selected null; caller selection rejected without actual observation', {response: advice.result.response,
      mockPortCalls: mockCalls, agentSelectedSkillIds: advice.agentSelectedSkillIds, selectionStatus: advice.selectionStatus, accepted});
  });
  it('uses the supported unconfigured path without provider calls', async () => {
    const runtime = await readClassificationRuntime(undefined, root);
    const service = new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})});
    const result = await service.classify({request, config: runtime.config, registry: runtime.registry, currentVendorId: 'unknown'});
    expect(result.response.status).toBe('UNAVAILABLE'); expect(result.attempts).toEqual([]);
    record('host-config-missing', {runtimeConfig: 'unset'}, 'UNAVAILABLE; no inferred model/profile; 0 dispatch', {status: result.response.status, error: result.response.error, attempts: result.attempts});
  });
  it('reproduces the known missing host-state supply for required T', async () => {
    const observedMissing = await loadSkillInventory({root, installedSkillIds: [], hostSupportedSkillIds: []});
    const missingT = observedMissing.skills.find(s => s.skillId === 'test-engineering')!;
    expect(missingT.installed).toBe(false); expect(missingT.hostSupported).toBe(false);
    const service = new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})});
    const gateway = new RuntimeSkillClassificationGateway({root, service, readRuntime: () => readClassificationRuntime(undefined, root)});
    const assumed: any = await gateway.inventory();
    const defaultT = assumed.skills.find((s: any) => s.skillId === 'test-engineering');
    expect(defaultT.installed).toBe(true); expect(defaultT.hostSupported).toBe(true);
    expect(c.oracle.required).toEqual(['test-engineering']);
    record('known-host-state-supply-gap', {hostDiscoveryControl: {installedSkillIds: [], hostSupportedSkillIds: []}, required: ['test-engineering']},
      'known defect reproduction: loader can represent missing T; gateway has no host-state input and defaults to installed/supported',
      {loaderObservedT: {installed: missingT.installed, hostSupported: missingT.hostSupported},
      gatewayAssumedT: {installed: defaultT.installed, hostSupported: defaultT.hostSupported},
      knownFinding: 'host 활성상태 공급 공백', status: 'REPRODUCED_KNOWN_GAP', actualHostState: null});
  });
});
