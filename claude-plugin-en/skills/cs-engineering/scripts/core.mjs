import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema, schemaEngine } from './schema-validation.mjs';
import { hostText } from './messages.mjs';
import { CsError, requireCondition as need, hashJson, hashBytes, uniqueBy, sameSet, parseJson, readBoundedFile, readArtifact, portablePath } from './primitives.mjs';
export { CsError, hashJson, hashBytes, schemaEngine };
export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = '0.1.0';
const assertDigest = (left, right, label) => need(left === right, 'INTEGRITY_FAILED', 'skillTools.csEngineering.digestMismatch', { label });
const refsExist = (refs, map, label) => { for (const r of refs) need(map.has(r), 'INVALID_INPUT', 'skillTools.csEngineering.unknownReference', { label, value: r }); };

export function loadPack(root = SKILL_ROOT) {
  const lock = parseJson(readBoundedFile(root, 'assets/knowledge-lock.json'));
  need(lock.schemaVersion === '1.0.0' && lock.version === VERSION && Array.isArray(lock.files), 'INVALID_INPUT', 'skillTools.csEngineering.invalidKnowledgeLock');
  uniqueBy(lock.files, 'path', 'knowledgeFile');
  for (const entry of lock.files) readArtifact(root, entry);
  const catalogue = parseJson(readBoundedFile(root, 'assets/rule-catalog.json'));
  const sources = parseJson(readBoundedFile(root, 'assets/sources.json'));
  const sourceIds = uniqueBy(sources.sources, 'id', 'source');
  const modules = uniqueBy(catalogue.modules, 'id', 'module');
  const catalogueRules = uniqueBy(catalogue.rules, 'id', 'catalogueRule');
  const rules = new Map();
  for (const module of modules.values()) {
    need(['draft', 'validated'].includes(module.status), 'INVALID_INPUT', 'skillTools.csEngineering.invalidModuleStatus');
    const rows = parseJson(readBoundedFile(root, module.ruleFile));
    need(Array.isArray(rows) && rows.length > 0, 'INVALID_INPUT', 'skillTools.csEngineering.emptyKnowledgeModule');
    need(sameSet(rows.map(r => r.id), module.ruleIds), 'INVALID_INPUT', 'skillTools.csEngineering.moduleRuleListMismatch');
    for (const card of rows) {
      need(!rules.has(card.id), 'INVALID_INPUT', 'skillTools.csEngineering.duplicateRuleId');
      need(card.domain === module.id && card.status === module.status && card.version === VERSION, 'INVALID_INPUT', 'skillTools.csEngineering.ruleMetadataMismatch');
      for (const k of ['title','principle','invariant','validationScope']) need(typeof card[k] === 'string' && card[k].trim(), 'INVALID_INPUT', 'skillTools.csEngineering.ruleLacksField', { field: k });
      for (const k of ['appliesWhen','assumptions','failureModes','decisionQuestions','verificationObligations','nonGoals','sources']) need(Array.isArray(card[k]) && card[k].length > 0 && card[k].every(x => typeof x === 'string' && x.trim()), 'INVALID_INPUT', 'skillTools.csEngineering.ruleLacksField', { field: k });
      refsExist(card.sources, sourceIds, 'source');
      const index = catalogueRules.get(card.id);
      need(index && index.domain === module.id && index.path === module.ruleFile && index.status === card.status, 'INVALID_INPUT', 'skillTools.csEngineering.catalogueRowMismatch');
      assertDigest(index.digest, hashJson(card), 'ruleDigest');
      rules.set(card.id, card);
    }
  }
  need(rules.size === catalogueRules.size, 'INVALID_INPUT', 'skillTools.csEngineering.unloadedCatalogueRule');
  const locked = new Set(lock.files.map(x => x.path));
  for (const p of ['assets/rule-catalog.json','assets/sources.json', ...catalogue.modules.flatMap(m => [m.reference, m.ruleFile])]) need(locked.has(p), 'INTEGRITY_FAILED', 'skillTools.csEngineering.lockMissingSource');
  return { root, version: VERSION, digest: hashJson(lock), catalogue, rules, modules };
}
export function selectRules(pack, { domains = [], ruleIds = [], allowDraft = false } = {}) {
  need(Array.isArray(domains) && Array.isArray(ruleIds), 'INVALID_INPUT', 'skillTools.csEngineering.selectionNeedsArrays');
  domains.forEach(d => need(pack.modules.has(d), 'INVALID_INPUT', 'skillTools.csEngineering.unknownDomain', { value: d }));
  ruleIds.forEach(id => need(pack.rules.has(id), 'INVALID_INPUT', 'skillTools.csEngineering.unknownRule', { value: id }));
  return [...pack.rules.values()].filter(r => (!domains.length && !ruleIds.length || domains.includes(r.domain) || ruleIds.includes(r.id)) && (allowDraft || r.status === 'validated'));
}
export function validateRequest(request) {
  validateSchema('cs-request', request);
  const sourceIds = uniqueBy(request.sourceRefs, 'id', 'sourceReference');
  uniqueBy(request.sourceRefs, 'path', 'sourcePath');
  uniqueBy(request.operationalFacts, 'id', 'operationalFact');
  request.sourceRefs.forEach(r => portablePath(r.path));
  request.operationalFacts.forEach(f => refsExist(f.evidenceRefs, sourceIds, 'factEvidence'));
  assertDigest(request.sourceSnapshotDigest, hashJson(request.sourceRefs), 'sourceSnapshot');
  return request;
}
export function validateConstraintReport(report, { pack = loadPack(), request = null } = {}) {
  validateSchema('cs-constraint-report', report);
  assertDigest(report.knowledgePackDigest, pack.digest, 'knowledgePack');
  need(report.knowledgePackVersion === pack.version, 'INTEGRITY_FAILED', 'skillTools.csEngineering.knowledgeVersionMismatch');
  const selected = uniqueBy(report.selectedRules, 'ruleId', 'selectedRule');
  for (const row of selected.values()) {
    const rule = pack.rules.get(row.ruleId);
    need(rule, 'INVALID_INPUT', 'skillTools.csEngineering.selectedRuleMissing');
    assertDigest(row.ruleDigest, hashJson(rule), 'selectedRule');
    need(rule.status === 'validated' || report.draftUse.allowed, 'INVALID_INPUT', 'skillTools.csEngineering.draftNeedsBasis');
  }
  const facts = uniqueBy(report.facts, 'id', 'fact');
  const assumptions = uniqueBy(report.assumptions, 'id', 'assumption');
  const basis = new Map([...facts, ...assumptions]);
  need(basis.size === facts.size + assumptions.size, 'INVALID_INPUT', 'skillTools.csEngineering.factAssumptionCollide');
  const invs = uniqueBy(report.invariants, 'id', 'invariant');
  const obligations = uniqueBy(report.verificationObligations, 'id', 'obligation');
  const choices = uniqueBy(report.designChoices, 'id', 'designChoice');
  for (const inv of invs.values()) {
    refsExist(inv.basisRefs, basis, 'invariantBasis');
    refsExist(inv.ruleIds, selected, 'selectedInvariantRule');
    if (inv.requirementLevel === 'required-invariant') need(inv.basisRefs.some(id => facts.has(id)), 'INVALID_INPUT', 'skillTools.csEngineering.requiredInvariantNeedsFact');
  }
  for (const c of choices.values()) refsExist(c.basisRefs, basis, 'choiceBasis');
  for (const ob of obligations.values()) {
    refsExist(ob.invariantIds, invs, 'obligationInvariant');
    const isRequired = ob.invariantIds.some(id => invs.get(id).requirementLevel === 'required-invariant');
    need(ob.requirementLevel === (isRequired ? 'required' : 'advisory'), 'INVALID_INPUT', 'skillTools.csEngineering.obligationSeverityMismatch');
  }
  for (const inv of invs.values()) if (inv.requirementLevel === 'required-invariant') need([...obligations.values()].some(o => o.invariantIds.includes(inv.id) && o.requirementLevel === 'required'), 'INVALID_INPUT', 'skillTools.csEngineering.requiredInvariantNoObligation');
  if (report.applicability === 'applicable' && report.verdict === 'READY') need(selected.size > 0 && invs.size > 0 && obligations.size > 0, 'INVALID_INPUT', 'skillTools.csEngineering.applicableReadyIncomplete');
  if (report.applicability === 'not-applicable') need(selected.size === 0 && invs.size === 0 && obligations.size === 0 && choices.size === 0, 'INVALID_INPUT', 'skillTools.csEngineering.notApplicableHasConstraints');
  if (request) {
    validateRequest(request);
    assertDigest(report.requestDigest, hashJson(request), 'request');
    assertDigest(report.sourceSnapshotDigest, request.sourceSnapshotDigest, 'sourceSnapshot');
    const refs = new Map(request.sourceRefs.map(x => [x.id, x]));
    for (const f of facts.values()) refsExist(f.evidenceRefs, refs, 'fact evidence');
  }
  return { report, invariants: invs, obligations, requiredObligationIds: [...obligations.values()].filter(x => x.requirementLevel === 'required').map(x => x.id) };
}
export function validateBinding(binding, { task, request, constraint, policy, pack = loadPack() }) {
  validateSchema('cs-engineering-binding', binding);
  validateSchema('cs-policy', policy);
  const validated = validateConstraintReport(constraint, { pack, request });
  need(constraint.verdict === 'READY', 'INVALID_INPUT', 'skillTools.csEngineering.onlyReadyFrozen');
  assertDigest(binding.requestDigest, hashJson(request), 'boundRequest');
  assertDigest(binding.constraintReportDigest, hashJson(constraint), 'boundReport');
  assertDigest(binding.taskDigest, hashJson(task), 'boundTask');
  assertDigest(binding.knowledgePackDigest, pack.digest, 'boundKnowledge');
  assertDigest(binding.policyDigest, hashJson(policy), 'boundPolicy');
  need(binding.knowledgePackVersion === pack.version && binding.policyId === policy.policyId && binding.policyVersion === policy.version && binding.mode === policy.mode, 'INTEGRITY_FAILED', 'skillTools.csEngineering.policyKnowledgeChanged');
  need(sameSet(binding.requiredObligationIds, validated.requiredObligationIds), 'INTEGRITY_FAILED', 'skillTools.csEngineering.requiredObligationsChanged');
  if (!policy.allowDraft) need(!constraint.selectedRules.some(r => pack.rules.get(r.ruleId).status === 'draft'), 'INVALID_INPUT', 'skillTools.csEngineering.draftNotAuthorized');
  portablePath(binding.requestRef.path); portablePath(binding.constraintReportRef.path);
  // This validates a supplied policy, not its authority. The embedding host must
  // pass its already authenticated, pinned policy and validate TaskEnvelope.v1.
  return validated;
}
export function validateReviewReport(review, { constraint, candidateDigest, pack = loadPack() }) {
  validateSchema('cs-review-report', review);
  const { invariants, obligations, requiredObligationIds } = validateConstraintReport(constraint, { pack });
  need(constraint.verdict === 'READY', 'INVALID_INPUT', 'skillTools.csEngineering.reviewNeedsReady');
  assertDigest(review.constraintReportDigest, hashJson(constraint), 'reviewConstraint');
  assertDigest(review.candidateDigest, candidateDigest, 'reviewCandidate');
  const evidence = uniqueBy(review.evidence, 'id', 'evidence');
  const findings = uniqueBy(review.findings, 'id', 'finding');
  const byInvariant = uniqueBy(review.findings, 'invariantId', 'reviewedInvariant');
  const results = uniqueBy(review.verificationResults, 'obligationId', 'verificationResult');
  need(sameSet([...invariants.keys()], [...byInvariant.keys()]), 'INVALID_INPUT', 'skillTools.csEngineering.invariantReviewCoverage');
  need(sameSet([...obligations.keys()], [...results.keys()]), 'INVALID_INPUT', 'skillTools.csEngineering.obligationResultCoverage');
  for (const e of evidence.values()) { portablePath(e.path); assertDigest(e.targetDigest, candidateDigest, 'evidenceCandidate'); }
  for (const r of results.values()) {
    const o = obligations.get(r.obligationId);
    assertDigest(r.targetDigest, candidateDigest, 'resultCandidate');
    need(r.method === o.method, 'INVALID_INPUT', 'skillTools.csEngineering.verificationMethodChanged');
    refsExist(r.evidenceRefs, evidence, 'resultEvidence');
    if (r.executionStatus === 'EXECUTED') {
      need(r.result !== 'UNKNOWN' && r.evidenceRefs.length > 0, 'INVALID_INPUT', 'skillTools.csEngineering.executedNeedsEvidence');
      need(r.environmentRef === o.requiredEnvironment, 'INVALID_INPUT', 'skillTools.csEngineering.environmentMismatch');
      for (const id of r.evidenceRefs) {
        const e = evidence.get(id);
        need(e.kind === r.method && e.environmentRef === r.environmentRef, 'INVALID_INPUT', 'skillTools.csEngineering.evidenceKindMismatch');
      }
    } else need(r.result === 'UNKNOWN' && r.evidenceRefs.length === 0, 'INVALID_INPUT', 'skillTools.csEngineering.nonExecutedClaims');
  }
  const blocking = [], unverified = [];
  for (const id of requiredObligationIds) {
    const r = results.get(id);
    if (r.executionStatus !== 'EXECUTED' || r.result === 'UNKNOWN') unverified.push(id);
  }
  let requiredViolation = false, missingRequiredFinding = false;
  for (const f of findings.values()) {
    const inv = invariants.get(f.invariantId);
    const relevant = [...obligations.values()].filter(o => o.invariantIds.includes(inv.id));
    refsExist(f.evidenceRefs, evidence, 'findingEvidence');
    const resultEvidence = new Set(relevant.flatMap(o => results.get(o.id).evidenceRefs));
    for (const id of f.evidenceRefs) need(resultEvidence.has(id), 'INVALID_INPUT', 'skillTools.csEngineering.findingEvidenceUnconnected');
    if (['SATISFIED','VIOLATED'].includes(f.status)) need(f.evidenceRefs.length > 0, 'INVALID_INPUT', 'skillTools.csEngineering.conclusiveNeedsEvidence');
    if (f.status === 'SATISFIED') need(relevant.length > 0 && relevant.every(o => { const r = results.get(o.id); return r.executionStatus === 'EXECUTED' && r.result === 'PASS'; }), 'INVALID_INPUT', 'skillTools.csEngineering.satisfiedIncomplete');
    if (f.status === 'VIOLATED') need(relevant.some(o => results.get(o.id).result === 'FAIL'), 'INVALID_INPUT', 'skillTools.csEngineering.violatedNoFail');
    if (inv.requirementLevel === 'required-invariant') {
      if (f.status === 'VIOLATED') { blocking.push(f.id); requiredViolation = true; }
      if (f.status === 'UNVERIFIED' || f.status === 'NOT_APPLICABLE') missingRequiredFinding = true;
      if (relevant.some(o => results.get(o.id).result === 'FAIL')) {
        requiredViolation = true;
        need(f.status === 'VIOLATED', 'INVALID_INPUT', 'skillTools.csEngineering.failedVerificationHidden');
      }
    }
  }
  const expected = requiredViolation ? 'FAIL' : (unverified.length || missingRequiredFinding) ? 'BLOCKED' : 'PASS';
  need(sameSet(review.blockingFindingIds, blocking), 'INVALID_INPUT', 'skillTools.csEngineering.blockingListInaccurate');
  need(sameSet(review.unverifiedRequiredObligationIds, unverified), 'INVALID_INPUT', 'skillTools.csEngineering.unverifiedListInaccurate');
  need(review.verdict === expected, 'INVALID_INPUT', 'skillTools.csEngineering.reviewVerdictMismatch', { expected });
  return { verdict: expected, blockingFindingIds: blocking, unverifiedRequiredObligationIds: unverified, requiredCount: requiredObligationIds.length };
}
export function validateCandidate(candidate) {
  validateSchema('cs-candidate', candidate);
  uniqueBy(candidate.files, 'path', 'candidateFile');
  candidate.files.forEach(x => portablePath(x.path));
  need(candidate.files.every((x, i) => i === 0 || candidate.files[i-1].path < x.path), 'INVALID_INPUT', 'skillTools.csEngineering.candidatePathsUnsorted');
  return hashJson(candidate);
}
export function checkBundle({ root, binding, task, policy, review, candidate, pack = loadPack() }) {
  validateSchema('cs-engineering-binding', binding);
  const request = parseJson(readArtifact(root, binding.requestRef));
  const constraint = parseJson(readArtifact(root, binding.constraintReportRef));
  validateBinding(binding, { task, request, constraint, policy, pack });
  const candidateDigest = validateCandidate(candidate);
  let count = 2;
  for (const ref of request.sourceRefs) { readArtifact(root, ref); count++; }
  for (const ref of candidate.files) { readArtifact(root, ref, 8 * 1024 * 1024); count++; }
  const assessment = validateReviewReport(review, { constraint, candidateDigest, pack });
  for (const ref of review.evidence) { readArtifact(root, ref); count++; }
  return {
    schemaVersion: '1.0.0', kind: 'cs-bundle-check', verdict: assessment.verdict,
    canProceedUnderSuppliedPolicy: policy.mode === 'observe' || assessment.verdict === 'PASS',
    mode: policy.mode, schemaEngine, knowledgePackDigest: pack.digest,
    candidateDigest, constraintReportDigest: hashJson(constraint), checkedRawFiles: count,
    requiredObligationCount: assessment.requiredCount,
    assurance: hostText('skillTools.csEngineering.bundleAssurance')
  };
}
export function providerResult(output, artifacts = []) {
  return { schemaVersion: '1.0.0', kind: 'output', output, artifacts,
    error: ['FAIL','NEEDS_REDESIGN'].includes(output.verdict) ? { code:'GATE_FAILED',message:hostText('skillTools.csEngineering.gateFailed'),details:null }
      : ['BLOCKED','NEEDS_INPUT'].includes(output.verdict) ? {code:'MISSING_EVIDENCE',message:hostText('skillTools.csEngineering.missingEvidence'),details:null} : null };
}
export function adapterError(error) {
  return { schemaVersion:'1.0.0',kind:'adapter-error',output:null,artifacts:[],error:{code:error instanceof CsError ? error.code : 'INVALID_INPUT',message:error instanceof CsError ? error.message : hostText('skillTools.csEngineering.unreadableInput'),details:error instanceof CsError ? error.details : null} };
}
