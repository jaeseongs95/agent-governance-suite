import { existsSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashBytes, hashJson, canonicalJson, portablePath, readBoundedFile, parseJson, readArtifact, sameSet, uniqueBy, requireCondition as need } from './io.mjs';
import { validateSchema, schemaEngine } from './schema.mjs';
import { hostText } from '../i18n.mjs';
export { schemaEngine };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const KNOWLEDGE = 'skills/orchestrator/references/engineering-practices';
export const LIMITATIONS = [
  'This is an unsigned local consistency check, not host attestation or an independent audit.',
  'Snapshots bind only explicitly declared files; environment, dependencies outside scope and omitted Git changes require separate review.',
  'Semantic correctness, test oracle quality, assertion causality and review completeness remain reviewer responsibilities.'
];
const noDigest = obj => Object.fromEntries(Object.entries(obj).filter(([key]) => key !== 'digest'));
export const seal = obj => ({ ...noDigest(obj), digest: hashJson(noDigest(obj)) });
const validDigest = s => typeof s === 'string' && /^sha256:[a-f0-9]{64}$/u.test(s);
function paths(values, label, allowEmpty = false) {
  need(Array.isArray(values) && (allowEmpty || values.length > 0), 'INVALID_INPUT', 'practices.core.emptyPathSet', { label });
  values.forEach(v => { const parts = portablePath(v); need(!parts.some(p => p.toLowerCase() === '.git'), 'INVALID_INPUT', 'practices.core.gitInternalsAreOutOfSnapshot'); });
  need(new Set(values.map(v => v.toLowerCase())).size === values.length, 'INVALID_INPUT', 'practices.core.duplicatePaths', { label });
}
function uniqueStrings(values, label) {
  need(new Set(values).size === values.length && values.every(x => typeof x === 'string' && x.trim()), 'INVALID_INPUT', 'practices.core.duplicateIdentifier', { label });
}
export function captureSnapshot(root, selectedPaths) {
  paths(selectedPaths, 'snapshot');
  need(selectedPaths.length <= 1000, 'INVALID_INPUT', 'practices.core.snapshotIsLimitedTo1000Declared');
  let total = 0;
  const files = [...selectedPaths].sort().map(p => {
    const data = readBoundedFile(root, p, 8 * 1024 * 1024);
    total += data.length; need(total <= 64 * 1024 * 1024, 'INVALID_INPUT', 'practices.core.snapshotExceeds64Mib');
    const text = isUtf8(data) && !data.includes(0) ? data.toString('utf8') : null;
    const lineCount = text === null || text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return { path: p, digest: hashBytes(data), size: data.length, lineCount };
  });
  return seal({ schemaVersion: '1.0.0', kind: 'engineering-snapshot', files });
}
export function assertSnapshot(snapshot) {
  validateSchema('engineering-snapshot', snapshot);
  paths(snapshot.files.map(x => x.path), 'snapshot');
  need(snapshot.files.length <= 1000, 'INVALID_INPUT', 'practices.core.tooManySnapshotFiles');
  need(snapshot.files.every(f => Number.isSafeInteger(f.size) && f.size >= 0 && f.size <= 8 * 1024 * 1024 && Number.isSafeInteger(f.lineCount) && f.lineCount >= 0 && f.lineCount <= f.size), 'INVALID_INPUT', 'practices.core.invalidSnapshotSizesOrLines');
  need(snapshot.files.reduce((n, f) => n + f.size, 0) <= 64 * 1024 * 1024, 'INVALID_INPUT', 'practices.core.snapshotExceedsTotalBound');
  need(canonicalJson(snapshot.files.map(f => f.path)) === canonicalJson(snapshot.files.map(f => f.path).sort()), 'INVALID_INPUT', 'practices.core.snapshotPathsMustBeSorted');
  need(snapshot.digest === hashJson(noDigest(snapshot)), 'INTEGRITY_FAILED', 'practices.core.snapshotDigestMismatch');
  return snapshot;
}
export function verifySnapshot(root, snapshot) {
  assertSnapshot(snapshot);
  need(captureSnapshot(root, snapshot.files.map(f => f.path)).digest === snapshot.digest, 'INTEGRITY_FAILED', 'practices.core.currentFilesDifferFromTheDeclared');
  return snapshot;
}
export function snapshotDelta(base, head) {
  assertSnapshot(base); assertSnapshot(head);
  const a = new Map(base.files.map(f => [f.path, f.digest])), b = new Map(head.files.map(f => [f.path, f.digest]));
  return [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).sort();
}
export function validatePlan(plan) {
  validateSchema('engineering-test-plan', plan);
  uniqueStrings(plan.requirements, 'requirements'); paths(plan.scopeFiles, 'scopeFiles');
  uniqueBy(plan.cases, 'id', 'case');
  const covered = new Set();
  for (const c of plan.cases) {
    uniqueStrings(c.requirementIds, 'requirementIds'); paths(c.testFiles, 'testFiles');
    need(c.argv.every(a => !a.includes('\0')), 'INVALID_INPUT', 'practices.core.nulInFrozenCaseArgv');
    for (const id of c.requirementIds) { need(plan.requirements.includes(id), 'INVALID_INPUT', 'practices.core.unknownRequirementInCase', { caseId: c.id }); covered.add(id); }
    need(c.testFiles.every(p => plan.scopeFiles.includes(p)), 'INVALID_INPUT', 'practices.core.caseTestFileOutsideScope', { caseId: c.id });
    need(c.id.trim() && c.oracle.trim() && c.sensitivityReason.trim(), 'INVALID_INPUT', 'practices.core.caseIdentityOracleAndSensitivityRationale');
  }
  need(plan.requirements.every(id => covered.has(id)), 'INVALID_INPUT', 'practices.core.aRequirementHasNoTestCase');
  const result = { schemaVersion: '1.0.0', kind: 'engineering-plan-result', verdict: 'READY', planDigest: hashJson(plan), caseIds: plan.cases.map(c => c.id) };
  return validateSchema('engineering-plan-result', result);
}
function exactIso(s) { const n = Date.parse(s); return Number.isFinite(n) && new Date(n).toISOString() === s; }
export function assertReceipt(receipt) {
  validateSchema('engineering-run-receipt', receipt); assertSnapshot(receipt.snapshot);
  need(receipt.argv.every(a => !a.includes('\0')), 'INVALID_INPUT', 'practices.core.nulInArgv');
  need(receipt.executable === receipt.argv[0], 'INVALID_INPUT', 'practices.core.receiptExecutableDiffersFromArgv0');
  need(exactIso(receipt.startedAt) && exactIso(receipt.finishedAt) && receipt.finishedAt >= receipt.startedAt, 'INVALID_INPUT', 'practices.core.invalidReceiptTimestamps');
  need(Number.isSafeInteger(receipt.timeoutMs) && receipt.timeoutMs >= 1 && receipt.timeoutMs <= 300000, 'INVALID_INPUT', 'practices.core.invalidTimeoutBound');
  need(receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode), 'INVALID_INPUT', 'practices.core.unsafeExitCode');
  need(receipt.stdoutDigest === hashBytes(receipt.stdout) && receipt.stderrDigest === hashBytes(receipt.stderr), 'INTEGRITY_FAILED', 'practices.core.receiptLogDigestMismatch');
  need(receipt.digest === hashJson(noDigest(receipt)), 'INTEGRITY_FAILED', 'practices.core.receiptDigestMismatch');
  if (receipt.status === 'PASS') need(receipt.exitCode === 0 && receipt.signal === null && receipt.snapshot.digest === receipt.afterDigest, 'INVALID_INPUT', 'practices.core.falsePassingReceipt');
  if (receipt.status === 'FAIL') need(receipt.exitCode !== null && receipt.exitCode !== 0 && receipt.signal === null && receipt.snapshot.digest === receipt.afterDigest, 'INVALID_INPUT', 'practices.core.nonAssertingProcessFailureCannotMasquerade');
  if (receipt.status === 'INPUT_CHANGED') need(receipt.snapshot.digest !== receipt.afterDigest, 'INVALID_INPUT', 'practices.core.inputChangedRequiresDifferentInputs');
  return receipt;
}
function loadReceipt(root, ref) {
  portablePath(ref.path); need(validDigest(ref.digest), 'INVALID_INPUT', 'practices.core.invalidReceiptReference');
  return assertReceipt(parseJson(readArtifact(root, ref, 8 * 1024 * 1024)));
}
export function validateProof(root, plan, proof) {
  validatePlan(plan); validateSchema('engineering-test-proof', proof);
  need(proof.planDigest === hashJson(plan), 'INTEGRITY_FAILED', 'practices.core.proofBelongsToADifferentFrozen');
  verifySnapshot(root, proof.candidate);
  need(sameSet(plan.scopeFiles, proof.candidate.files.map(f => f.path)), 'INVALID_INPUT', 'practices.core.candidateFileSetDiffersFromThe');
  const records = uniqueBy(proof.proofs, 'caseId', 'proof');
  need(sameSet([...records.keys()], plan.cases.map(c => c.id)), 'INVALID_INPUT', 'practices.core.proofCasesDoNotExactlyMatch');
  const allTestPaths = new Set(plan.cases.flatMap(c => c.testFiles));
  const issues = []; let incomplete = false;
  for (const c of plan.cases) {
    const p = records.get(c.id); paths(p.mutationPaths, 'mutationPaths', true);
    if (p.status === 'NOT_RUN' || p.status === 'EXEMPT') {
      need(p.red.path === '' && p.green.path === '' && p.mutationPaths.length === 0 && p.assertionWitness === '' && p.reason.trim(), 'INVALID_INPUT', 'practices.core.aNonExecutedProofCannotCarry');
      if (p.status === 'EXEMPT') need(c.sensitivity === 'not-applicable', 'INVALID_INPUT', 'practices.core.exemptionWasNotInTheFrozen');
      if (p.status === 'NOT_RUN') { issues.push(`${c.required ? 'REQUIRED' : 'OPTIONAL'} ${c.id}: NOT_RUN — ${p.reason}`); if (c.required) incomplete = true; }
      continue;
    }
    need(['red-green', 'mutation'].includes(c.sensitivity), 'INVALID_INPUT', 'practices.core.demonstrationConflictsWithThePlannedMethod');
    need(p.red.path !== p.green.path && p.red.digest !== p.green.digest && p.assertionWitness.trim().length >= 4, 'INVALID_INPUT', 'practices.core.distinctRedGreenReceiptsAndA');
    const red = loadReceipt(root, p.red), green = loadReceipt(root, p.green);
    need(red.status === 'FAIL' && green.status === 'PASS', 'INVALID_INPUT', 'practices.core.proofRequiresOrdinaryFailingRedAnd');
    need(green.snapshot.digest === proof.candidate.digest && green.afterDigest === proof.candidate.digest, 'INTEGRITY_FAILED', 'practices.core.greenEvidenceIsForADifferent');
    need(red.snapshot.digest !== green.snapshot.digest, 'INVALID_INPUT', 'practices.core.noProductionMutationIsRepresented');
    need(canonicalJson(red.argv) === canonicalJson(green.argv), 'INVALID_INPUT', 'practices.core.redAndGreenCommandsDiffer');
    need(canonicalJson(red.argv) === canonicalJson(c.argv) && canonicalJson(green.argv) === canonicalJson(c.argv), 'INVALID_INPUT', 'practices.core.redAndGreenCommandsMustMatch');
    need(red.environmentNote === green.environmentNote && red.nodeVersion === green.nodeVersion && red.platform === green.platform && red.executable === green.executable, 'INVALID_INPUT', 'practices.core.declaredExecutionEnvironmentsDiffer');
    need(red.finishedAt <= green.startedAt, 'INVALID_INPUT', 'practices.core.greenMustFollowTheRecordedRed');
    need(sameSet(red.snapshot.files.map(f => f.path), proof.candidate.files.map(f => f.path)), 'INVALID_INPUT', 'practices.core.redAndGreenFileSetsDiffer');
    const delta = snapshotDelta(red.snapshot, green.snapshot);
    need(delta.length > 0 && sameSet(delta, p.mutationPaths) && delta.every(f => !allTestPaths.has(f)), 'INVALID_INPUT', 'practices.core.mutationMustExactlyDescribeProductionChanges');
    need(c.testFiles.every(f => red.snapshot.files.find(x => x.path === f)?.digest === green.snapshot.files.find(x => x.path === f)?.digest), 'INTEGRITY_FAILED', 'practices.core.testCodeDiffersBetweenRedAnd');
    need((red.stdout + '\n' + red.stderr).includes(p.assertionWitness), 'INVALID_INPUT', 'practices.core.theClaimedAssertionWitnessIsAbsent');
  }
  return validateSchema('engineering-test-result', { schemaVersion: '1.0.0', kind: 'engineering-test-result', verdict: incomplete ? 'INCOMPLETE' : 'CONSISTENT', targetDigest: proof.candidate.digest, reportDigest: hashJson(proof), issues, limitations: LIMITATIONS });
}
export function validateReviewRequest(request) {
  validateSchema('engineering-review-request', request); assertSnapshot(request.base); assertSnapshot(request.head);
  paths(request.changedFiles, 'changedFiles'); paths(request.excludedFiles, 'excludedFiles', true); uniqueStrings(request.requirements, 'requirements');
  need(sameSet(snapshotDelta(request.base, request.head), request.changedFiles), 'INVALID_INPUT', 'practices.core.changedFileInventoryOmitsOrInvents');
  need(request.excludedFiles.every(p => request.changedFiles.includes(p)), 'INVALID_INPUT', 'practices.core.excludedPathIsNotInThe');
  need(request.changedFiles.some(p => !request.excludedFiles.includes(p)), 'INVALID_INPUT', 'practices.core.theRequestExcludesItsEntireReview');
  return request;
}
export function validateReview(root, request, report) {
  validateReviewRequest(request); validateSchema('engineering-review-report', report);
  need(report.requestDigest === hashJson(request) && report.headDigest === request.head.digest, 'INTEGRITY_FAILED', 'practices.core.reviewDoesNotBindThisRequest');
  verifySnapshot(root, request.head);
  for (const f of request.base.files.filter(f => !request.head.files.some(h => h.path === f.path))) {
    need(!existsSync(path.join(root, ...portablePath(f.path))), 'INTEGRITY_FAILED', 'practices.core.aSupposedlyDeletedFileIsStill');
  }
  const coverage = uniqueBy(report.coverage, 'path', 'coverage');
  need(sameSet([...coverage.keys()], request.changedFiles), 'INVALID_INPUT', 'practices.core.everyChangedFileMustBeReviewed');
  uniqueBy(report.findings, 'id', 'finding');
  const issues = []; let incomplete = false, blocking = false;
  for (const [p, c] of coverage) {
    need(c.reason.trim(), 'INVALID_INPUT', 'practices.core.coverageRequiresAReasonScopeNote');
    if (request.excludedFiles.includes(p)) need(c.status === 'NOT_REVIEWED', 'INVALID_INPUT', 'practices.core.anExcludedFileCannotBeCounted');
    if (c.status === 'NOT_REVIEWED') { issues.push(`${request.excludedFiles.includes(p) ? 'EXCLUDED' : 'UNREVIEWED'} ${p}: ${c.reason}`); if (!request.excludedFiles.includes(p)) incomplete = true; }
  }
  for (const f of report.findings) {
    portablePath(f.path);
    need(coverage.get(f.path)?.status === 'REVIEWED', 'INVALID_INPUT', 'practices.core.findingPointsAtAnUnreviewedOr');
    const source = (f.side === 'head' ? request.head : request.base).files.find(x => x.path === f.path);
    need(source && Number.isSafeInteger(f.lineStart) && Number.isSafeInteger(f.lineEnd) && f.lineStart >= 1 && f.lineEnd >= f.lineStart && f.lineEnd <= source.lineCount, 'INVALID_INPUT', 'practices.core.findingLineRangeIsOutsideThe');
    need([f.id, f.contract, f.trace, f.impact, f.correction].every(x => x.trim()), 'INVALID_INPUT', 'practices.core.findingHasMissingReasoningOrIdentity');
    if (f.category === 'recommendation' || f.confidence === 'hypothesis') need(!f.blocking, 'INVALID_INPUT', 'practices.core.recommendationsAndUnsupportedHypothesesCannotBe');
    if (f.blocking) { need(f.category === 'defect', 'INVALID_INPUT', 'practices.core.blockingItemIsNotADefect'); blocking = true; }
  }
  for (const h of report.handoffs) { portablePath(h.path); need(request.changedFiles.includes(h.path) && h.owner.trim() && h.reason.trim(), 'INVALID_INPUT', 'practices.core.invalidSpecialistHandoff'); }
  const verdict = blocking ? 'CHANGES_REQUESTED' : incomplete ? 'INCOMPLETE' : 'NO_BLOCKING_FINDINGS';
  return validateSchema('engineering-review-result', { schemaVersion: '1.0.0', kind: 'engineering-review-result', verdict, targetDigest: request.head.digest, reportDigest: hashJson(report), issues, limitations: [...LIMITATIONS, 'Reviewer independence is declared, not verified by this package. NO_BLOCKING_FINDINGS is not release approval.'] });
}
export function loadCatalog() {
  const catalog = parseJson(readBoundedFile(ROOT, KNOWLEDGE + '/catalog.json'));
  const sources = parseJson(readBoundedFile(ROOT, KNOWLEDGE + '/sources.lock.json'));
  need(catalog.schemaVersion === '1.0.0' && sources.schemaVersion === '1.0.0', 'INVALID_INPUT', 'practices.core.unknownCatalogFormat');
  uniqueBy(catalog.rules, 'id', 'rule'); const sourceMap = uniqueBy(sources.sources, 'id', 'source');
  for (const r of catalog.rules) {
    need(r.sourceIds.length && r.sourceIds.every(id => sourceMap.has(id)), 'INVALID_INPUT', 'practices.core.unknownRuleSource');
    need(['title', 'appliesWhen', 'action', 'evidence', 'avoid', 'exceptions', 'owner', 'module'].every(k => typeof r[k] === 'string' && r[k].trim()), 'INVALID_INPUT', 'practices.core.incompleteRuleCard');
  }
  for (const s of sources.sources) {
    need(/^[a-f0-9]{40}$/u.test(s.commit) && /^[a-f0-9]{40}$/u.test(s.gitBlobSha) && s.url.includes('/blob/' + s.commit + '/') && s.license === 'MIT', 'INVALID_INPUT', 'practices.core.unpinnedOrUnsupportedSource');
    readBoundedFile(ROOT, s.licenseFile);
  }
  return catalog;
}
export function selfCheck() {
  const catalog = loadCatalog();
  const modules = [...new Set(catalog.rules.map(r => r.module))];
  const lock = parseJson(readBoundedFile(ROOT, 'runtime/engineering-practices/CONTENT_LOCK.json'));
  for (const f of lock.files) readArtifact(ROOT, f, 8 * 1024 * 1024);
  need(new Set(lock.files.map(f => f.path)).size === lock.files.length, 'INVALID_INPUT', 'practices.core.duplicateContentLockPath');
  return { status: 'CONTENT_CONSISTENT', rules: catalog.rules.length, modules, schemaEngine, lockedFiles: lock.files.length, hostBehaviorEvaluation: 'NOT_RUN' };
}
export function providerResult(capability, result, locator, artifactDigest = hashBytes(JSON.stringify(result, null, 2) + '\n')) {
  portablePath(locator);
  const mapping = {
    'test-plan-validation': ['engineering-plan-result', 'engineering-plan-result'],
    'test-sensitivity-review': ['engineering-test-result', 'engineering-test-result'],
    'change-code-review': ['engineering-review-result', 'engineering-review-result']
  };
  need(Object.hasOwn(mapping, capability), 'INVALID_INPUT', 'practices.core.unsupportedCapability');
  const [schema, artifactId] = mapping[capability]; validateSchema(schema, result); need(validDigest(artifactDigest), 'INVALID_INPUT', 'practices.core.invalidSerializedArtifactDigest');
  const isFailed = result.verdict === 'CHANGES_REQUESTED', isBlocked = result.verdict === 'INCOMPLETE';
  return { schemaVersion: '1.0.0', kind: 'output', output: result,
    artifacts: [{ artifactId, schemaId: 'https://skill-suite.local/contracts/' + schema + '.v1.schema.json', locator, digest: artifactDigest, targetDigest: result.targetDigest ?? result.planDigest, verified: false }],
    error: isFailed || isBlocked ? { code: isFailed ? 'GATE_FAILED' : 'MISSING_EVIDENCE', message: hostText(isFailed ? 'practices.core.blockingFindingsRemain' : 'practices.core.requiredEvidenceIncomplete'), details: { issues: result.issues ?? [] } } : null };
}
