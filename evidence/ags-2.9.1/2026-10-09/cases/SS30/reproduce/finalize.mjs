import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {validateProof} from '../../runtime/engineering-practices/core.mjs';
import {oracleDigest} from '../../tests/skill-classification/evaluation.ts';
const root = new URL('../../', import.meta.url).pathname;
const dir = root + 'evidence/SS30/';
const load = name => JSON.parse(readFileSync(dir + name, 'utf8'));
const save = (name, data) => writeFileSync(dir + name, JSON.stringify(data, null, 2) + '\n');
const sha = x => createHash('sha256').update(x).digest('hex');
const plan = load('engineering-test-plan.json'), snapshot = load('snapshot.json');
const proof = {schemaVersion: '1.0.0', kind: 'engineering-test-proof', planDigest: load('plan-check.json').planDigest,
  candidate: snapshot, proofs: plan.cases.map(c => ({caseId: c.id, status: 'NOT_RUN', red: {path: '', digest: 'sha256:' + '0'.repeat(64)},
    green: {path: '', digest: 'sha256:' + '0'.repeat(64)}, mutationPaths: [], assertionWitness: '',
    reason: 'Candidate tests were executed and two real assertion failures captured. Regression sensitivity red/green or mutation proof was not performed: product edits are prohibited and no fixed green candidate is provided.'}))};
save('engineering-test-proof.json', proof);
save('engineering-test-result.json', validateProof(root, plan, proof));
const actualReports = [load('existing-vitest.json'), load('new-vitest.json')];
const checks = actualReports.flatMap(report => report.testResults.flatMap(file => file.assertionResults));
const result = load('SS30.result.json');
const corpus = JSON.parse(readFileSync(root + 'tests/skill-classification/fixtures.json', 'utf8'));
result.oracleDigestRecomputed = oracleDigest(corpus);
if (result.oracleDigestRecomputed !== 'sha256:' + result.oracleSHA256) throw new Error('SS30_ORACLE_DIGEST_MISMATCH');
function title(o) {
  if (o.path === 'fetch-rejection-extra-boundary') return 'SS30 connection-before-send confirmed only by pre-fetch credential failure; fetch rejection remains unknown';
  if (o.path === 'known-cost-invalid-response') return 'SS30 RED known valid cost is retained when candidate judgment is missing';
  if (o.path === 'unbound-unresolvedItems') return 'SS30 RED semantic uncertainty must bind the uncertain skill to unresolvedItems';
  if (o.path.startsWith('common-RESP-')) return `SS30 semantic refusal ${o.path.slice(12)} preserves bound unresolved evidence and skips fallback`;
  return `SS30 ${o.variantId} ${o.path}`;
}
for (const v of result.variants) {
  for (const o of v.observations) {
    const check = checks.find(c => c.title === title(o));
    o.testTitle = title(o); o.testStatus = check?.status ?? 'NOTRUN';
    if (!check) throw new Error('MISSING_OBSERVATION_ASSERTION_BINDING: ' + o.testTitle);
  }
  v.status = v.observations.some(o => o.testStatus === 'failed') ? 'FAIL' : v.observations.every(o => o.testStatus === 'passed') ? 'PASS_OFFLINE' : 'NOTRUN';
}
result.status = result.variants.some(v => v.status === 'FAIL') ? 'FAIL' : 'PASS_OFFLINE';
result.counts = actualReports.map((r,i) => ({executionKind: i ? 'new-offline-mock' : 'existing-regression', totalCollected: r.numTotalTests,
  executed: r.numPassedTests + r.numFailedTests, passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests}));
result.boundaries.hostToolDiscovery = {checkedNames: ['get_skill_inventory', 'classify_skills', 'record_skill_selection'], matchedAvailableTools: []};
result.boundaries.classificationConfigPresent = Boolean(process.env.AGENT_GOVERNANCE_CLASSIFICATION_CONFIG);
result.hostSupport = {
  executionStatus: 'NOTRUN', specRequiresHostLiveForSS30: false,
  initializationPath: 'mcp-server/src/index.ts:88 -> AGENT_GOVERNANCE_CLASSIFICATION_CONFIG -> readClassificationRuntime -> loadClassificationProviderRuntime',
  remotePath: 'ApprovedRouteClassificationProvider with approved runtime route; built-in remote adapter only jev-noul-v1. A current-vendor wire adapter must be registered explicitly.',
  nativePath: 'nativeAdapterDefinitionsRef -> createNativeClassificationAdapters -> resolveNativeClassificationAdapter; host-vetted isolationArgs, retry/capability/isolation evidence, executable and fixed qualified model/effort required.',
  selectionPath: 'get_skill_inventory -> classify_skills -> AGENT review -> record_skill_selection(hostReceipt=null). Runtime host task observation must bind actor/task/request/inventory/config/profile; server creates receipt from observed host call.',
  requiredInputs: ['Approved host installation and exposed AGS MCP tools', 'Source-confirmed prompt/context and current inventory',
    'Classification config and qualified fixed ProviderProfileRegistry', 'Approved providerRuntimeRef with budgets and approved routes',
    'Registered structured current-vendor adapter or qualified native adapter definition plus allowance',
    'Actual host signed runtime task/call observation and selection/read/applied/verified evidence'],
  note: 'No installed CLI existence or mock response is treated as an approved or observed live integration.'
};
result.findings[0] = {...result.findings[0], severity: 'material accounting defect', sourceLocations: ['mcp-server/src/skill-classification/service.ts:194', 'mcp-server/src/skill-classification/service.ts:204', 'mcp-server/src/skill-classification/service.ts:210'],
  expected: {jevUsageActualCostUsd: .1, jevSpentUsd: .1, pendingJevReservation: false}, observed: {jevUsageActualCostUsd: null, jevSpentUsd: 0, pendingJevReservationUsd: .4},
  evidence: 'observations.json known-cost-invalid-response; new-vitest.json failing assertion', limitation: 'Pending .4 reservation remains conservative; this probe does not demonstrate overspending.'};
result.findings[1] = {...result.findings[1], severity: 'unresolved-evidence contract gap', sourceLocations: ['mcp-server/src/skill-classification/validation.ts:44', 'mcp-server/src/skill-classification/validation.ts:51', 'mcp-server/src/skill-classification/service.ts:152'],
  expected: 'A PARTIAL semantic refusal binds beta to unresolvedItems; otherwise reject incomplete common RESP and fallback.',
  observed: {validationErrors: [], status: 'PARTIAL', betaJudgment: 'uncertain', betaUncertaintyReason: 'MODEL_REFUSAL', unresolvedItems: [], mockVendorCalls: 0},
  evidence: 'observations.json unbound-unresolvedItems; new-vitest.json failing assertion', limitation: 'uncertaintyReason still exists on judgment; unresolved evidence is incompletely bound rather than erased entirely.'};
result.evidence = [...new Set([...result.evidence, 'engineering-test-proof.json', 'engineering-test-result.json', 'REPORT.ko.md', 'existing-regression.setup-error.json', 'new-offline-mock.setup-error.json'])];
result.setupAttempts = ['existing-regression.setup-error.json', 'new-offline-mock.setup-error.json'].map(load);
result.setupNote = 'Initial pnpm launcher failed before collecting tests; recorded as SPAWN_ERROR. The installed existing Vitest 5 CLI was then invoked directly. Setup errors are not product red results.';
const status = spawnSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'});
const diff = spawnSync('git', ['diff', '--exit-code'], {cwd: root, encoding: 'utf8'});
result.finalVerification = {trackedProductDiffExitCode: diff.status, gitStatus: status.stdout.trim(), addedScope: 'evidence/SS30 plus dependency symlink only',
  productEdits: 0, push: 0, PR: 0, releases: 0, live21Reruns: 0};
save('SS30.result.json', result);
save('checks-summary.json', {variants: result.variants.map(v => ({variantId: v.variantId, status: v.status, probeCount: v.observations.length})), counts: result.counts,
  assertionFailures: checks.filter(c => c.status === 'failed').map(c => ({title: c.title, failureMessages: c.failureMessages})),
  selected: 'NOTRUN', read: 'NOTRUN', applied: 'NOTRUN', verified: 'NOTRUN'});
save('artifact-digests.json', Object.fromEntries(readdirSync(dir).filter(f => f !== 'artifact-digests.json').sort().map(f => [f, 'sha256:' + sha(readFileSync(dir + f))])));
console.log(JSON.stringify({status: result.status, counts: result.counts, proofVerdict: load('engineering-test-result.json').verdict}, null, 2));
