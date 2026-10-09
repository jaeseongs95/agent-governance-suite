import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// This suite is SS36 evaluator verification, never a semantic run of SS14.
// The existing fixed pair API requires a representative key; only one offline
// pair is supplied. Synthetic receipts are deliberately marked MOCK and never
// promoted to evidence of an actual AGENT selection.
const evidenceRoot = fileURLToPath(new URL('../', import.meta.url));
const pinnedRepo = process.env.SS36_PINNED_REPO;
if (!pinnedRepo) throw new Error('SS36_PINNED_REPO must point to the pinned candidate checkout');
const evaluatorPath = process.env.SS36_EVALUATOR_PATH ?? resolve(pinnedRepo, 'tests/skill-classification/evaluation.ts');
const { aggregate, evaluateLayers, scoreCase, scorePairs, sameSet, oracleDigest } = await import(pathToFileURL(evaluatorPath).href);
const corpus = JSON.parse(readFileSync(resolve(pinnedRepo, 'tests/skill-classification/fixtures.json'), 'utf8'));
const target = corpus.cases.find((x: any) => x.caseId === 'SS36');
const control = JSON.parse(readFileSync(resolve(evidenceRoot, 'SS36.control-oracle.json'), 'utf8'));
const inventory = control.inventorySkillIds;
const R = control.oracle.required;
const F = control.oracle.forbidden;
const probe = {caseId: 'SS36-evaluator-control', familyId: 'mechanical-SS36', oracle: control.oracle};
const variants: Record<string, unknown> = {};
const boundaries: Record<string, unknown> = {};
const summarize = (x: any) => ({denominator: x.denominator, executed: x.executed, passes: x.passes,
  failures: x.failures, blocked: x.blocked, notRun: x.notRun, requiredTotal: x.requiredTotal,
  requiredHits: x.requiredHits, requiredRecall: x.requiredRecall, truePositives: x.truePositives,
  falsePositives: x.falsePositives, unadjudicatedCount: x.unadjudicatedCount, precision: x.precision,
  unnecessarySelections: x.unnecessarySelections, forbiddenViolations: x.forbiddenViolations,
  forbiddenViolationRate: x.forbiddenViolationRate, exactPurposeSuccessRate: x.exactPurposeSuccessRate,
  coverage: x.coverage, abstentions: x.abstentions, abstentionRate: x.abstentionRate,
  unnecessaryAbstentionRate: x.unnecessaryAbstentionRate, stageCoverage: x.stageCoverage,
  verdict: x.verdict, scores: x.scores});
function mock(id: string, skillIds: string[] | null, layer = 'jevRaw', host = 'codex', state = 'PASS'): any {
  return {caseId: id, layer, state, skillIds, selectionStatus: skillIds === null ? 'NEEDS_INPUT' : 'SELECTED',
    reasonCodes: [], selectionReasons: [], executionKind: 'offline-mock', host,
    hostReceipt: layer === 'selected' && skillIds !== null ? {receiptId: 'MOCK-NOT-HOST-EVIDENCE', host,
      requestDigest: 'mock-request', inventoryDigest: 'mock-inventory', agentSelectedSkillIds: skillIds,
      acceptedAt: '2000-01-01T00:00:00Z'} : null,
    requestDigest: 'mock-request', inventoryDigest: 'mock-inventory', conditionDigest: 'mock-condition',
    stageEvidence: {read: false, applied: false, verified: false}};
}
function checkVariant(id: string, cases: any[], observations: any[], expected: any, layer = 'jevRaw') {
  const observed = summarize(aggregate(cases, observations, layer, inventory));
  variants[id] = {input: {cases, observations}, expected, observed, executionKind: 'offline-mock'};
  expect(observed).toMatchObject(expected);
}
afterAll(() => writeFileSync(process.env.SS36_OBSERVATIONS_PATH ?? resolve(evidenceRoot, 'SS36.observations.json'),
  JSON.stringify({caseId: 'SS36', oracle: null, semanticAccuracy: null, controlOracleProvenance: control.provenance,
    variants, boundaries, apiCalls: {jev: 0, externalVendor: 0, claude: 0},
    actualHostStages: {selected: 'NOTRUN', read: 'NOTRUN', applied: 'NOTRUN', verified: 'NOTRUN'}}, null, 2) + '\n'));

describe('SS36 isolated offline evaluator verification', () => {
  it('preserves frozen fixture, null oracle and exact variant list', () => {
    expect(createHash('sha256').update(readFileSync(resolve(pinnedRepo, 'tests/skill-classification/fixtures.json'))).digest('hex'))
      .toBe('17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
    expect(oracleDigest(corpus)).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
    expect(target.originalPrompt).toBeNull(); expect(target.oracle).toBeNull();
    expect(target.variants).toEqual(['select-all', 'required-only', 'missing-required', 'forbidden-extra', 'both-hosts-wrong', 'all-abstain', 'failure-denominators']);
    expect(R).toEqual(['cs-engineering', 'test-engineering', 'orchestrator']);
    expect(F).toEqual(['ponytail']);
    expect(() => scoreCase(target, undefined, inventory)).toThrow('NO_SEMANTIC_ORACLE:SS36');
    const withoutSemanticOracle = aggregate([target], [], 'jevRaw', inventory);
    expect(withoutSemanticOracle.denominator).toBe(0); expect(withoutSemanticOracle.requiredRecall).toBeNull();
    expect(withoutSemanticOracle.precision).toBeNull(); expect(withoutSemanticOracle.verdict).toBe('INCOMPLETE_OR_FAIL');
    boundaries['no-SS36-semantic-oracle'] = summarize(withoutSemanticOracle);
  });
  it('select-all: recall one still fails with forbidden and unadjudicated extras', () => {
    checkVariant('select-all', [probe], [mock(probe.caseId, inventory)], {denominator: 1, requiredTotal: 3,
      requiredHits: 3, requiredRecall: 1, truePositives: 3, falsePositives: 4, unadjudicatedCount: 17,
      precision: null, unnecessarySelections: 3, forbiddenViolations: 1, forbiddenViolationRate: 1,
      passes: 0, failures: 1, exactPurposeSuccessRate: 0, coverage: 1, verdict: 'INCOMPLETE_OR_FAIL'});
  });
  it('required-only: exact required set passes', () => {
    checkVariant('required-only', [probe], [mock(probe.caseId, R)], {denominator: 1, requiredHits: 3,
      requiredRecall: 1, precision: 1, falsePositives: 0, unadjudicatedCount: 0, unnecessarySelections: 0,
      forbiddenViolations: 0, exactPurposeSuccessRate: 1, coverage: 1, passes: 1, verdict: 'PASS'});
  });
  it('missing-required: each omitted required ID is counted', () => {
    checkVariant('missing-required', [probe], [mock(probe.caseId, ['orchestrator'])], {
      denominator: 1, requiredHits: 1, requiredRecall: 1 / 3, precision: 1, failures: 1,
      exactPurposeSuccessRate: 0, scores: [{missingRequired: ['cs-engineering', 'test-engineering'], verdict: 'FAIL'}],
      verdict: 'INCOMPLETE_OR_FAIL'});
  });
  it('forbidden-extra: same R with one forbidden ID fails', () => {
    checkVariant('forbidden-extra', [probe], [mock(probe.caseId, [...R, 'ponytail'])], {
      denominator: 1, requiredHits: 3, requiredRecall: 1, truePositives: 3, falsePositives: 1, precision: 0.75,
      forbiddenViolations: 1, forbiddenViolationRate: 1, failures: 1, exactPurposeSuccessRate: 0,
      scores: [{forbidden: ['ponytail'], verdict: 'FAIL'}], verdict: 'INCOMPLETE_OR_FAIL'});
  });
  it('both-hosts-wrong: agreement one does not pass purpose quality', () => {
    const pairCase = {...probe, caseId: 'SS14'}; // Fixed API key only, no SS14 semantic run.
    const trial = {pairId: 'SS14/jev-on/1', caseId: 'SS14', path: 'jev-on', repetition: 1,
      codex: mock('SS14', ['cs-engineering'], 'selected', 'codex'),
      claude: mock('SS14', ['cs-engineering'], 'selected', 'claude')};
    const report = scorePairs([trial], [pairCase], inventory);
    const observed = {suppliedPairs: report.suppliedPairs, comparedPairs: report.comparedPairs,
      exactSetAgreement: report.exactSetAgreement, completedPurposeRate: report.completedPurposeRate,
      issues: report.issues, record: report.records.find((x: any) => x.pairId === trial.pairId), verdict: report.verdict};
    const expected = {suppliedPairs: 1, comparedPairs: 1, exactSetAgreement: 1, completedPurposeRate: 0, issues: [],
      record: {status: 'FAIL', codexGolden: 'FAIL', claudeGolden: 'FAIL'}, verdict: 'INCOMPLETE_OR_FAIL'};
    variants['both-hosts-wrong'] = {input: {cases: [pairCase], trial}, expected, observed, executionKind: 'offline-mock',
      note: 'Other 119 fixed matrix slots untouched; no host calls. Mock receipts do not establish actual selected evidence.'};
    expect(observed).toMatchObject(expected);
  });
  it('all-abstain: every answerable probe remains in denominator', () => {
    const cases = [probe, {...probe, caseId: 'SS36-evaluator-control-2'}];
    checkVariant('all-abstain', cases, cases.map(x => mock(x.caseId, null)), {denominator: 2,
      requiredTotal: 6, requiredHits: 0, requiredRecall: 0, precision: null, passes: 0, failures: 2,
      coverage: 0, abstentions: 2, abstentionRate: 1, unnecessaryAbstentionRate: 1,
      exactPurposeSuccessRate: 0, verdict: 'INCOMPLETE_OR_FAIL'});
  });
  it('failure-denominators: PASS, FAIL, BLOCKED, explicit NOT_RUN and missing all stay', () => {
    const cases = Array.from({length: 5}, (_, i) => ({...probe, caseId: `SS36-denominator-${i}`}));
    const observations = [mock(cases[0].caseId, R), mock(cases[1].caseId, null, 'jevRaw', 'codex', 'FAIL'),
      mock(cases[2].caseId, null, 'jevRaw', 'codex', 'BLOCKED'), mock(cases[3].caseId, null, 'jevRaw', 'codex', 'NOT_RUN')];
    checkVariant('failure-denominators', cases, observations, {denominator: 5, executed: 3,
      requiredTotal: 15, requiredHits: 3, requiredRecall: 0.2, passes: 1, failures: 1, blocked: 1, notRun: 2,
      coverage: 0.2, abstentions: 0, abstentionRate: 0, exactPurposeSuccessRate: 0.2, verdict: 'INCOMPLETE_OR_FAIL'});
  });
  it('boundary: raw, vendor fallback, combined and selected remain separately scored', () => {
    const observations = [mock(probe.caseId, ['cs-engineering']), mock(probe.caseId, ['cs-engineering'], 'vendorRaw'),
      mock(probe.caseId, R, 'combined'), mock(probe.caseId, R, 'selected')];
    const observed = evaluateLayers([probe], observations, inventory);
    const expected = {jevRaw: {requiredRecall: 1 / 3, verdict: 'INCOMPLETE_OR_FAIL'},
      vendorRaw: {requiredRecall: 1 / 3, verdict: 'INCOMPLETE_OR_FAIL'}, combined: {requiredRecall: 1, verdict: 'PASS'},
      selected: {requiredRecall: 1, verdict: 'PASS', stageCoverage: {read: 0, applied: 0, verified: 0}}};
    boundaries['layer-separation'] = {input: observations, expected, observed}; expect(observed).toMatchObject(expected);
  });
  it('boundary: every layer retains answer, abstention, failure, blocked and missing denominators', () => {
    const cases = Array.from({length: 5}, (_, i) => ({...probe, caseId: `SS36-layer-denominator-${i}`}));
    const observations = ['jevRaw', 'vendorRaw', 'combined', 'selected'].flatMap(layer => [
      mock(cases[0].caseId, R, layer), mock(cases[1].caseId, null, layer),
      mock(cases[2].caseId, null, layer, 'codex', 'FAIL'),
      mock(cases[3].caseId, null, layer, 'codex', 'BLOCKED')]);
    const observed = evaluateLayers(cases, observations, inventory);
    const expected = {denominator: 5, executed: 4, passes: 1, failures: 2, blocked: 1, notRun: 1,
      requiredTotal: 15, requiredHits: 3, requiredRecall: 0.2, coverage: 0.2,
      abstentions: 1, abstentionRate: 0.2, unnecessaryAbstentionRate: 0.2,
      exactPurposeSuccessRate: 0.2, verdict: 'INCOMPLETE_OR_FAIL'};
    boundaries['all-layer-failure-denominators'] = {input: {cases, observations}, expected, observed};
    for (const layer of ['jevRaw', 'vendorRaw', 'combined', 'selected']) expect(observed[layer]).toMatchObject(expected);
  });
  it('boundary: null and [] remain different on answerable and no-skill controls', () => {
    expect(sameSet(null, [])).toBe(false);
    const noSkill = {...probe, caseId: 'SS36-empty-control', oracle: corpus.cases.find((x: any) => x.caseId === 'SS09').oracle};
    const emptyObservation = mock(noSkill.caseId, []);
    const nullObservation = mock(noSkill.caseId, null);
    const observed = {empty: scoreCase(noSkill, emptyObservation, inventory), unknown: scoreCase(noSkill, nullObservation, inventory)};
    const expected = {empty: {verdict: 'PASS', answered: true, abstained: false},
      unknown: {verdict: 'FAIL', answered: false, abstained: true, unnecessaryAbstention: true}};
    boundaries['null-versus-empty'] = {input: {noSkill, emptyObservation, nullObservation}, expected, observed};
    expect(observed).toMatchObject(expected);
  });
  it('boundary: selection without receipt has zero stage coverage', () => {
    const observation = {...mock(probe.caseId, R, 'selected'), hostReceipt: null,
      stageEvidence: {read: true, applied: true, verified: true}};
    const observed = summarize(aggregate([probe], [observation], 'selected', inventory));
    const expected = {coverage: 0, failures: 1, stageCoverage: {read: 0, applied: 0, verified: 0},
      scores: [{verdict: 'FAIL', reasons: ['HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH']}], verdict: 'INCOMPLETE_OR_FAIL'};
    boundaries['receipt-absence'] = {input: observation, expected, observed}; expect(observed).toMatchObject(expected);
  });
});
