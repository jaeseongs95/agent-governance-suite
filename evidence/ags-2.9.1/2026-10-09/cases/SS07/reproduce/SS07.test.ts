import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {loadSkillInventory} from '../../mcp-server/src/skill-classification/inventory.js';
import {createClassificationRequest, projectClassificationRequest, digestClassificationValue} from '../../mcp-server/src/skill-classification/request.js';
import {validateClassificationResponse} from '../../mcp-server/src/skill-classification/validation.js';
import {RuntimeSkillClassificationGateway, readClassificationRuntime} from '../../mcp-server/src/skill-classification/gateway.js';
import {InMemoryClassificationBudget, SkillClassificationService} from '../../mcp-server/src/skill-classification/service.js';
import {digestProviderProfileConfiguration} from '../../mcp-server/src/skill-classification/profiles.js';
import {unknownUsage} from '../../mcp-server/src/skill-classification/providers.js';
import {scoreCase, oracleDigest, sameSet, aggregate} from '../skill-classification/evaluation.js';
import {digest, digestBytes, targetDigest, validateSemantics} from '../../skills/software-security-auditor/scripts/core.mjs';
import {validateReportSchema, validateReport} from '../../skills/software-security-auditor/scripts/validation.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const evidence = process.env.SS07_EVIDENCE_DIR ?? path.resolve(root, 'SS07-reproduction-output');
const corpus = JSON.parse(readFileSync(path.join(root, 'tests/skill-classification/fixtures.json'), 'utf8'));
const fixture = corpus.cases.find((c: any) => c.caseId === 'SS07');
const sec = 'software-security-auditor';
const raw: any[] = [];
let inventory: any, request: any, apiAttempts = 0;
const hash = (v: string | Buffer) => 'sha256:' + createHash('sha256').update(v).digest('hex');
function record(id: string, input: unknown, expected: unknown, observed: unknown, executionKind = 'offline-mock') {
  raw.push({caseId: 'SS07', variant: 'base', boundaryId: id, input, expected, observed, executionKind});
}
function response(req = request, needed = [sec]): any {
  return {schemaVersion: '1.0.0', requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest,
    inventoryDigest: req.inventoryDigest, status: 'SUCCESS', judgments: req.skills.map((s: any) => ({skillId: s.skillId,
      judgment: needed.includes(s.skillId) ? 'needed' : 'not-needed', reasonRefs: ['SS07:synthetic-test-answer'], uncertaintyReason: null})), unresolvedItems: [], error: null};
}
function observation(ids: string[] | null, layer = 'vendorRaw'): any {
  return {caseId: 'SS07', layer, state: 'PASS', skillIds: ids, selectionStatus: ids === null ? 'NEEDS_INPUT' : 'SELECTED',
    reasonCodes: [], selectionReasons: [], executionKind: 'offline-mock', host: null, hostReceipt: null,
    requestDigest: request.requestDigest, inventoryDigest: inventory.inventoryDigest, conditionDigest: hash(fixture.originalPrompt),
    stageEvidence: {read: false, applied: false, verified: false}};
}
function support(evaluate = async (req: any) => ({response: response(req), usage: {...unknownUsage(), actualCostUsd: 0.1}, dispatchState: 'started', diagnostics: null})) {
  const profile: any = {profileId: 'SS07-mock', providerKind: 'vendor', vendorId: 'offline-test', modelId: 'synthetic-only', modelRevision: 'synthetic-only',
    reasoningEffort: 'low', supportedOptions: {reasoningEfforts: ['low'], structuredOutput: true}, approvedRouteRef: 'test-only-not-approval',
    qualificationRevision: 'mock-not-live-qualification', qualification: {status: 'PASS', inventoryDigest: inventory.inventoryDigest,
      taxonomyRevision: inventory.taxonomyRevision, modelRevision: 'synthetic-only', promptRevision: 'mock', validUntil: '2099-01-01T00:00:00Z', profileConfigurationDigest: ''},
    adapterRevision: 'mock', promptRevision: 'mock', maximumInputBytes: 1_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: null};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const provider: any = {availability: vi.fn(async () => ({available: true, approved: true, routeKind: 'remote', reasonCode: null})), classify: vi.fn(evaluate)};
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {'offline-test': {limitUsd: 1, spentUsd: 0}}});
  const service = new SkillClassificationService({providers: {vendor: provider}, budget});
  const runtime: any = {config: {jevEnabled: false, mode: 'select', providerProfileRegistryRef: 'test-only', externalClassificationAllowed: true, configRevision: 'mock', timeoutMs: 1000},
    registry: {schemaVersion: '1.0.0', profileRevision: 'mock', profiles: [profile]}, allowRemotePrivateContent: true};
  return {provider, budget, service, runtime, input: {request, config: runtime.config, registry: runtime.registry, currentVendorId: 'offline-test'}};
}
const intake = () => ({schemaVersion: '1.0.0', requestId: request.requestId, operationId: request.operationId, originalPrompt: fixture.originalPrompt,
  confirmedContext: request.confirmedContext, contextSources: request.contextSources, explicitSkillIds: [], ruleRequiredSkillIds: [],
  vendorContext: {vendorId: 'offline-test', reference: 'synthetic-only'}, publicSynthetic: true});
beforeAll(async () => {
  vi.stubGlobal('fetch', () => {apiAttempts++; throw new Error('EXTERNAL_API_FORBIDDEN');});
  inventory = await loadSkillInventory({root});
  request = createClassificationRequest({requestId: 'SS07-base', operationId: 'SS07-base', originalPrompt: fixture.originalPrompt, inventory,
    classificationCriteriaRef: 'skills/orchestrator/references/skill-classification.md'});
  mkdirSync(evidence, {recursive: true});
  writeFileSync(path.join(evidence, 'SS07.fixture.json'), JSON.stringify(fixture, null, 2));
  writeFileSync(path.join(evidence, 'SS07.request.json'), JSON.stringify(request, null, 2));
  writeFileSync(path.join(evidence, 'SS07.inventory.json'), JSON.stringify(inventory, null, 2));
});
afterAll(() => {
  writeFileSync(path.join(evidence, 'SS07.observations.json'), JSON.stringify({caseId: 'SS07', apiAttempts, raw,
    actualHostObservation: {executionKind: 'host-live', state: 'NOT_RUN', agentSelectedSkillIds: null, hostReceipt: null,
      selected: 'NOTRUN', read: 'NOTRUN', applied: 'NOTRUN', verified: 'NOTRUN'}}, null, 2));
  vi.unstubAllGlobals();
});
describe('SS07 only: frozen base and additional isolated boundaries', () => {
  it('SS07 provenance and every declared variant', () => {
    const actual = {commit: spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).stdout.trim(),
      tree: spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {cwd: root, encoding: 'utf8'}).stdout.trim(),
      fixtureSHA: hash(readFileSync(path.join(root, 'tests/skill-classification/fixtures.json'))), oracleSHA: oracleDigest(corpus), variants: fixture.variants};
    record('provenance', fixture.sourceSpec, 'fixed commit/tree/fixture/oracle and variants=[base]', actual, 'offline-static');
    expect(actual.commit).toBe('c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6'); expect(actual.tree).toBe('28f2f2ed8a864405320f6d20e7bc5004e8466ad3');
    expect(actual.fixtureSHA).toBe('sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
    expect(actual.oracleSHA).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
    expect(fixture.variants).toEqual(['base']); expect(fixture.oracle.required).toEqual([sec]);
    for (const s of fixture.oracle.sourceRefs) expect(hash(readFileSync(path.join(root, s.path)))).toBe(s.digest);
  });
  it('SS07 original bytes, prohibition clauses, full inventory and unknown context survive projection', () => {
    const out = projectClassificationRequest(request);
    record('projection', {prompt: fixture.originalPrompt, context: request.confirmedContext}, 'exact originalPrompt; all 24 IDs; unknown context=null', out);
    expect(inventory.issues).toEqual([]); expect(request.skills.map((s: any) => s.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
    expect(out.payload.originalPrompt).toBe(fixture.originalPrompt); expect(out.payload.skills).toHaveLength(corpus.inventorySkillIds.length);
    expect(Object.values(out.payload.confirmedContext).every(v => v === null)).toBe(true);
    expect(out.payload.originalPrompt).toContain('읽기 전용이며 수정과 운영 서비스 능동 검사는 금지야');
  });
  it('SS07 exact SEC mock is an evaluator control, not AGENT selection', () => {
    const score = scoreCase(fixture, observation([sec]), corpus.inventorySkillIds);
    record('exact-SEC-control', observation([sec]), 'raw oracle PASS, selected/read/applied/verified NOTRUN', score);
    expect(score.verdict).toBe('PASS'); expect(validateClassificationResponse(request, response())).toEqual([]);
  });
  it.each(['ponytail', 'code-review', 'independent-audit-gate'])('SS07 rejects automatic forbidden addition %s', (extra) => {
    const score = scoreCase(fixture, observation([sec, extra]), corpus.inventorySkillIds);
    record('forbidden-' + extra, [sec, extra], {verdict: 'FAIL', forbidden: [extra]}, score);
    expect(score.verdict).toBe('FAIL'); expect(score.forbidden).toEqual([extra]); expect(score.requiredHits).toBe(1);
  });
  it('SS07 general review replacement and all-skills output both fail despite structural validity', () => {
    const replacement = scoreCase(fixture, observation(['code-review']), corpus.inventorySkillIds);
    const all = scoreCase(fixture, observation(corpus.inventorySkillIds), corpus.inventorySkillIds);
    record('replacement-and-select-all', [['code-review'], corpus.inventorySkillIds], 'both FAIL; raw semantic error never repaired by contract validator', {replacement, all});
    expect(validateClassificationResponse(request, response(request, ['code-review']))).toEqual([]);
    expect(replacement.missingRequired).toEqual([sec]); expect(replacement.verdict).toBe('FAIL'); expect(all.verdict).toBe('FAIL');
  });
  it('SS07 raw recommendation never becomes selection and unobserved accept is rejected', async () => {
    const f = support(); const gateway = new RuntimeSkillClassificationGateway({root, service: f.service, readRuntime: async () => f.runtime});
    const out: any = await gateway.classify(intake());
    const decision: any = {schemaVersion: '1.0.0', classificationResponseRef: out.classificationResponseRef, ...out.result.snapshot,
      explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: [sec], selectionReasons: [{skillId: sec, reason: 'synthetic test only'}],
      applicabilityChecks: [{skillId: sec, applies: true, excluded: false, reasonRefs: ['synthetic test only']}], unresolvedSkillReferences: [],
      selectionStatus: 'SELECTED', adviceApplied: false, hostReceipt: null};
    delete decision.cancelled;
    const accept = await gateway.accept({schemaVersion: '1.0.0', operationId: request.operationId, decision}, null);
    record('support-not-selection', intake(), {selected: null, accept: 'HOST_SELECTION_NOT_OBSERVED'}, {classification: out, accept});
    expect(out.agentSelectedSkillIds).toBeNull(); expect(out.selectionStatus).toBe('PROPOSED'); expect(out.adviceApplied).toBe(false);
    expect(accept).toEqual({valid: false, errors: ['HOST_SELECTION_NOT_OBSERVED'], agentSelectedSkillIds: null});
  });
  it('SS07 null and empty stay distinct; exact set without host receipt fails selected layer', () => {
    const noReceipt = scoreCase(fixture, observation([sec], 'selected'), corpus.inventorySkillIds);
    const unknown = scoreCase(fixture, observation(null), corpus.inventorySkillIds), empty = scoreCase(fixture, observation([]), corpus.inventorySkillIds);
    const actual = aggregate([fixture], [], 'selected', corpus.inventorySkillIds);
    record('null-empty-stage-evidence', {selectedUnknown: null, validEmptyExample: [], hostReceipt: null}, 'null != []; no receipt FAIL; actual notRun=1', {noReceipt, unknown, empty, actual});
    expect(sameSet(null, [])).toBe(false); expect(noReceipt.reasons).toContain('HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH');
    expect(unknown.abstained).toBe(true); expect(empty.abstained).toBe(false); expect(actual.notRun).toBe(1); expect(actual.passes).toBe(0);
  });
  it('SS07 unconfigured environment has zero attempts and no selected set', async () => {
    const runtime = await readClassificationRuntime(undefined, root);
    const service = new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})});
    const gateway = new RuntimeSkillClassificationGateway({root, service, readRuntime: async () => runtime});
    const out: any = await gateway.classify(intake());
    record('unconfigured-path', {configRef: null, originalPrompt: fixture.originalPrompt}, 'PROFILE_UNAVAILABLE, attempts=[], selected=null', out, 'offline-runtime');
    expect(out.result.response.error.code).toBe('PROFILE_UNAVAILABLE'); expect(out.result.attempts).toEqual([]); expect(out.agentSelectedSkillIds).toBeNull();
  });
  it('SS07 missing target cannot be fabricated into audit evidence', () => {
    const owned = mkdtempSync(path.join(tmpdir(), 'SS07-missing-'));
    try {
      const input = {schemaVersion: '1.0.0', target: {identifier: 'SS07-synthetic-missing-source', baseRef: null, files: [{path: 'missing-cli.mjs', digest: hash('')} ]},
        mode: 'repository', profiles: ['cli-mcp'], excluded: [], environment: 'isolated synthetic SS07 boundary',
        authorization: {localReproduction: false, constraints: ['read-only', 'no modifications', 'no active production probing']},
        checks: [{id: 'SS07-traversal', description: 'path traversal'}, {id: 'SS07-authz', description: 'missing permission check'}], providedEvidence: []};
      writeFileSync(path.join(owned, 'request.json'), JSON.stringify(input));
      const command = [path.join(root, 'skills/software-security-auditor/scripts/cli.mjs'), 'snapshot', '--input', path.join(owned, 'request.json'), '--target-root', owned];
      const out = spawnSync(process.execPath, command, {encoding: 'utf8'});
      record('missing-target', {request: input, argv: [process.execPath, ...command]}, 'exit 2 INVALID_INPUT ENOENT; SEC need remains; actual audit NOTRUN', {exit: out.status, stdout: out.stdout, stderr: out.stderr}, 'offline-cli');
      expect(out.status).toBe(2); expect(JSON.parse(out.stdout).code).toBe('INVALID_INPUT'); expect(JSON.parse(out.stdout).errors[0]).toContain('ENOENT');
      expect(fixture.oracle.required).toEqual([sec]);
    } finally {rmSync(owned, {recursive: true, force: true});}
  });
  it('SS07 complete investigation can contain a vulnerability; reproduction remains unauthorized', () => {
    const owned = mkdtempSync(path.join(tmpdir(), 'SS07-report-')); const source = 'export function unsafePath(input) { return input; }\n';
    try {
      writeFileSync(path.join(owned, 'cli.mjs'), source);
      const input = {schemaVersion: '1.0.0', target: {identifier: 'SS07-synthetic-contract-only', baseRef: null, files: [{path: 'cli.mjs', digest: digestBytes(source)}]},
        mode: 'repository', profiles: ['cli-mcp'], excluded: [], environment: 'isolated synthetic SS07 boundary',
        authorization: {localReproduction: false, constraints: ['read-only']}, checks: [{id: 'SS07-traversal', description: 'path traversal'}, {id: 'SS07-authz', description: 'missing permission checks'}], providedEvidence: []};
      const report: any = {schemaVersion: '1.0.0', request: input, requestDigest: digest(input), targetDigest: targetDigest(input), status: 'complete',
        threatModel: {assets: ['synthetic file'], actors: ['synthetic caller'], entrypoints: ['synthetic function'], trustBoundaries: ['input/effect']},
        checks: input.checks.map(c => ({id: c.id, status: 'checked', method: 'static-analysis', evidenceRefs: ['E1'], observation: 'synthetic assertion of inspection; no real audit'})),
        findings: [{id: 'F1', status: 'confirmed', severity: 'high', checkIds: ['SS07-traversal'], locations: [{path: 'cli.mjs', line: 1}], preconditions: 'synthetic test condition',
          attackPath: 'synthetic contract fixture', impact: 'synthetic', defenseReview: 'synthetic', evidenceRefs: ['E1'], proof: 'static-analysis', remediation: 'synthetic', retest: 'synthetic'}],
        evidence: [{id: 'E1', path: 'cli.mjs', digest: digestBytes(source), targetDigest: targetDigest(input), kind: 'source', description: 'test-only source'}], limitations: []};
      const complete = validateReport(input, report, {targetRoot: owned, evidenceRoot: owned});
      report.checks[0].method = 'local-reproduction'; const unauthorized = validateSemantics(report);
      report.checks.forEach((c: any) => Object.assign(c, {status: 'not-checked', method: 'not-executed', evidenceRefs: [], observation: 'missing target'}));
      report.findings = []; report.evidence = []; report.status = 'blocked'; report.limitations = ['actual SS07 audit target not supplied'];
      const blocked = validateSemantics(report), schemaValid = validateReportSchema(report);
      record('investigation-not-safety', input, 'complete accepts high finding; unauthorized reproduction rejected; blocked accepted', {complete, unauthorized, blocked, schemaValid}, 'offline-contract');
      expect(complete).toEqual([]); expect(unauthorized).toContain('UNAUTHORIZED_REPRODUCTION'); expect(blocked).toEqual([]); expect(schemaValid).toBe(true);
    } finally {rmSync(owned, {recursive: true, force: true});}
  });
  it('SS07 DEFECT existing metadata-condition-duplication: applicability and exclusions must differ', () => {
    const meta = inventory.skills.find((s: any) => s.skillId === sec);
    record('known-metadata-condition-duplication', {classificationPath: 'skills/software-security-auditor/classification.json'}, 'applicability/exclusion clauses separately represented',
      {applicability: meta.applicability, exclusions: meta.exclusions, identical: JSON.stringify(meta.applicability) === JSON.stringify(meta.exclusions)}, 'offline-static');
    expect(meta.applicability).not.toEqual(meta.exclusions);
  });
  it('SS07 DEFECT existing valid-cost-lost-on-invalid-RESP: known cost must survive invalid recommendation', async () => {
    const f = support(async (req: any) => {const bad = response(req); bad.judgments = bad.judgments.filter((j: any) => j.skillId !== sec);
      return {response: bad, usage: {...unknownUsage(), actualCostUsd: 0.1}, dispatchState: 'started', diagnostics: null};});
    const out = await f.service.classify(f.input);
    record('known-valid-cost-loss', {missingJudgment: sec, suppliedUsage: {actualCostUsd: 0.1}}, 'INVALID_PROVIDER_RESPONSE, actualCostUsd=0.1; settle known cost', {result: out, budget: f.budget.snapshot()});
    expect(out.response.error?.code).toBe('INVALID_PROVIDER_RESPONSE'); expect(out.attempts[0]?.usage.actualCostUsd).toBe(0.1);
    expect(f.budget.snapshot().limits['vendor:offline-test'].spentUsd).toBe(0.1);
  });
  it('SS07 DEFECT existing timeout-overflow: reject 2147483648 before dispatch', async () => {
    const f = support(async () => new Promise<any>(() => {})); f.input.config.timeoutMs = 2 ** 31;
    const out = await f.service.classify(f.input);
    record('known-timeout-overflow', {timeoutMs: 2 ** 31, originalPrompt: fixture.originalPrompt}, 'INVALID_TIMEOUT; attempts=[], provider calls=0', {result: out, mockCalls: f.provider.classify.mock.calls.length});
    expect(out.response.error?.code).toBe('INVALID_TIMEOUT'); expect(out.attempts).toEqual([]); expect(f.provider.classify).not.toHaveBeenCalled();
  });
  it('SS07 API guard stayed at zero', () => {record('API0', {guard: 'global fetch throws; no native CLI/provider transports configured'}, 0, apiAttempts); expect(apiAttempts).toBe(0);});
});
