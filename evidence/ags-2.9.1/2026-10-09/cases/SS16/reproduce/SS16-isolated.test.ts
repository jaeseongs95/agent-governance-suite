import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadSkillInventory } from '../../mcp-server/src/skill-classification/inventory.js';
import { createClassificationRequest, projectClassificationRequest } from '../../mcp-server/src/skill-classification/request.js';
import { validateClassificationResponse } from '../../mcp-server/src/skill-classification/validation.js';
import { InMemoryClassificationBudget, SkillClassificationService } from '../../mcp-server/src/skill-classification/service.js';
import { digestProviderProfileConfiguration } from '../../mcp-server/src/skill-classification/profiles.js';
import { unknownUsage } from '../../mcp-server/src/skill-classification/providers.js';
import { ContractValidator } from '../../mcp-server/src/schema-validator.js';
import { FileSkillRegistry } from '../../mcp-server/src/registry.js';
import { WorkflowService } from '../../mcp-server/src/workflow-service.js';
import { oracleDigest, sameSet, scoreCase, type Observation } from './evaluation.js';
import type { SkillInventory, SkillClassificationRequestV1, ProviderProfile } from '../../mcp-server/src/skill-classification/types.js';

// Public regression only. Transport is replaced; no host receipt is created.
const corpus = JSON.parse(readFileSync('tests/skill-classification/fixtures.json', 'utf8'));
const fixture = corpus.cases.find((c: { caseId: string }) => c.caseId === 'SS16');
const K = 'korean-prose-editor';
const phases = ['korean-prose-selection', 'korean-prose-editing', 'korean-prose-verification', 'korean-prose-finalization'];
const evidence: Record<string, unknown> = { caseId: 'SS16', executionKind: 'new-offline-variants', externalAPICalls: { jev: 0, vendor: 0, claude: 0 }, variants: {}, boundaries: {}, plans: {} };
let inventory: SkillInventory;
const variants: Record<string, SkillClassificationRequestV1> = {};
const observations = evidence.variants as Record<string, Record<string, unknown>>;
const boundaries = evidence.boundaries as Record<string, unknown>;
function raw(request: SkillClassificationRequestV1, ids: string[] | null, reasons: Observation['selectionReasons'] = []): Observation {
  return { caseId: 'SS16', layer: 'vendorRaw', state: 'PASS', skillIds: ids, selectionStatus: ids === null ? 'NEEDS_INPUT' : 'SELECTED',
    reasonCodes: [], selectionReasons: reasons, executionKind: 'offline-mock', host: null, hostReceipt: null,
    requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, conditionDigest: 'offline-only', stageEvidence: { read: false, applied: false, verified: false } };
}
function response(request: SkillClassificationRequestV1) {
  return { schemaVersion: '1.0.0' as const, requestId: request.requestId, operationId: request.operationId, requestDigest: request.requestDigest,
    inventoryDigest: request.inventoryDigest, status: 'SUCCESS' as const, judgments: request.skills.map(s => ({ skillId: s.skillId,
      judgment: s.skillId === K ? 'needed' as const : 'not-needed' as const, reasonRefs: ['synthetic-fixture-response'], uncertaintyReason: null })), unresolvedItems: [], error: null };
}
function serviceFixture(request: SkillClassificationRequestV1, maximumInputBytes = 200000) {
  const profile: ProviderProfile = { profileId: 'SS16-offline', providerKind: 'vendor', vendorId: 'offline-vendor', modelId: 'mock-only', modelRevision: 'mock-only', reasoningEffort: 'low',
    supportedOptions: { reasoningEfforts: ['low'], structuredOutput: true }, approvedRouteRef: 'mock-only', qualificationRevision: 'synthetic-q1',
    qualification: { status: 'PASS', inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: 'mock-only', promptRevision: 'synthetic-p1', validUntil: '2099-01-01T00:00:00Z', profileConfigurationDigest: '' },
    adapterRevision: 'mock-only', promptRevision: 'synthetic-p1', maximumInputBytes, maximumOutputTokens: 1000, maximumCostUsd: 0.01, judgmentPolicy: null };
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const provider = { availability: vi.fn(async () => ({ available: true, approved: true, routeKind: 'remote' as const, reasonCode: null })),
    classify: vi.fn(async (sent: SkillClassificationRequestV1) => ({ response: response(sent), usage: { ...unknownUsage(), actualCostUsd: 0 }, dispatchState: 'started' as const, diagnostics: null })) };
  const budget = new InMemoryClassificationBudget({ jev: { limitUsd: null, spentUsd: null }, vendors: { 'offline-vendor': { limitUsd: 1, spentUsd: 0 } } });
  const service = new SkillClassificationService({ providers: { vendor: provider }, budget });
  const input = { request, config: { jevEnabled: false, mode: 'select' as const, providerProfileRegistryRef: 'mock-only', externalClassificationAllowed: true, configRevision: 'synthetic-c1', timeoutMs: 1000 },
    registry: { schemaVersion: '1.0.0' as const, profileRevision: 'synthetic-pr1', profiles: [profile] }, currentVendorId: 'offline-vendor' };
  return { service, input, provider, budget };
}
beforeAll(async () => {
  inventory = await loadSkillInventory({ root: process.cwd() });
  const byId = new Map(inventory.skills.map(s => [s.skillId, s]));
  const original = corpus.inventorySkillIds.map((id: string) => byId.get(id)!);
  for (const variant of fixture.variants) {
    const skills = variant === 'original-order' ? original : variant === 'reversed-order' ? [...original].reverse() : [...original.filter((s: {skillId: string}) => s.skillId !== K), byId.get(K)!];
    const request = createClassificationRequest({ requestId: `SS16-${variant}`, operationId: `SS16-${variant}`, originalPrompt: fixture.originalPrompt, inventory: { ...inventory, skills }, classificationCriteriaRef: 'skills/orchestrator/references/skill-classification.md' });
    variants[variant] = request;
    observations[variant] = { originalPrompt: request.originalPrompt, expected: { required: fixture.oracle.required, allowed: fixture.oracle.allowed, allowedConditions: fixture.oracle.allowedConditions, candidateCount: 24, inventoryDigest: inventory.inventoryDigest },
      candidateOrder: skills.map((s: {skillId: string}) => s.skillId), requiredIndex: skills.findIndex((s: {skillId: string}) => s.skillId === K), requestDigest: request.requestDigest,
      inventoryDigest: request.inventoryDigest, selected: 'NOTRUN', selectedSkillIds: null, hostReceipt: null, read: 'NOTRUN', applied: 'NOTRUN', verified: 'NOTRUN', modelSemanticRecommendation: 'NOTRUN' };
  }
});
afterAll(() => writeFileSync('.ss16-offline-output/SS16.observed.json', JSON.stringify(evidence, null, 2) + '\n'));

describe('SS16 only: frozen original and all three variants', () => {
  it('pins fixture, oracle, inventory and relevant source bytes', () => {
    expect(createHash('sha256').update(readFileSync('tests/skill-classification/fixtures.json')).digest('hex')).toBe('17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
    expect(oracleDigest(corpus)).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
    expect(inventory.issues).toEqual([]); expect(inventory.skills).toHaveLength(24);
    expect(inventory.skills.map(s => s.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
    for (const source of fixture.oracle.sourceRefs) expect(`sha256:${createHash('sha256').update(readFileSync(source.path)).digest('hex')}`).toBe(source.digest);
    boundaries.sourceBinding = { status: 'PASS', checkedSourceRefs: fixture.oracle.sourceRefs, issues: inventory.issues };
  });
  for (const variant of fixture.variants) {
    it(`${variant}: preserves every candidate, exact prompt and all four phase dependencies`, () => {
      const request = variants[variant]; const projection = projectClassificationRequest(request);
      expect(projection.payload.originalPrompt).toBe(fixture.originalPrompt);
      expect(projection.payload.skills.map(s => s.skillId)).toEqual(observations[variant].candidateOrder);
      expect(projection.payload.skills).toHaveLength(24);
      for (const skill of request.skills) { const { sourceRefs, sourceMap, ...semantic } = skill; expect(projection.payload.skills.find(s => s.skillId === skill.skillId)).toEqual(semantic); }
      const prose = projection.payload.skills.find(s => s.skillId === K)!;
      expect(prose.phases.map(p => p.capability)).toEqual(phases);
      expect(prose.phases.at(-1)!.inputBindings!.find(b => b.targetArtifact === 'edit-verification-report')!.sources).toEqual(['provider:korean-prose-verification.edit-verification-report']);
      if (variant === 'required-at-tail') expect(projection.payload.skills.at(-1)!.skillId).toBe(K);
      observations[variant].projection = { status: 'PASS', payloadBytes: projection.payloadBytes, candidateCount: projection.payload.skills.length, phases: prose.phases };
    });
    it(`${variant}: service sends full inventory and handles synthetic K advice without AGENT selection`, async () => {
      const f = serviceFixture(variants[variant]); const result = await f.service.classify(f.input);
      expect(result.response.status).toBe('SUCCESS'); expect(f.provider.classify).toHaveBeenCalledTimes(1);
      const sent = f.provider.classify.mock.calls[0][0];
      // Mock receives the public service request; semantic advice is predetermined.
      expect(sent.skills).toEqual(variants[variant].skills); expect(sent.originalPrompt).toBe(fixture.originalPrompt); expect(result).not.toHaveProperty('agentSelectedSkillIds');
      const needed = result.response.judgments.filter(s => s.judgment === 'needed').map(s => s.skillId);
      expect(needed).toEqual([K]);
      expect(scoreCase(fixture, raw(result.request, needed), corpus.inventorySkillIds).verdict).toBe('PASS');
      observations[variant].service = { status: 'PASS', mockCalls: f.provider.classify.mock.calls.length, response: result.response, attempts: result.attempts, semanticQualityClaim: false };
    });
    it(`${variant}: byte limit refuses the whole request without trimming or dispatch`, async () => {
      const request = variants[variant]; const size = projectClassificationRequest(request).payloadBytes;
      expect(projectClassificationRequest(request, size).payload.skills).toHaveLength(24);
      let observed: unknown; try { projectClassificationRequest(request, size - 1); } catch (e) { observed = e; }
      expect(observed).toMatchObject({ message: 'INPUT_TOO_LONG', payloadBytes: size, maximumInputBytes: size - 1, omittedRanges: [] });
      const f = serviceFixture(request, size - 1); const result = await f.service.classify(f.input);
      expect(result.response.error!.code).toBe('INPUT_TOO_LONG'); expect(result.attempts).toEqual([]);
      expect(f.provider.availability).not.toHaveBeenCalled(); expect(f.provider.classify).not.toHaveBeenCalled();
      observations[variant].inputLimit = { status: 'PASS', exactBoundary: size, tooLong: result.response, dispatchCount: 0, omittedRanges: [] };
    });
    it(`${variant}: rejects top-k judgments missing the tail K`, () => {
      const request = variants[variant]; const partial = response(request); partial.judgments = partial.judgments.filter(j => j.skillId !== K);
      const errors = validateClassificationResponse(request, partial);
      expect(errors).toContain('MISSING_CANDIDATE_JUDGMENT');
      const score = scoreCase(fixture, raw(request, []), corpus.inventorySkillIds);
      expect(score.verdict).toBe('FAIL'); expect(score.missingRequired).toEqual([K]);
      observations[variant].omittedK = { status: 'PASS', rejectedResponseErrors: errors, missingRecommendationScore: score };
    });
  }
  it('preserves null versus [] and refuses to promote unobserved host selection', () => {
    expect(sameSet(null, [])).toBe(false);
    const request = variants['original-order'];
    const selected = { ...raw(request, [K]), layer: 'selected' as const };
    const score = scoreCase(fixture, selected, corpus.inventorySkillIds);
    expect(score.verdict).toBe('FAIL'); expect(score.reasons).toContain('HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH');
    expect(scoreCase(fixture, undefined, corpus.inventorySkillIds).verdict).toBe('NOT_RUN');
    boundaries.unobservedHost = { status: 'PASS', observedReceipt: null, negativeControl: score, nullAndEmptyEqual: false };
  });
  it('rejects orchestrator with an unrelated conditional reason (expected defect)', () => {
    const reason = '아무 관계 없는 사유';
    const score = scoreCase(fixture, raw(variants['original-order'], [K, 'orchestrator'], [{ skillId: 'orchestrator', reason }]), corpus.inventorySkillIds);
    const noReason = scoreCase(fixture, raw(variants['original-order'], [K, 'orchestrator']), corpus.inventorySkillIds);
    const linked = scoreCase(fixture, raw(variants['original-order'], [K, 'orchestrator'], [{ skillId: 'orchestrator', reason: 'Link korean-prose-selection, korean-prose-editing, korean-prose-verification, korean-prose-finalization in dependency order.' }]), corpus.inventorySkillIds);
    boundaries.conditionalReason = { expected: 'FAIL', observed: score, reason, noReason, linked, status: score.verdict === 'FAIL' ? 'PASS' : 'FAIL' };
    expect(noReason.verdict).toBe('FAIL'); expect(linked.verdict).toBe('PASS'); expect(score.verdict).toBe('FAIL');
  });
  it('retains valid known usage when SS16 response omits K (known cost-loss defect)', async () => {
    const f = serviceFixture(variants['required-at-tail']); const bad = response(f.input.request); bad.judgments = bad.judgments.filter(j => j.skillId !== K);
    f.provider.classify.mockResolvedValue({ response: bad, usage: { ...unknownUsage(), actualCostUsd: 0.003 }, dispatchState: 'started', diagnostics: null });
    const result = await f.service.classify(f.input); const budget = f.budget.snapshot();
    boundaries.invalidResponseKnownCost = { expectedCostUsd: 0.003, observed: result.attempts, budget, status: result.attempts[0].usage.actualCostUsd === 0.003 ? 'PASS' : 'FAIL', knownFinding: 'valid-cost-lost-with-invalid-response' };
    expect(result.response.error!.code).toBe('INVALID_PROVIDER_RESPONSE'); expect(result.attempts[0].usage.actualCostUsd).toBe(0.003);
  });
  for (const capability of phases) it(`offline plan requested ${capability}: expands to four phases and one unique skill`, () => {
    const validator = new ContractValidator(); const service = new WorkflowService(new FileSkillRegistry('skills/registry.json', validator), validator);
    const plan = service.planWorkflow({ schemaVersion: '1.0.0', taskId: `SS16-${capability}`, objective: fixture.originalPrompt,
      scope: { included: ['Korean announcement'], excluded: ['publication'] }, acceptanceCriteria: ['Preserve facts, numbers, links and claim strength'], riskLevel: 'low', workUnits: [], requiredCapabilities: [capability],
      constraints: ['offline planning only'], authorization: { allowedActions: ['read', 'write'], prohibitedActions: ['publish'], approvalRequired: [] }, decision: { complexity: 'simple', hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true } });
    (evidence.plans as Record<string, unknown>)[capability] = plan;
    expect(plan.error).toBeNull();
    expect(plan.data!.stages.map(s => s.requiredCapability)).toEqual(phases);
    expect(plan.data!.selectedSkills).toEqual([K]);
    expect(plan.data!.stages.map(s => s.phaseOrder)).toEqual([50, 55, 60, 65]);
    expect(plan.data!.stages[3].inputBindings.find(b => b.targetArtifact === 'edit-verification-report')!.sources).toEqual(['provider:korean-prose-verification.edit-verification-report']);
  });
});
