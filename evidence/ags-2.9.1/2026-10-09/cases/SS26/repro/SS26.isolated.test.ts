import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadSkillInventory } from '../../mcp-server/src/skill-classification/inventory.js';
import { createClassificationRequest, digestClassificationValue } from '../../mcp-server/src/skill-classification/request.js';
import { digestProviderProfileConfiguration } from '../../mcp-server/src/skill-classification/profiles.js';
import { SkillClassificationService, InMemoryClassificationBudget } from '../../mcp-server/src/skill-classification/service.js';
import { RuntimeSkillClassificationGateway } from '../../mcp-server/src/skill-classification/gateway.js';
import { validateDecision } from '../../mcp-server/src/skill-classification/validation.js';
import { oracleDigest } from './evaluation.js';
import type { SkillInventory, ProviderProfile, ProviderEvaluation, SkillClassificationRequestV1, ClassificationResult, SkillSelectionDecisionV1 } from '../../mcp-server/src/skill-classification/types.js';

// SS26 only. Real loader/request/service/gateway; synthetic files and mock provider.
// No actual host observation, receipt issuance, acceptance, API, or semantic scoring.
const evidence = path.resolve('SS26-output');
const corpus = JSON.parse(await readFile('tests/skill-classification/fixtures.json', 'utf8'));
const fixture = corpus.cases.find((c: {caseId: string}) => c.caseId === 'SS26');
const rows: any[] = [];
const hash = (b: string | Buffer) => 'sha256:' + createHash('sha256').update(b).digest('hex');
const providerEntry = (id: string) => ({skillId: id, version: '1.0.0', path: './' + id, enabled: true,
  providers: [{capabilities: ['queue-review'], phase: 'analysis', phaseOrder: 10, requiredInputArtifacts: [], producedArtifacts: [], inputBindings: [], gate: {kind: 'none', policy: 'none'}}]});
async function json(file: string, value: unknown) { await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
async function registry(root: string, mutate?: (v: any) => void) {
  const file = path.join(root, 'skills/registry.json');
  const v = JSON.parse(await readFile(file, 'utf8')); mutate?.(v); await json(file, v);
}
async function skill(root: string, id = 'subject', changes: any = {}) {
  const base = `skills/${id}`;
  const text = `---\nname: ${changes.name ?? id}\ndescription: ${changes.description ?? 'Review queue delivery.'}\nmetadata:\n  version: '${changes.version ?? '1.0.0'}'\n---\n${changes.apply ?? 'Apply to queue delivery analysis.'}\n${changes.exclude ?? 'Exclude implementation and ordinary explanation.'}\n`;
  const span = (line: number) => ({path: `${base}/SKILL.md`, startLine: line, endLine: line, digest: hash(text)});
  await mkdir(path.join(root, base), {recursive: true}); await writeFile(path.join(root, base, 'SKILL.md'), text);
  await json(path.join(root, base, 'classification.json'), {schemaVersion: '1.0.0', taxonomyRevision: changes.taxonomy ?? '1.0.0', actions: ['review'], targets: ['queue'], constraints: [], dependencies: [], capabilities: ['queue-review'], applicability: [span(7)], exclusions: [span(8)]});
}
async function snapshot(variant: string) {
  const root = path.join(evidence, 'snapshots', variant); await rm(root, {recursive: true, force: true});
  await json(path.join(root, 'skills/registry.json'), {schemaVersion: '2.0.0', skills: [providerEntry('subject'), providerEntry('complete')]});
  await skill(root); await skill(root, 'complete'); return root;
}
async function sources(root: string) {
  const result: Record<string, {digest: string; content: string}> = {};
  async function walk(dir: string) { for (const entry of await readdir(dir, {withFileTypes: true})) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else { const content = await readFile(file, 'utf8'); result[path.relative(root, file)] = {digest: hash(content), content}; } } }
  await walk(path.join(root, 'skills')); return result;
}
function req(inventory: SkillInventory, id = 'same') {
  // originalPrompt null remains in result fixture. This string is a NEW synthetic probe,
  // not a reconstructed source prompt or a semantic oracle.
  return createClassificationRequest({requestId: 'SS26-' + id, operationId: 'SS26-' + id, originalPrompt: 'Synthetic SS26: inspect queue delivery.', inventory, classificationCriteriaRef: 'skills/orchestrator/references/skill-classification.md'});
}
function harness(root: string, inventory: SkillInventory) {
  const p: ProviderProfile = {profileId: 'mock-vendor', providerKind: 'vendor', vendorId: 'mock-vendor', modelId: 'mock-fixed', modelRevision: 'mock-fixed-v1', reasoningEffort: 'low', supportedOptions: {reasoningEfforts: ['low'], structuredOutput: true}, approvedRouteRef: 'fixture:mock-only', qualificationRevision: 'mock-only', qualification: {status: 'PASS', inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: 'mock-fixed-v1', promptRevision: 'p1', validUntil: '2099-01-01T00:00:00Z', profileConfigurationDigest: ''}, adapterRevision: 'fixture:a1', promptRevision: 'p1', maximumInputBytes: 1000000, maximumOutputTokens: 1000, maximumCostUsd: 0, judgmentPolicy: null};
  p.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(p);
  const runtime = {config: {jevEnabled: false, mode: 'select' as const, providerProfileRegistryRef: 'fixture:mock-profiles', externalClassificationAllowed: false, configRevision: 'c1', timeoutMs: 2000}, registry: {schemaVersion: '1.0.0' as const, profileRevision: 'pr1', profiles: [p]}, allowRemotePrivateContent: false};
  const evaluation = (r: SkillClassificationRequestV1): ProviderEvaluation => ({response: {schemaVersion: '1.0.0', requestId: r.requestId, operationId: r.operationId, requestDigest: r.requestDigest, inventoryDigest: r.inventoryDigest, status: 'SUCCESS', judgments: r.skills.map(s => ({skillId: s.skillId, judgment: 'needed', reasonRefs: ['fixture:mock-only'], uncertaintyReason: null})), unresolvedItems: [], error: null}, usage: {inputTokens: null, outputTokens: null, cachedInputTokens: null, actualCostUsd: 0}, dispatchState: 'started', diagnostics: null});
  const classify = vi.fn(async (r: SkillClassificationRequestV1) => evaluation(r));
  const service = new SkillClassificationService({providers: {vendor: {availability: async () => ({available: true, approved: true, routeKind: 'native', reasonCode: null}), classify}}, budget: new InMemoryClassificationBudget({jev: {limitUsd: 0, spentUsd: 0}, vendors: {}, nativeAllowances: {'mock-vendor': {approvalRef: 'fixture:no-host-no-API', remainingCalls: 20}}})});
  const gateway = new RuntimeSkillClassificationGateway({root, service, readRuntime: async () => runtime});
  const input = (id: string) => ({schemaVersion: '1.0.0', requestId: 'SS26-' + id, operationId: 'SS26-' + id, originalPrompt: 'Synthetic SS26: inspect queue delivery.', confirmedContext: {taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null}, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: 'mock-vendor', reference: 'fixture:mock-only'}, publicSynthetic: true});
  return {runtime, p, service, gateway, classify, evaluation, input};
}
function row(variant: string, input: unknown, expected: unknown, observed: unknown) {
  const r = {variant, input, expected, observed, checks: [] as any[], executionKind: 'offline-mock', API0: true, stages: {selected: 'NOTRUN', read: 'NOTRUN', applied: 'NOTRUN', verified: 'NOTRUN'}, agentSelectedSkillIds: null, hostReceipt: null}; rows.push(r); return r;
}
function check(r: any, condition: boolean, label: string) { r.checks.push({label, passed: condition}); expect.soft(condition, `${r.variant}: ${label}`).toBe(true); }
async function common(r: any, before: SkillInventory, after: SkillInventory) {
  const a = req(before), b = req(after);
  r.observed.before = {inventory: before, request: a}; r.observed.after = {inventory: after, request: b};
  check(r, after.inventoryDigest !== before.inventoryDigest, 'source/inventory digest changes');
  check(r, a.requestDigest !== b.requestDigest, 'same IDs and prompt produce changed REQ digest');
  check(r, after.skills.some(s => s.skillId === 'complete'), 'loader preserves complete candidate');
  const h = harness(r.input.root, before);
  const first = await h.service.classify({...h.runtime, request: a, currentVendorId: 'mock-vendor'});
  const staleProfile = await h.service.classify({...h.runtime, request: req(after, 'new-revision'), currentVendorId: 'mock-vendor'});
  check(r, first.response.status === 'SUCCESS', 'baseline mock classification runs');
  check(r, staleProfile.response.error?.code === 'QUALIFICATION_MISMATCH', 'old profile inventory binding rejected');
  const oldCache = await h.service.classify({...h.runtime, request: a, currentVendorId: 'mock-vendor', getCurrentSnapshot: () => ({...first.snapshot, inventoryDigest: after.inventoryDigest})});
  check(r, oldCache.response.error?.code === 'STALE_CLASSIFICATION', 'completed operation cache rejects changed inventory');
  r.observed.cache = {identityFields: ['requestId', 'requestDigest', 'taskRevision', 'configRevision', 'profileRevision', 'inventoryDigest', 'currentVendorId'], oldCacheError: oldCache.response.error, staleProfileError: staleProfile.response.error};
}
async function completeIsolation(r: any, root: string, after: SkillInventory) {
  const h = harness(root, after); const result: any = await h.gateway.classify(h.input(r.variant));
  r.observed.gateway = result; r.observed.mockProviderCalls = h.classify.mock.calls.length;
  check(r, result.result?.request.skills.some((s: any) => s.skillId === 'complete') === true, 'incomplete subject must not hide independent complete candidate at gateway');
}
describe('SS26 independent complete variant validation', () => {
  it('SS26 frozen binding', async () => {
    expect(hash(await readFile('tests/skill-classification/fixtures.json'))).toBe('sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
    expect(oracleDigest(corpus)).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055'); expect(fixture.oracle).toBeNull(); expect(fixture.originalPrompt).toBeNull();
  });
  for (const variant of fixture.variants) it('SS26 ' + variant, async () => {
    const root = await snapshot(variant); const before = await loadSkillInventory({root});
    const r = row(variant, {root, syntheticProbePrompt: 'Synthetic SS26: inspect queue delivery.'}, {sourceSpec: fixture.sourceSpec.fields, semantics: 'null oracle; mechanical invariants only'}, {});
    r.input.baselineSources = await sources(root);
    check(r, before.issues.length === 0 && before.skills.length === 2, 'clean two-candidate baseline');
    if (['description', 'applicability', 'exclusion'].includes(variant)) {
      const changes = variant === 'description' ? {description: 'Changed canonical queue review description.'} : variant === 'applicability' ? {apply: 'Apply only to duplicate-message queue analysis.'} : {exclude: 'Exclude queue analysis when implementation is requested.'};
      await skill(root, 'subject', changes); r.input.changes = changes;
    } else if (variant === 'new-skill') {
      await skill(root, 'neutral-added'); await registry(root, v => v.skills.push(providerEntry('neutral-added')));
    } else if (variant === 'duplicate-id') await registry(root, v => v.skills.push(providerEntry('subject')));
    else if (variant === 'missing-description') await writeFile(path.join(root, 'skills/subject/SKILL.md'), "---\nname: subject\nmetadata:\n  version: '1.0.0'\n---\nApply queue review.\nExclude implementation.\n");
    else if (variant === 'id-conflict') await skill(root, 'subject', {name: 'different-id'});
    else if (variant === 'version-conflict') await skill(root, 'subject', {version: '2.0.0'});
    else if (variant === 'taxonomy-conflict') await skill(root, 'subject', {taxonomy: '2.0.0'});
    else if (variant === 'delete') { await rm(path.join(root, 'skills/subject'), {recursive: true}); await registry(root, v => v.skills = v.skills.filter((s: any) => s.skillId !== 'subject')); }
    else if (variant === 'disable') await registry(root, v => v.skills[0].enabled = false);
    else if (variant === 'source-generated-conflict') {
      const generator: any = await import(new URL('../../scripts/build-claude-plugin.mjs', import.meta.url).href);
      const canonical = await generator.readClassificationSources(root, ['skills/subject/SKILL.md', 'skills/complete/SKILL.md']);
      const files = new Map(canonical); generator.projectClassificationSources(files, canonical);
      for (const [relative, bytes] of files) await writeFile(path.join(root, relative as string), bytes as Buffer);
      const valid = await loadSkillInventory({root}); check(r, valid.issues.length === 0 && valid.skills.length === 2, 'valid synthetic generated projection');
      const subRows = [];
      const mutations: Record<string, [string, (x: string) => string]> = {
        id: ['skills/subject/SKILL.md', x => x.replace('name: subject', 'name: stale-id')],
        version: ['skills/registry.json', x => x.replace('1.0.0', '2.0.0')],
        description: ['skills/subject/SKILL.md', x => x.replace('Review queue delivery.', 'Old generated description.')],
        taxonomy: ['skills/subject/classification.json', x => x.replace('"review"', '"stale-action"')],
        apply: ['skills/subject/SKILL.md', x => x.replace('Apply to queue delivery analysis.', 'Apply to old task.')],
        exclude: ['skills/subject/SKILL.md', x => x.replace('Exclude implementation and ordinary explanation.', 'Exclude different action.')],
      };
      for (const [field, [relative, mutate]] of Object.entries(mutations)) {
        const file = path.join(root, relative); const original = await readFile(file, 'utf8'); await writeFile(file, mutate(original));
        const invalid = await loadSkillInventory({root}); subRows.push({field, relative, expected: 'HOST_SOURCE_STALE, no guessing', inventory: invalid});
        check(r, invalid.issues.some(i => i.code === 'HOST_SOURCE_STALE'), `${field}: generated source digest conflict reported`);
        check(r, invalid.inventoryDigest !== valid.inventoryDigest, `${field}: generated conflict invalidates inventory digest`); await writeFile(file, original);
      }
      r.observed.generatedFieldChecks = subRows;
      await writeFile(path.join(root, 'skills/subject/SKILL.md'), 'stale generated bytes');
    }
    r.input.currentSources = await sources(root);
    r.input.changedPaths = [...new Set([...Object.keys(r.input.baselineSources), ...Object.keys(r.input.currentSources)])].filter(p => r.input.baselineSources[p]?.digest !== r.input.currentSources[p]?.digest);
    const after = await loadSkillInventory({root}); await common(r, before, after);
    const subject = after.skills.find(s => s.skillId === 'subject');
    if (variant === 'description') check(r, subject?.description === r.input.changes.description, 'new canonical description exposed');
    if (variant === 'applicability') check(r, subject?.applicability.includes(r.input.changes.apply) === true, 'new apply condition exposed');
    if (variant === 'exclusion') check(r, subject?.exclusions.includes(r.input.changes.exclude) === true, 'new exclusion exposed');
    if (['description', 'applicability', 'exclusion'].includes(variant)) {
      // SKILL owns prose; registry's unowned handwritten fields cannot override it.
      await registry(root, v => {v.skills[0].description = 'Wrong registry description'; v.skills[0].applicability = ['Wrong registry applicability']; v.skills[0].exclusions = ['Wrong registry exclusion'];});
      const owner = await loadSkillInventory({root}); r.observed.fieldOwnership = owner;
      check(r, owner.issues.length === 0 && owner.skills.find(s => s.skillId === 'subject')?.description === subject?.description && JSON.stringify(owner.skills.find(s => s.skillId === 'subject')?.applicability) === JSON.stringify(subject?.applicability) && JSON.stringify(owner.skills.find(s => s.skillId === 'subject')?.exclusions) === JSON.stringify(subject?.exclusions), 'SKILL prose overrides registry fields outside its responsibility');
      // A missing required apply/exclude is isolated and leaves independent candidate intact.
      if (variant !== 'description') {
        const file = path.join(root, 'skills/subject/classification.json'); const metadata = JSON.parse(await readFile(file, 'utf8')); metadata[variant === 'applicability' ? 'applicability' : 'exclusions'] = []; await json(file, metadata);
        const missing = await loadSkillInventory({root}); r.observed.missingCondition = missing;
        check(r, missing.issues.some(i => i.skillId === 'subject' && i.code === 'MISSING_OR_INVALID_METADATA') && missing.skills.some(s => s.skillId === 'complete'), 'missing required condition reports input gap and preserves complete loader candidate');
      }
    }
    if (variant === 'new-skill') check(r, after.skills.length === 3 && after.skills.some(s => s.skillId === 'neutral-added'), 'new ID exposed without selector edits');
    const errors: Record<string, string> = {'duplicate-id': 'DUPLICATE_ID', 'missing-description': 'MISSING_DESCRIPTION', 'id-conflict': 'SOURCE_CONFLICT', 'version-conflict': 'SOURCE_CONFLICT', 'taxonomy-conflict': 'TAXONOMY_REVISION_CONFLICT', 'source-generated-conflict': 'HOST_SOURCE_STALE'};
    if (errors[variant]) { check(r, after.issues.some(i => i.code === errors[variant]), 'specific conflict/missing input reported'); await completeIsolation(r, root, after); }
    if (['description', 'applicability', 'exclusion', 'new-skill', 'disable'].includes(variant)) {
      const mappings = subject?.sourceMap ?? [];
      const authorities: Record<string, string> = {skillId: 'skills/registry.json', version: 'skills/registry.json', description: 'skills/subject/SKILL.md', actions: 'skills/subject/classification.json', taxonomyRevision: 'skills/subject/classification.json', applicability: 'skills/subject/SKILL.md', exclusions: 'skills/subject/SKILL.md'};
      for (const [field, authority] of Object.entries(authorities)) check(r, mappings.some(m => m.field === field && m.path === authority && /^sha256:[a-f0-9]{64}$/.test(m.digest)), `${field}: canonical source-map authority`);
    }
    if (variant === 'delete') check(r, !subject && after.issues.length === 0, 'deleted candidate absent');
    if (variant === 'disable') check(r, subject?.enabled === false && after.issues.length === 0, 'disabled descriptor retained with enabled=false');
    if (['delete', 'disable'].includes(variant)) {
      // Separate in-flight synthetic snapshot, with actual gateway and delayed mock transport.
      const flightRoot = await snapshot(variant + '-flight'), old = await loadSkillInventory({root: flightRoot}); const h = harness(flightRoot, old);
      let release!: (v: ProviderEvaluation) => void; let dispatch!: () => void; const started = new Promise<void>(resolve => dispatch = resolve);
      h.classify.mockImplementationOnce(() => {dispatch(); return new Promise(resolve => release = resolve);});
      const pending: Promise<any> = h.gateway.classify(h.input('flight-' + variant)); await started;
      if (variant === 'delete') { await rm(path.join(flightRoot, 'skills/subject'), {recursive: true}); await registry(flightRoot, v => v.skills = v.skills.filter((s: any) => s.skillId !== 'subject')); }
      else await registry(flightRoot, v => v.skills[0].enabled = false);
      const current = await loadSkillInventory({root: flightRoot}); const sent = h.classify.mock.calls[0][0]; release(h.evaluation(sent)); const late = await pending;
      r.observed.late = {result: late, currentInventory: current, selected: null, hostReceipt: null};
      check(r, late.result.response.error?.code === 'STALE_CLASSIFICATION', 'gateway rejects late advice after source deletion/disable');
      check(r, late.agentSelectedSkillIds === null, 'late advice never invents an AGENT selection');
      const result: ClassificationResult = late.result;
      const decision: SkillSelectionDecisionV1 = {schemaVersion: '1.0.0', classificationResponseRef: digestClassificationValue(result.response), ...result.snapshot, explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: null, selectionReasons: [], applicabilityChecks: [], unresolvedSkillReferences: [], selectionStatus: 'NEEDS_INPUT', adviceApplied: false, hostReceipt: null};
      delete (decision as any).cancelled;
      const validated = validateDecision(result, decision, {...result.snapshot, inventoryDigest: current.inventoryDigest}); r.observed.late.validationWithoutReceipt = validated;
      check(r, !validated.valid && validated.errors.includes('STALE_inventoryDigest'), 'selection validator rejects old inventory without synthetic host receipt');
    }
    r.observed.finalSnapshotSources = await sources(root);
    await json(path.join(evidence, variant + '.observation.json'), r);
  });
});
afterAll(async () => {
  for (const r of rows) { r.state = r.checks.every((c: any) => c.passed) ? 'PASS' : 'FAIL'; await json(path.join(evidence, r.variant + '.observation.json'), r); }
  await json(path.join(evidence, 'SS26.observations.json'), {caseId: 'SS26', fixture, rows, API0: true, actualHost: 'NOTRUN', stages: {selected: 'NOTRUN', read: 'NOTRUN', applied: 'NOTRUN', verified: 'NOTRUN'}, agentSelectedSkillIds: null, hostReceipt: null, semanticAccuracy: null});
});
