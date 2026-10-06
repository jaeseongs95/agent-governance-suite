import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { captureSnapshot, verifySnapshot, assertSnapshot, snapshotDelta, validatePlan, validateProof, validateReviewRequest, validateReview, assertReceipt, seal, providerResult } from '../../runtime/engineering-practices/core.mjs';
import { hashBytes } from '../../runtime/engineering-practices/io.mjs';
import { fixture, writeJson, H } from './helpers.mjs';
const fail = fn => assert.throws(fn);
function finding(overrides = {}) { return { id: 'F1', path: 'sample/page.mjs', side: 'head', lineStart: 1, lineEnd: 1, category: 'defect', severity: 'high', confidence: 'supported', blocking: true, title: 'Fixture finding', contract: 'Fixture contract', trace: 'Fixture explicit path', impact: 'Fixture observable effect', correction: 'Fixture minimal fix', ...overrides }; }
test('real red/green example is consistent', t => { const f = fixture(t); assert.equal(f.red.status, 'FAIL'); assert.equal(f.green.status, 'PASS'); assert.equal(validateProof(f.root, f.plan, f.proof).verdict, 'CONSISTENT'); });
test('plan maps each requirement to a case', t => { const f = fixture(t); assert.equal(validatePlan(f.plan).verdict, 'READY'); f.plan.requirements.push('missing'); fail(() => validatePlan(f.plan)); });
test('duplicate case IDs rejected', t => { const f = fixture(t); f.plan.cases.push(f.plan.cases[0]); fail(() => validatePlan(f.plan)); });
test('unknown requirement rejected', t => { const f = fixture(t); f.plan.cases[0].requirementIds = ['unknown']; fail(() => validatePlan(f.plan)); });
test('test file outside scope rejected', t => { const f = fixture(t); f.plan.cases[0].testFiles = ['unscoped.mjs']; fail(() => validatePlan(f.plan)); });
test('plan digest drift rejected', t => { const f = fixture(t); f.proof.planDigest = H('another-plan'); fail(() => validateProof(f.root, f.plan, f.proof)); });
test('extra input keys rejected', t => { const f = fixture(t); f.plan.approval = true; fail(() => validatePlan(f.plan)); });
test('candidate bytes must match snapshot', t => { const f = fixture(t); writeFileSync(path.join(f.root, 'sample/page.mjs'), 'changed\n'); fail(() => verifySnapshot(f.root, f.proof.candidate)); });
test('snapshot digest forgery rejected', t => { const f = fixture(t); f.proof.candidate.digest = H('wrong'); fail(() => assertSnapshot(f.proof.candidate)); });
test('snapshot path case collisions rejected', t => { const f = fixture(t); f.proof.candidate.files.push({ ...f.proof.candidate.files[0], path: 'Sample/page.mjs' }); f.proof.candidate = seal(f.proof.candidate); fail(() => assertSnapshot(f.proof.candidate)); });
test('missing proof case rejected', t => { const f = fixture(t); f.proof.proofs = []; fail(() => validateProof(f.root, f.plan, f.proof)); });
test('duplicate proof case rejected', t => { const f = fixture(t); f.proof.proofs.push(f.proof.proofs[0]); fail(() => validateProof(f.root, f.plan, f.proof)); });
test('raw receipt tampering rejected', t => { const f = fixture(t); writeFileSync(path.join(f.root, f.proof.proofs[0].green.path), '{}'); fail(() => validateProof(f.root, f.plan, f.proof)); });
test('red must actually fail, not pass', t => { const f = fixture(t); const r = seal({ ...f.red, status: 'PASS', exitCode: 0 }); f.proof.proofs[0].red = writeJson(f.root, 'evidence/red-new.json', r); fail(() => validateProof(f.root, f.plan, f.proof)); });
test('missing assertion witness rejected', t => { const f = fixture(t); f.proof.proofs[0].assertionWitness = 'NOT-IN-THE-LOG'; fail(() => validateProof(f.root, f.plan, f.proof)); });
test('changed command rejected', t => { const f = fixture(t); const r = seal({ ...f.red, argv: [...f.red.argv, '--different'] }); f.proof.proofs[0].red = writeJson(f.root, 'evidence/red-new.json', r); fail(() => validateProof(f.root, f.plan, f.proof)); });
test('changed declared environment rejected', t => { const f = fixture(t); const r = seal({ ...f.red, environmentNote: 'different' }); f.proof.proofs[0].red = writeJson(f.root, 'evidence/red-new.json', r); fail(() => validateProof(f.root, f.plan, f.proof)); });
test('changed test code in red rejected', t => { const f = fixture(t); const s = structuredClone(f.red.snapshot); s.files[1].digest = H('different test'); const r = seal({ ...f.red, snapshot: seal(s), afterDigest: seal(s).digest }); f.proof.proofs[0].red = writeJson(f.root, 'evidence/red-new.json', r); f.proof.proofs[0].mutationPaths.push('sample/page.test.mjs'); fail(() => validateProof(f.root, f.plan, f.proof)); });
test('old green candidate rejected', t => { const f = fixture(t); const r = seal({ ...f.green, snapshot: f.red.snapshot, afterDigest: f.red.snapshot.digest }); f.proof.proofs[0].green = writeJson(f.root, 'evidence/green-new.json', r); fail(() => validateProof(f.root, f.plan, f.proof)); });
test('missing mutation explanation rejected', t => { const f = fixture(t); f.proof.proofs[0].mutationPaths = []; fail(() => validateProof(f.root, f.plan, f.proof)); });
test('NOT_RUN required stays incomplete', t => { const f = fixture(t); f.proof.proofs[0] = { caseId: 'PAGE-1', status: 'NOT_RUN', red: { path: '', digest: H('') }, green: { path: '', digest: H('') }, mutationPaths: [], assertionWitness: '', reason: 'Execution not available.' }; assert.equal(validateProof(f.root, f.plan, f.proof).verdict, 'INCOMPLETE'); });
test('NOT_RUN optional does not silently block', t => { const f = fixture(t); f.plan.cases[0].required = false; f.proof.planDigest = H(f.plan); f.proof.proofs[0] = { caseId: 'PAGE-1', status: 'NOT_RUN', red: { path: '', digest: H('') }, green: { path: '', digest: H('') }, mutationPaths: [], assertionWitness: '', reason: 'Optional scope deferred.' }; const r = validateProof(f.root, f.plan, f.proof); assert.equal(r.verdict, 'CONSISTENT'); assert.match(r.issues[0], /OPTIONAL/); });
test('unplanned exemption rejected', t => { const f = fixture(t); f.proof.proofs[0] = { caseId: 'PAGE-1', status: 'EXEMPT', red: { path: '', digest: H('') }, green: { path: '', digest: H('') }, mutationPaths: [], assertionWitness: '', reason: 'Skip it.' }; fail(() => validateProof(f.root, f.plan, f.proof)); });
test('receipt log digest tampering rejected', t => { const f = fixture(t); f.green.stdout += 'forged'; f.green = seal(f.green); fail(() => assertReceipt(f.green)); });
test('false PASS with failing exit rejected', t => { const f = fixture(t); f.green.exitCode = 1; fail(() => assertReceipt(seal(f.green))); });
test('timeout cannot be used as a test red', t => { const f = fixture(t); const r = seal({ ...f.red, status: 'TIMED_OUT', exitCode: null, signal: 'SIGTERM' }); f.proof.proofs[0].red = writeJson(f.root, 'evidence/red-new.json', r); fail(() => validateProof(f.root, f.plan, f.proof)); });
test('invalid receipt time order rejected', t => { const f = fixture(t); f.green.finishedAt = '2000-01-01T00:00:00.000Z'; fail(() => assertReceipt(seal(f.green))); });
test('negative snapshot lines rejected', t => { const f = fixture(t); f.proof.candidate.files[0].lineCount = -1; fail(() => assertSnapshot(seal(f.proof.candidate))); });
test('review complete on the fixed snapshot', t => { const f = fixture(t); assert.equal(validateReview(f.root, f.request, f.report).verdict, 'NO_BLOCKING_FINDINGS'); });
test('missing review coverage rejected', t => { const f = fixture(t); f.report.coverage = []; fail(() => validateReview(f.root, f.request, f.report)); });
test('unreviewed required path stays incomplete', t => { const f = fixture(t); f.report.coverage[0].status = 'NOT_REVIEWED'; assert.equal(validateReview(f.root, f.request, f.report).verdict, 'INCOMPLETE'); });
test('blocking defect requests changes', t => { const f = fixture(t); f.report.findings.push(finding()); assert.equal(validateReview(f.root, f.request, f.report).verdict, 'CHANGES_REQUESTED'); });
test('recommendation cannot block', t => { const f = fixture(t); f.report.findings.push(finding({ category: 'recommendation' })); fail(() => validateReview(f.root, f.request, f.report)); });
test('hypothesis cannot block', t => { const f = fixture(t); f.report.findings.push(finding({ confidence: 'hypothesis' })); fail(() => validateReview(f.root, f.request, f.report)); });
test('nonblocking suggestion preserved', t => { const f = fixture(t); f.report.findings.push(finding({ category: 'recommendation', blocking: false })); assert.equal(validateReview(f.root, f.request, f.report).verdict, 'NO_BLOCKING_FINDINGS'); });
test('invalid finding line rejected', t => { const f = fixture(t); f.report.findings.push(finding({ lineEnd: 500 })); fail(() => validateReview(f.root, f.request, f.report)); });
test('unscoped finding rejected', t => { const f = fixture(t); f.report.findings.push(finding({ path: 'sample/page.test.mjs' })); fail(() => validateReview(f.root, f.request, f.report)); });
test('review request digest mismatch rejected', t => { const f = fixture(t); f.report.requestDigest = H('wrong request'); fail(() => validateReview(f.root, f.request, f.report)); });
test('review head mismatch rejected', t => { const f = fixture(t); f.report.headDigest = f.request.base.digest; fail(() => validateReview(f.root, f.request, f.report)); });
test('review inventory cannot omit a changed file', t => { const f = fixture(t); const b = structuredClone(f.request.base); b.files[1].digest = H('changed test baseline'); f.request.base = seal(b); fail(() => validateReviewRequest(f.request)); });
test('review cannot invent a changed path', t => { const f = fixture(t); f.request.changedFiles.push('not-present.txt'); fail(() => validateReviewRequest(f.request)); });
test('review cannot exclude entire scope', t => { const f = fixture(t); f.request.excludedFiles = [...f.request.changedFiles]; fail(() => validateReviewRequest(f.request)); });
test('duplicate finding ID rejected', t => { const f = fixture(t); f.report.findings = [finding(), finding()]; fail(() => validateReview(f.root, f.request, f.report)); });
test('snapshot delta includes additions and removals', t => { const f = fixture(t); const b = structuredClone(f.request.base); b.files[0].path = 'sample/old.mjs'; b.files.sort((a,b)=>a.path.localeCompare(b.path)); assert.deepEqual(snapshotDelta(seal(b),f.request.head), ['sample/old.mjs','sample/page.mjs']); });
test('provider adapter leaves artifact verification to AGS', t => { const f = fixture(t); const p = providerResult('test-sensitivity-review',f.testResult,'test-result.json'); assert.equal(p.artifacts[0].verified,false); assert.equal(p.error,null); assert.equal(p.artifacts[0].digest,hashBytes(JSON.stringify(f.testResult,null,2)+'\n')); });
test('provider rejects unknown capability', t => { const f=fixture(t); fail(()=>providerResult('release-approval',f.testResult,'result.json')); });

test('both resealed commands away from frozen plan rejected', t => {
  const f = fixture(t);
  for (const side of ['red', 'green']) {
    const argv = [process.execPath, '--test', 'other.test.mjs'];
    const receipt = seal({ ...f[side], argv, executable: argv[0] });
    f.proof.proofs[0][side] = writeJson(f.root, `evidence/${side}-other.json`, receipt);
  }
  assert.throws(() => validateProof(f.root, f.plan, f.proof), /frozen case argv/);
});
test('resealed executable and argv contradiction rejected', t => {
  const f = fixture(t);
  assert.throws(() => assertReceipt(seal({ ...f.green, executable: 'different-executable' })), /executable differs/);
});
test('case argv bounds and NUL rejected', t => {
  const f = fixture(t);
  for (const argv of [[], Array(129).fill('node'), [''], ['x'.repeat(8193)], ['node\0']]) {
    f.plan.cases[0].argv = argv;
    fail(() => validatePlan(f.plan));
  }
});
