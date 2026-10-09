import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadSkillInventory } from '../../mcp-server/src/skill-classification/inventory.js';
import { createClassificationRequest, digestClassificationValue, projectClassificationRequest } from '../../mcp-server/src/skill-classification/request.js';
import { validateClassificationResponse, validateDecision } from '../../mcp-server/src/skill-classification/validation.js';
import { RuntimeSkillClassificationGateway, readClassificationRuntime } from '../../mcp-server/src/skill-classification/gateway.js';
import { oracleDigest, scoreCase, sameSet } from './evaluation.js';
import type { ClassificationResult, SkillInventory, SkillSelectionDecisionV1 } from '../../mcp-server/src/skill-classification/types.js';

// SS15 ONLY. All decisions/receipts below are test inputs, never actual AGENT selection.
// No provider object, fetch, native CLI, credential read or host API is invoked.
const root = path.resolve(import.meta.dirname, '../..');
const out = process.env.SS15_EVIDENCE_OUTPUT ?? 'ss15-output';
const bytes = readFileSync(path.join(root, 'tests/skill-classification/fixtures.json'));
const corpus = JSON.parse(bytes.toString('utf8'));
const fixture = corpus.cases.find((row: any) => row.caseId === 'SS15');
const witnesses: any[] = [];
let inventory: SkillInventory;
beforeAll(async () => { inventory = await loadSkillInventory({ root }); expect(inventory.issues).toEqual([]); });
afterAll(() => { writeFileSync(path.join(out, 'SS15.witnesses.json'), JSON.stringify(witnesses, null, 2) + '\n'); });
function record(id: string, variant: string, input: unknown, expected: unknown, observed: unknown) {
  witnesses.push({ id, variant, executionKind: 'offline-mock', input, expected, observed,
    stages: { selected: 'NOTRUN', read: 'NOTRUN', applied: 'NOTRUN', verified: 'NOTRUN' },
    apiCalls: { jev: 0, externalVendor: 0, claude: 0, actualHost: 0 } });
}
function subject(variant: 'typo' | 'disabled' | 'unsupported', needed = variant !== 'typo') {
  const inv = structuredClone(inventory);
  const cs = inv.skills.find(s => s.skillId === 'cs-engineering')!;
  if (variant === 'disabled') cs.enabled = false;
  if (variant === 'unsupported') cs.hostSupported = false;
  // Synthetic state is explicitly part of the new inventory digest, never mutate product files.
  inv.inventoryDigest = digestClassificationValue({ syntheticVariant: variant, skills: inv.skills });
  const request = createClassificationRequest({ requestId: `ss15/${variant}`, operationId: `ss15/${variant}`,
    originalPrompt: variant === 'typo' ? fixture.originalPrompt : '$cs-engineering 으로 검토해 줘.', inventory: inv,
    classificationCriteriaRef: 'skills/orchestrator/references/skill-classification.md' });
  const result: ClassificationResult = { request, response: { schemaVersion: '1.0.0', requestId: request.requestId,
    operationId: request.operationId, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest,
    status: 'SUCCESS', judgments: request.skills.map(s => ({ skillId: s.skillId,
      judgment: needed && s.skillId === 'cs-engineering' ? 'needed' : 'not-needed',
      reasonRefs: ['offline:controlled-provider-advice'], uncertaintyReason: null })), unresolvedItems: [], error: null },
    config: { jevEnabled: false, mode: 'select', providerProfileRegistryRef: 'offline:unused', externalClassificationAllowed: false,
      configRevision: 'offline-c1', timeoutMs: 1000 }, profileRevision: 'offline-p1', attempts: [],
    snapshot: { taskRevision: null, configRevision: 'offline-c1', profileRevision: 'offline-p1',
      inventoryDigest: request.inventoryDigest, requestDigest: request.requestDigest, cancelled: false } };
  return result;
}
function decision(result: ClassificationResult, variant: string, selected: string[] | null, status: SkillSelectionDecisionV1['selectionStatus']): SkillSelectionDecisionV1 {
  return { schemaVersion: '1.0.0', classificationResponseRef: digestClassificationValue(result.response), ...result.snapshot,
    // cancelled belongs to the snapshot only; removed below by construction.
    explicitSkillIds: variant === 'typo' ? [] : ['cs-engineering'], ruleRequiredSkillIds: [], agentSelectedSkillIds: selected,
    selectionReasons: (selected ?? []).map(skillId => ({ skillId, reason: 'SYNTHETIC TEST INPUT ONLY' })),
    applicabilityChecks: (selected ?? []).map(skillId => ({ skillId, applies: true, excluded: false, reasonRefs: ['embedded:SS15'] })),
    unresolvedSkillReferences: variant === 'typo' ? [{ reference: '$cs-enginering', reason: 'unknown-explicit-skill' }] : [],
    selectionStatus: status, adviceApplied: false,
    hostReceipt: selected === null ? null : { receiptId: 'SYNTHETIC-UNIT-ONLY', host: 'mock', requestDigest: result.request.requestDigest,
      inventoryDigest: result.request.inventoryDigest, agentSelectedSkillIds: selected, acceptedAt: '2000-01-01T00:00:00Z' } } as any;
}
function cleanDecision(...args: Parameters<typeof decision>): SkillSelectionDecisionV1 {
  const d = decision(...args); Reflect.deleteProperty(d, 'cancelled'); return d;
}

describe('SS15 isolated offline development', () => {
  it('SS15 binding: exact frozen bytes and embedded-only specification', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
    expect(oracleDigest(corpus)).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
    expect(fixture.variants).toEqual(['typo', 'disabled', 'unsupported']);
    expect(inventory.skills.some(s => s.skillId === 'cs-enginering')).toBe(false);
    record('binding', 'all', fixture, { fixtureAndOracleShaMatch: true }, { skills: inventory.skills.map(s => s.skillId) });
  });
  for (const variant of ['typo', 'disabled', 'unsupported'] as const) {
    it(`SS15 ${variant}: full request/projection preserve original prompt, state, unknown null`, () => {
      const r = subject(variant), projection = projectClassificationRequest(r.request);
      const expected = { originalPrompt: r.request.originalPrompt, allSkills: inventory.skills.map(s => s.skillId),
        confirmedContext: { taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null } };
      record(`${variant}-projection`, variant, r.request, expected, projection);
      expect(projection.payload.originalPrompt).toBe(expected.originalPrompt);
      expect(projection.payload.skills.map(s => s.skillId)).toEqual(expected.allSkills);
      expect(projection.payload.confirmedContext).toEqual(expected.confirmedContext);
      expect(projection.payload.skills.find(s => s.skillId === 'cs-engineering')![variant === 'disabled' ? 'enabled' : 'hostSupported']).toBe(variant === 'typo');
      expect(validateClassificationResponse(r.request, r.response)).toEqual([]);
    });
  }
  it('SS15 typo: correct unresolved null is supported without receipt or completion', () => {
    const r = subject('typo'), d = cleanDecision(r, 'typo', null, 'NEEDS_INPUT'), checked = validateDecision(r, d, r.snapshot);
    record('typo-unresolved-null', 'typo', { request: r.request, decision: d }, { valid: true, selected: null, runnable: [] }, checked);
    expect(checked.valid).toBe(true); expect(d.agentSelectedSkillIds).toBeNull(); expect(d.hostReceipt).toBeNull();
    expect(d.unresolvedSkillReferences).toEqual([{ reference: '$cs-enginering', reason: 'unknown-explicit-skill' }]);
    expect(checked.runnableSkillIds).toEqual([]); expect(sameSet(null, [])).toBe(false);
  });
  it('SS15 typo: exact unregistered ID cannot become runnable', () => {
    const r = subject('typo'), d = cleanDecision(r, 'typo', ['cs-enginering'], 'PARTIAL');
    const checked = validateDecision(r, d, r.snapshot);
    record('typo-unknown-id', 'typo', { request: r.request, decision: d }, { valid: false, error: 'UNKNOWN_SELECTED_SKILL:cs-enginering' }, checked);
    expect(checked.valid).toBe(false); expect(checked.errors).toContain('UNKNOWN_SELECTED_SKILL:cs-enginering');
    // Invalid validation output may contain candidate IDs; callers must check valid before use.
  });
  it('SS15 typo boundary: silently corrected canonical selection must be rejected', () => {
    const r = subject('typo'), d = cleanDecision(r, 'typo', ['cs-engineering'], 'SELECTED'); d.unresolvedSkillReferences = [];
    const checked = validateDecision(r, d, r.snapshot);
    record('typo-silent-correction', 'typo', { request: r.request, decision: d }, { valid: false }, checked);
    expect(checked.valid, 'SS15 forbids silent adoption of corrected ID; validator currently trusts AGENT-supplied unresolved list').toBe(false);
  });
  it('SS15 typo boundary: unresolved correction candidate must not become runnable through PARTIAL', () => {
    const r = subject('typo'), d = cleanDecision(r, 'typo', ['cs-engineering'], 'PARTIAL');
    const checked = validateDecision(r, d, r.snapshot);
    record('typo-partial-adoption', 'typo', { request: r.request, decision: d }, { valid: false, runnable: [] }, checked);
    expect(checked.valid, 'Correction candidate is allowed only as a question, without adoption').toBe(false);
  });
  for (const variant of ['disabled', 'unsupported'] as const) {
    const reasonCode = variant === 'disabled' ? 'DISABLED' : 'HOST_UNSUPPORTED';
    it(`SS15 ${variant}: PARTIAL preserves needed and reports blocked runnable`, () => {
      const r = subject(variant), d = cleanDecision(r, variant, ['cs-engineering'], 'PARTIAL');
      const checked = validateDecision(r, d, r.snapshot);
      record(`${variant}-partial`, variant, { request: r.request, decision: d }, { valid: true, needed: ['cs-engineering'], runnable: [], blocked: [{ skillId: 'cs-engineering', reasonCode }] }, checked);
      expect(checked.valid).toBe(true); expect(checked.neededSkillIds).toContain('cs-engineering'); expect(checked.runnableSkillIds).toEqual([]);
      expect(checked.blockedItems).toEqual([{ skillId: 'cs-engineering', reasonCode }]);
      d.selectionStatus = 'SELECTED'; expect(validateDecision(r, d, r.snapshot).errors).toContain('UNRESOLVED_SELECTION_MARKED_COMPLETE');
    });
    it(`SS15 ${variant}: explicit need survives negative provider advice`, () => {
      const r = subject(variant, false), d = cleanDecision(r, variant, ['cs-engineering'], 'PARTIAL');
      const checked = validateDecision(r, d, r.snapshot);
      record(`${variant}-negative-advice`, variant, { request: r.request, decision: d }, { needed: ['cs-engineering'], blocked: [{ skillId: 'cs-engineering', reasonCode }] }, checked);
      expect(checked.neededSkillIds).toContain('cs-engineering'); expect(checked.blockedItems).toContainEqual({ skillId: 'cs-engineering', reasonCode });
    });
    it(`SS15 ${variant} boundary: null NEEDS_INPUT must preserve unavailable reason`, () => {
      const r = subject(variant), d = cleanDecision(r, variant, null, 'NEEDS_INPUT');
      const checked = validateDecision(r, d, r.snapshot);
      record(`${variant}-null-blocked`, variant, { request: r.request, decision: d }, { needed: ['cs-engineering'], runnable: [], blocked: [{ skillId: 'cs-engineering', reasonCode }] }, checked);
      expect(checked.neededSkillIds).toContain('cs-engineering'); expect(checked.runnableSkillIds).toEqual([]);
      expect(checked.blockedItems, 'Availability reporting currently loops only over selected IDs').toContainEqual({ skillId: 'cs-engineering', reasonCode });
    });
  }
  it('SS15 unsupported boundary: gateway inventory must receive host-supported IDs', async () => {
    const supported = inventory.skills.map(s => s.skillId).filter(id => id !== 'cs-engineering');
    const direct = await loadSkillInventory({ root, hostSupportedSkillIds: supported });
    const runtime = await readClassificationRuntime(undefined, root);
    const gateway = new RuntimeSkillClassificationGateway({ root, service: {} as any, readRuntime: async () => runtime });
    const fromGateway = await gateway.inventory() as SkillInventory;
    record('unsupported-host-state-gap', 'unsupported', { hostSupportedSkillIds: supported }, { gatewayCsHostSupported: false }, {
      directCsHostSupported: direct.skills.find(s => s.skillId === 'cs-engineering')!.hostSupported,
      gatewayCsHostSupported: fromGateway.skills.find(s => s.skillId === 'cs-engineering')!.hostSupported,
      directDigest: direct.inventoryDigest, gatewayDigest: fromGateway.inventoryDigest });
    expect(direct.skills.find(s => s.skillId === 'cs-engineering')!.hostSupported).toBe(false);
    expect(fromGateway.skills.find(s => s.skillId === 'cs-engineering')!.hostSupported,
      'Known host-active-state supply gap: gateway has no hostSupportedSkillIds input').toBe(false);
  });
  it('SS15 gateway: classification is PROPOSED; missing real host cannot accept; no admission claimed', async () => {
    const runtime = await readClassificationRuntime(undefined, root);
    let controlledCalls = 0;
    const service = { classify: async ({ request, config, registry }: any) => {
      controlledCalls++;
      return { ...subject('typo'), request, config, profileRevision: registry.profileRevision,
        response: { ...subject('typo').response, requestId: request.requestId, operationId: request.operationId,
          requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest },
        snapshot: { taskRevision: null, configRevision: config.configRevision, profileRevision: registry.profileRevision,
          inventoryDigest: request.inventoryDigest, requestDigest: request.requestDigest, cancelled: false } };
    } };
    const gateway = new RuntimeSkillClassificationGateway({ root, service: service as any, readRuntime: async () => runtime });
    const input = { schemaVersion: '1.0.0', requestId: 'ss15/gateway', operationId: 'ss15/gateway', originalPrompt: fixture.originalPrompt,
      confirmedContext: subject('typo').request.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [],
      vendorContext: { vendorId: 'offline-only', reference: 'offline:stub' }, publicSynthetic: true };
    const advice = await gateway.classify(input) as any;
    const d = cleanDecision(advice.result, 'typo', null, 'NEEDS_INPUT');
    const checked = await gateway.accept({ schemaVersion: '1.0.0', operationId: input.operationId, decision: d }, null) as any;
    record('gateway-no-real-host', 'typo', input, { selected: null, selectionStatus: 'PROPOSED', valid: false, admissionStatusFieldPresent: false }, { advice, checked, controlledStubCalls: controlledCalls });
    expect(advice.agentSelectedSkillIds).toBeNull(); expect(advice.selectionStatus).toBe('PROPOSED');
    expect(checked.valid).toBe(false); expect(checked.errors).toContain('HOST_SELECTION_NOT_OBSERVED');
    expect(checked.agentSelectedSkillIds).toBeNull(); expect(checked.admissionStatus).toBeUndefined();
  });
  it('SS15 evaluator local control: typo null versus empty and missing reason remain distinct', () => {
    const base: any = { caseId: 'SS15', layer: 'jevRaw', state: 'PASS', skillIds: null, selectionStatus: 'NEEDS_INPUT',
      reasonCodes: ['unknown-explicit-skill'], selectionReasons: [], executionKind: 'offline-mock', host: null, hostReceipt: null,
      requestDigest: subject('typo').request.requestDigest, inventoryDigest: inventory.inventoryDigest, conditionDigest: 'offline',
      stageEvidence: { read: false, applied: false, verified: false } };
    const good = scoreCase(fixture, base, corpus.inventorySkillIds);
    const empty = scoreCase(fixture, { ...base, skillIds: [] }, corpus.inventorySkillIds);
    const unexplained = scoreCase(fixture, { ...base, reasonCodes: [] }, corpus.inventorySkillIds);
    record('typo-evaluator-null-control', 'typo', base, { good: 'PASS', empty: 'FAIL', unexplained: 'FAIL' }, { good, empty, unexplained });
    expect(good.verdict).toBe('PASS'); expect(empty.verdict).toBe('FAIL'); expect(unexplained.verdict).toBe('FAIL');
  });
});
