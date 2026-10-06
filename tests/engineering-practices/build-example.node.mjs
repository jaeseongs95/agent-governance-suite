import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSnapshot, validatePlan, validateProof, validateReview } from '../../runtime/engineering-practices/core.mjs';
import { hashJson, hashBytes, requireCondition as need } from '../../runtime/engineering-practices/io.mjs';
import { runCommand } from '../../runtime/engineering-practices/runner.mjs';
const buggy = 'export function page(items, limit) { return items.slice(0, limit + 1); }\n';
const fixed = 'export function page(items, limit) { return items.slice(0, limit); }\n';
const testCode = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { page } from './page.mjs';\ntest('PAGE-1: returns exactly the requested prefix', () => {\n  assert.deepEqual(page([1, 2, 3], 2), [1, 2]);\n});\n`;
export function buildExample(root) {
  need(!existsSync(root) || readdirSync(root).length === 0, 'INVALID_INPUT', 'Example destination must be absent or empty.');
  mkdirSync(path.join(root, 'sample'), { recursive: true }); mkdirSync(path.join(root, 'evidence'), { recursive: true });
  const write = (p, x) => { const b = Buffer.from(JSON.stringify(x, null, 2) + '\n'); writeFileSync(path.join(root, p), b, { flag: 'wx' }); return { path: p, digest: hashBytes(b) }; };
  writeFileSync(path.join(root, 'sample/page.mjs'), buggy); writeFileSync(path.join(root, 'sample/page.test.mjs'), testCode);
  const files = ['sample/page.mjs', 'sample/page.test.mjs'];
  const base = captureSnapshot(root, files);
  const argv = [process.execPath, '--test', 'sample/page.test.mjs'];
  const red = runCommand(root, base, argv);
  need(red.status === 'FAIL' && (red.stdout + red.stderr).includes('ERR_ASSERTION'), 'INVALID_INPUT', 'Demo did not produce the intended assertion failure.');
  writeFileSync(path.join(root, 'sample/page.mjs'), fixed);
  const head = captureSnapshot(root, files), green = runCommand(root, head, argv);
  need(green.status === 'PASS', 'INVALID_INPUT', 'Demo fixed candidate did not pass.');
  const redRef = write('evidence/red.json', red), greenRef = write('evidence/green.json', green);
  const plan = { schemaVersion: '1.0.0', kind: 'engineering-test-plan', taskId: 'demo-page', contractDigest: hashJson({ requirement: 'For a positive in-range limit, return exactly that prefix of the input array.' }), requirements: ['R-PREFIX'], scopeFiles: files, runner: 'node --test', environment: 'Local offline Node.js, no external dependencies. This is a narrow positive-limit example, not a complete paginator.', cases: [{ id: 'PAGE-1', argv, requirementIds: ['R-PREFIX'], scenario: 'Three input items with limit two.', entryPoint: 'page(items, limit)', level: 'unit', expectedBehavior: 'Returns [1,2].', oracle: 'Literal expected prefix derived from the frozen requirement, not from implementation.', testFiles: ['sample/page.test.mjs'], required: true, sensitivity: 'red-green', sensitivityReason: 'An off-by-one production mutation must be detected by the same public-entry test.' }], exclusions: ['Validation of negative/non-integer limits is outside this deliberately narrow demonstration.'] };
  const proof = { schemaVersion: '1.0.0', kind: 'engineering-test-proof', planDigest: hashJson(plan), candidate: head, proofs: [{ caseId: 'PAGE-1', status: 'DEMONSTRATED', red: redRef, green: greenRef, mutationPaths: ['sample/page.mjs'], assertionWitness: 'ERR_ASSERTION', reason: 'The red assertion shows a third returned item; the same test passes after removing +1.' }] };
  const request = { schemaVersion: '1.0.0', kind: 'engineering-review-request', taskId: 'demo-page', contractDigest: plan.contractDigest, base, head, changedFiles: ['sample/page.mjs'], excludedFiles: [], requirements: ['R-PREFIX'] };
  const report = { schemaVersion: '1.0.0', kind: 'engineering-review-report', requestDigest: hashJson(request), headDigest: head.digest, reviewer: 'local-example-self-review', independence: 'self-review', coverage: [{ path: 'sample/page.mjs', status: 'REVIEWED', reason: 'The only changed expression now uses the exclusive slice boundary required by the declared positive-limit case.' }], findings: [], openQuestions: ['This example does not evaluate negative or non-integer limits.'], handoffs: [] };
  write('plan.json', plan); write('proof.json', proof); write('request.json', request); write('review.json', report);
  const planResult = validatePlan(plan), testResult = validateProof(root, plan, proof), reviewResult = validateReview(root, request, report);
  write('plan-result.json', planResult); write('test-result.json', testResult); write('review-result.json', reviewResult);
  write('files.json', files); write('snapshot.json', head);
  return { plan, proof, request, report, red, green, planResult, testResult, reviewResult };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { need(process.argv.length === 3, 'INVALID_INPUT', 'Pass one empty output directory.'); const r = buildExample(path.resolve(process.argv[2])); console.log(JSON.stringify({ status: 'EXAMPLE_EXECUTED', red: r.red.status, green: r.green.status, testResult: r.testResult.verdict, reviewResult: r.reviewResult.verdict, limitations: 'Single-case local example; not an independent audit or actual AGS host test.' }, null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 2; }
}
