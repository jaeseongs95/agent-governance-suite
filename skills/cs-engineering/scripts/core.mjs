import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema, schemaEngine } from './schema-validation.mjs';
import { CsError, requireCondition as need, hashJson, hashBytes, uniqueBy, sameSet, parseJson, readBoundedFile, readArtifact, portablePath } from './primitives.mjs';
export { CsError, hashJson, hashBytes, schemaEngine };
export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = '0.1.0';
const assertDigest = (left, right, label) => need(left === right, 'INTEGRITY_FAILED', `${label} mismatch.`);
const refsExist = (refs, map, label) => { for (const r of refs) need(map.has(r), 'INVALID_INPUT', `Unknown ${label}: ${r}.`); };

export function loadPack(root = SKILL_ROOT) {
  const lock = parseJson(readBoundedFile(root, 'assets/knowledge-lock.json'));
  need(lock.schemaVersion === '1.0.0' && lock.version === VERSION && Array.isArray(lock.files), 'INVALID_INPUT', 'Invalid knowledge lock.');
  uniqueBy(lock.files, 'path', 'knowledge file');
  for (const entry of lock.files) readArtifact(root, entry);
  const catalogue = parseJson(readBoundedFile(root, 'assets/rule-catalog.json'));
  const sources = parseJson(readBoundedFile(root, 'assets/sources.json'));
  const sourceIds = uniqueBy(sources.sources, 'id', 'source');
  const modules = uniqueBy(catalogue.modules, 'id', 'module');
  const catalogueRules = uniqueBy(catalogue.rules, 'id', 'catalogue rule');
  const rules = new Map();
  for (const module of modules.values()) {
    need(['draft', 'validated'].includes(module.status), 'INVALID_INPUT', 'Invalid module status.');
    const rows = parseJson(readBoundedFile(root, module.ruleFile));
    need(Array.isArray(rows) && rows.length > 0, 'INVALID_INPUT', 'Empty knowledge module.');
    need(sameSet(rows.map(r => r.id), module.ruleIds), 'INVALID_INPUT', 'Module rule list mismatch.');
    for (const card of rows) {
      need(!rules.has(card.id), 'INVALID_INPUT', 'Duplicate rule ID.');
      need(card.domain === module.id && card.status === module.status && card.version === VERSION, 'INVALID_INPUT', 'Rule metadata mismatch.');
      for (const k of ['title','principle','invariant','validationScope']) need(typeof card[k] === 'string' && card[k].trim(), 'INVALID_INPUT', `Rule lacks ${k}.`);
      for (const k of ['appliesWhen','assumptions','failureModes','decisionQuestions','verificationObligations','nonGoals','sources']) need(Array.isArray(card[k]) && card[k].length > 0 && card[k].every(x => typeof x === 'string' && x.trim()), 'INVALID_INPUT', `Rule lacks ${k}.`);
      refsExist(card.sources, sourceIds, 'source');
      const index = catalogueRules.get(card.id);
      need(index && index.domain === module.id && index.path === module.ruleFile && index.status === card.status, 'INVALID_INPUT', 'Catalogue row mismatch.');
      assertDigest(index.digest, hashJson(card), 'Rule digest');
      rules.set(card.id, card);
    }
  }
  need(rules.size === catalogueRules.size, 'INVALID_INPUT', 'Unloaded catalogue rule.');
  const locked = new Set(lock.files.map(x => x.path));
  for (const p of ['assets/rule-catalog.json','assets/sources.json', ...catalogue.modules.flatMap(m => [m.reference, m.ruleFile])]) need(locked.has(p), 'INTEGRITY_FAILED', 'Knowledge lock is missing a required source.');
  return { root, version: VERSION, digest: hashJson(lock), catalogue, rules, modules };
}
export function selectRules(pack, { domains = [], ruleIds = [], allowDraft = false } = {}) {
  need(Array.isArray(domains) && Array.isArray(ruleIds), 'INVALID_INPUT', 'Selection must use arrays.');
  domains.forEach(d => need(pack.modules.has(d), 'INVALID_INPUT', `Unknown domain: ${d}.`));
  ruleIds.forEach(id => need(pack.rules.has(id), 'INVALID_INPUT', `Unknown rule: ${id}.`));
  return [...pack.rules.values()].filter(r => (!domains.length && !ruleIds.length || domains.includes(r.domain) || ruleIds.includes(r.id)) && (allowDraft || r.status === 'validated'));
}
export function validateRequest(request) {
  validateSchema('cs-request', request);
  const sourceIds = uniqueBy(request.sourceRefs, 'id', 'source reference');
  uniqueBy(request.sourceRefs, 'path', 'source path');
  uniqueBy(request.operationalFacts, 'id', 'operational fact');
  request.sourceRefs.forEach(r => portablePath(r.path));
  request.operationalFacts.forEach(f => refsExist(f.evidenceRefs, sourceIds, 'fact evidence'));
  assertDigest(request.sourceSnapshotDigest, hashJson(request.sourceRefs), 'Source snapshot');
  return request;
}
export function validateConstraintReport(report, { pack = loadPack(), request = null } = {}) {
  validateSchema('cs-constraint-report', report);
  assertDigest(report.knowledgePackDigest, pack.digest, 'Knowledge pack');
  need(report.knowledgePackVersion === pack.version, 'INTEGRITY_FAILED', 'Knowledge version mismatch.');
  const selected = uniqueBy(report.selectedRules, 'ruleId', 'selected rule');
  for (const row of selected.values()) {
    const rule = pack.rules.get(row.ruleId);
    need(rule, 'INVALID_INPUT', 'Selected rule does not exist.');
    assertDigest(row.ruleDigest, hashJson(rule), 'Selected rule');
    need(rule.status === 'validated' || report.draftUse.allowed, 'INVALID_INPUT', 'Draft rule requires explicit draft-use basis.');
  }
  const facts = uniqueBy(report.facts, 'id', 'fact');
  const assumptions = uniqueBy(report.assumptions, 'id', 'assumption');
  const basis = new Map([...facts, ...assumptions]);
  need(basis.size === facts.size + assumptions.size, 'INVALID_INPUT', 'Fact and assumption IDs collide.');
  const invs = uniqueBy(report.invariants, 'id', 'invariant');
  const obligations = uniqueBy(report.verificationObligations, 'id', 'obligation');
  const choices = uniqueBy(report.designChoices, 'id', 'design choice');
  for (const inv of invs.values()) {
    refsExist(inv.basisRefs, basis, 'invariant basis');
    refsExist(inv.ruleIds, selected, 'selected invariant rule');
    if (inv.requirementLevel === 'required-invariant') need(inv.basisRefs.some(id => facts.has(id)), 'INVALID_INPUT', 'A required invariant cannot rest solely on an unverified assumption.');
  }
  for (const c of choices.values()) refsExist(c.basisRefs, basis, 'choice basis');
  for (const ob of obligations.values()) {
    refsExist(ob.invariantIds, invs, 'obligation invariant');
    const isRequired = ob.invariantIds.some(id => invs.get(id).requirementLevel === 'required-invariant');
    need(ob.requirementLevel === (isRequired ? 'required' : 'advisory'), 'INVALID_INPUT', 'Obligation severity does not match its invariants.');
  }
  for (const inv of invs.values()) if (inv.requirementLevel === 'required-invariant') need([...obligations.values()].some(o => o.invariantIds.includes(inv.id) && o.requirementLevel === 'required'), 'INVALID_INPUT', 'Required invariant has no verification obligation.');
  if (report.applicability === 'applicable' && report.verdict === 'READY') need(selected.size > 0 && invs.size > 0 && obligations.size > 0, 'INVALID_INPUT', 'Applicable READY report requires rules, invariants and obligations.');
  if (report.applicability === 'not-applicable') need(selected.size === 0 && invs.size === 0 && obligations.size === 0 && choices.size === 0, 'INVALID_INPUT', 'Non-applicable report contains applied constraints.');
  if (request) {
    validateRequest(request);
    assertDigest(report.requestDigest, hashJson(request), 'Request');
    assertDigest(report.sourceSnapshotDigest, request.sourceSnapshotDigest, 'Source snapshot');
    const refs = new Map(request.sourceRefs.map(x => [x.id, x]));
    for (const f of facts.values()) refsExist(f.evidenceRefs, refs, 'fact evidence');
  }
  return { report, invariants: invs, obligations, requiredObligationIds: [...obligations.values()].filter(x => x.requirementLevel === 'required').map(x => x.id) };
}
export function validateBinding(binding, { task, request, constraint, policy, pack = loadPack() }) {
  validateSchema('cs-engineering-binding', binding);
  validateSchema('cs-policy', policy);
  const validated = validateConstraintReport(constraint, { pack, request });
  need(constraint.verdict === 'READY', 'INVALID_INPUT', 'Only a READY constraint report can be frozen.');
  assertDigest(binding.requestDigest, hashJson(request), 'Bound request');
  assertDigest(binding.constraintReportDigest, hashJson(constraint), 'Bound report');
  assertDigest(binding.taskDigest, hashJson(task), 'Bound task');
  assertDigest(binding.knowledgePackDigest, pack.digest, 'Bound knowledge');
  assertDigest(binding.policyDigest, hashJson(policy), 'Bound policy');
  need(binding.knowledgePackVersion === pack.version && binding.policyId === policy.policyId && binding.policyVersion === policy.version && binding.mode === policy.mode, 'INTEGRITY_FAILED', 'Policy or knowledge binding changed.');
  need(sameSet(binding.requiredObligationIds, validated.requiredObligationIds), 'INTEGRITY_FAILED', 'Required obligation set changed.');
  if (!policy.allowDraft) need(!constraint.selectedRules.some(r => pack.rules.get(r.ruleId).status === 'draft'), 'INVALID_INPUT', 'Policy does not authorize draft knowledge.');
  portablePath(binding.requestRef.path); portablePath(binding.constraintReportRef.path);
  // This validates a supplied policy, not its authority. The embedding host must
  // pass its already authenticated, pinned policy and validate TaskEnvelope.v1.
  return validated;
}
export function validateReviewReport(review, { constraint, candidateDigest, pack = loadPack() }) {
  validateSchema('cs-review-report', review);
  const { invariants, obligations, requiredObligationIds } = validateConstraintReport(constraint, { pack });
  need(constraint.verdict === 'READY', 'INVALID_INPUT', 'Review requires frozen READY constraints.');
  assertDigest(review.constraintReportDigest, hashJson(constraint), 'Review constraint');
  assertDigest(review.candidateDigest, candidateDigest, 'Review candidate');
  const evidence = uniqueBy(review.evidence, 'id', 'evidence');
  const findings = uniqueBy(review.findings, 'id', 'finding');
  const byInvariant = uniqueBy(review.findings, 'invariantId', 'reviewed invariant');
  const results = uniqueBy(review.verificationResults, 'obligationId', 'verification result');
  need(sameSet([...invariants.keys()], [...byInvariant.keys()]), 'INVALID_INPUT', 'Each invariant must be reviewed exactly once.');
  need(sameSet([...obligations.keys()], [...results.keys()]), 'INVALID_INPUT', 'Each obligation must have exactly one result, including NOT_RUN.');
  for (const e of evidence.values()) { portablePath(e.path); assertDigest(e.targetDigest, candidateDigest, 'Evidence candidate'); }
  for (const r of results.values()) {
    const o = obligations.get(r.obligationId);
    assertDigest(r.targetDigest, candidateDigest, 'Result candidate');
    need(r.method === o.method, 'INVALID_INPUT', 'Verification method changed.');
    refsExist(r.evidenceRefs, evidence, 'result evidence');
    if (r.executionStatus === 'EXECUTED') {
      need(r.result !== 'UNKNOWN' && r.evidenceRefs.length > 0, 'INVALID_INPUT', 'Executed result requires an observed PASS/FAIL and evidence.');
      need(r.environmentRef === o.requiredEnvironment, 'INVALID_INPUT', 'Verification environment does not match frozen plan.');
      for (const id of r.evidenceRefs) {
        const e = evidence.get(id);
        need(e.kind === r.method && e.environmentRef === r.environmentRef, 'INVALID_INPUT', 'Evidence kind or environment does not match result.');
      }
    } else need(r.result === 'UNKNOWN' && r.evidenceRefs.length === 0, 'INVALID_INPUT', 'Non-executed work cannot claim PASS/FAIL or execution evidence.');
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
    refsExist(f.evidenceRefs, evidence, 'finding evidence');
    const resultEvidence = new Set(relevant.flatMap(o => results.get(o.id).evidenceRefs));
    for (const id of f.evidenceRefs) need(resultEvidence.has(id), 'INVALID_INPUT', 'Finding evidence is not connected to this invariant verification.');
    if (['SATISFIED','VIOLATED'].includes(f.status)) need(f.evidenceRefs.length > 0, 'INVALID_INPUT', 'A conclusive finding requires evidence.');
    if (f.status === 'SATISFIED') need(relevant.length > 0 && relevant.every(o => { const r = results.get(o.id); return r.executionStatus === 'EXECUTED' && r.result === 'PASS'; }), 'INVALID_INPUT', 'SATISFIED finding has incomplete or failing obligations.');
    if (f.status === 'VIOLATED') need(relevant.some(o => results.get(o.id).result === 'FAIL'), 'INVALID_INPUT', 'VIOLATED finding has no failing verification result.');
    if (inv.requirementLevel === 'required-invariant') {
      if (f.status === 'VIOLATED') { blocking.push(f.id); requiredViolation = true; }
      if (f.status === 'UNVERIFIED' || f.status === 'NOT_APPLICABLE') missingRequiredFinding = true;
      if (relevant.some(o => results.get(o.id).result === 'FAIL')) {
        requiredViolation = true;
        need(f.status === 'VIOLATED', 'INVALID_INPUT', 'A required failed verification cannot be hidden by another finding status.');
      }
    }
  }
  const expected = requiredViolation ? 'FAIL' : (unverified.length || missingRequiredFinding) ? 'BLOCKED' : 'PASS';
  need(sameSet(review.blockingFindingIds, blocking), 'INVALID_INPUT', 'Blocking finding list is inaccurate.');
  need(sameSet(review.unverifiedRequiredObligationIds, unverified), 'INVALID_INPUT', 'Unverified obligation list is inaccurate.');
  need(review.verdict === expected, 'INVALID_INPUT', `Review verdict must be ${expected}.`);
  return { verdict: expected, blockingFindingIds: blocking, unverifiedRequiredObligationIds: unverified, requiredCount: requiredObligationIds.length };
}
export function validateCandidate(candidate) {
  validateSchema('cs-candidate', candidate);
  uniqueBy(candidate.files, 'path', 'candidate file');
  candidate.files.forEach(x => portablePath(x.path));
  need(candidate.files.every((x, i) => i === 0 || candidate.files[i-1].path < x.path), 'INVALID_INPUT', 'Candidate file paths must be sorted.');
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
  for (const ref of candidate.files) { readArtifact(root, ref); count++; }
  const assessment = validateReviewReport(review, { constraint, candidateDigest, pack });
  for (const ref of review.evidence) { readArtifact(root, ref); count++; }
  return {
    schemaVersion: '1.0.0', kind: 'cs-bundle-check', verdict: assessment.verdict,
    canProceedUnderSuppliedPolicy: policy.mode === 'observe' || assessment.verdict === 'PASS',
    mode: policy.mode, schemaEngine, knowledgePackDigest: pack.digest,
    candidateDigest, constraintReportDigest: hashJson(constraint), checkedRawFiles: count,
    requiredObligationCount: assessment.requiredCount,
    assurance: 'Structural and semantic consistency plus raw-file digests. Not proof of test execution, source correctness, policy authority, independent audit, or MCP all-path enforcement.'
  };
}
export function providerResult(output, artifacts = []) {
  return { schemaVersion: '1.0.0', kind: 'output', output, artifacts,
    error: ['FAIL','NEEDS_REDESIGN'].includes(output.verdict) ? { code:'GATE_FAILED',message:'CS conditions are violated.',details:null }
      : ['BLOCKED','NEEDS_INPUT'].includes(output.verdict) ? {code:'MISSING_EVIDENCE',message:'CS input or verification is incomplete.',details:null} : null };
}
export function adapterError(error) {
  return { schemaVersion:'1.0.0',kind:'adapter-error',output:null,artifacts:[],error:{code:error instanceof CsError ? error.code : 'INVALID_INPUT',message:error instanceof CsError ? error.message : 'Unable to read or validate CS input.',details:error instanceof CsError ? error.details : null} };
}
