import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {captureSnapshot, validatePlan} from '../../runtime/engineering-practices/core.mjs';
const root = new URL('../../', import.meta.url).pathname;
process.chdir(root);
const output = 'evidence/SS30/';
const sha = value => createHash('sha256').update(value).digest('hex');
const fixture = JSON.parse(readFileSync('tests/skill-classification/fixtures.json', 'utf8'));
const source = fixture.cases.find(x => x.caseId === 'SS30');
const git = args => spawnSync('git', args, {encoding: 'utf8'}).stdout.trim();
if (git(['rev-parse', 'HEAD']) !== 'c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6'
    || git(['rev-parse', 'HEAD^{tree}']) !== '28f2f2ed8a864405320f6d20e7bc5004e8466ad3'
    || sha(readFileSync('tests/skill-classification/fixtures.json')) !== '17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9'
    || fixture.oracleDigest !== 'sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055') throw new Error('SS30_PIN_MISMATCH');
const save = (name, data) => writeFileSync(output + name, JSON.stringify(data, null, 2) + '\n');
save('source.json', source);
const commands = [
  {id: 'existing-regression', argv: ['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/mcp/skill-classification-providers.test.ts', 'tests/mcp/skill-classification-service.test.ts', '-t',
    'SS30/32 HTTP (401|403|500) |SS28/30/32 (AUTH_UNAVAILABLE|API_UNAVAILABLE) |SS30 missing key availability|SS27/30 malformed and incomplete', '--reporter=json', '--outputFile=evidence/SS30/existing-vitest.json']},
  {id: 'new-offline-mock', argv: ['node', 'node_modules/vitest/vitest.mjs', 'run', 'evidence/SS30/SS30.test.ts', '--reporter=json', '--outputFile=evidence/SS30/new-vitest.json']},
];
const scopeFiles = ['tests/skill-classification/fixtures.json', 'tests/mcp/skill-classification-providers.test.ts', 'tests/mcp/skill-classification-service.test.ts',
  'mcp-server/src/skill-classification/providers.ts', 'mcp-server/src/skill-classification/service.ts', 'mcp-server/src/skill-classification/validation.ts',
  'mcp-server/src/skill-classification/request.ts', 'mcp-server/src/skill-classification/profiles.ts', 'mcp-server/src/skill-classification/types.ts',
  'evidence/SS30/SS30.test.ts', 'evidence/SS30/run.mjs'];
const plan = {schemaVersion: '1.0.0', kind: 'engineering-test-plan', taskId: 'SS30', contractDigest: `sha256:${sha(JSON.stringify(source))}`,
  requirements: source.variants.map(v => `SS30:${v}`), scopeFiles, runner: 'existing Vitest 5 runner; transport/credential boundary mocked',
  environment: `Node ${process.version}; independent SS30 worktree; UTC; no live provider or host calls`,
  cases: source.variants.map(id => ({id: `SS30:${id}`, requirementIds: [`SS30:${id}`], scenario: `Inject ${id}; retain failure diagnostics; test vendor fallback and final failure`,
    entryPoint: 'ApprovedRouteClassificationProvider.classify -> SkillClassificationService.classify', level: 'integration',
    expectedBehavior: 'Embedded SS30 failure mapping, no retries or hidden no-skill; failure and fallback distinct attempts; semantic uncertainty bound to unresolvedItems',
    oracle: 'SS30 embedded sourceSpec.fields only; oracle=null; synthetic probes do not establish classification accuracy',
    testFiles: ['evidence/SS30/SS30.test.ts'], required: true, sensitivity: 'manual-review',
    sensitivityReason: 'Observe fixed candidate behavior and assertion failures; no product mutations or green fix authorized; no regression sensitivity guarantee', argv: commands[1].argv})),
  exclusions: ['Other original cases and whole suite', 'Past 21 live runs', 'JEV/vendor/Claude live calls', 'Product edits, push, PR, release', 'Host selection receipt fabrication', 'Semantic golden score because SS30 oracle is null']};
save('engineering-test-plan.json', plan); save('plan-check.json', validatePlan(plan));
save('snapshot.json', captureSnapshot(root, scopeFiles));
const receipts = [];
for (const command of commands) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command.argv[0], command.argv.slice(1), {encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024});
  const receipt = {...command, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal,
    status: result.error ? 'SPAWN_ERROR' : result.status === 0 ? 'PASS' : 'FAIL', executionKind: command.id, API0: true,
    stdout: result.stdout, stderr: result.stderr, environment: {node: process.version, timezone: 'Etc/UTC'}, hostAttestation: false};
  save(`${command.id}.command.json`, receipt); receipts.push(receipt);
  console.log(`${command.id}: ${receipt.status}, exit ${result.status}`);
}
const reports = commands.map(c => JSON.parse(readFileSync(output + (c.id === 'existing-regression' ? 'existing' : 'new') + '-vitest.json', 'utf8')));
const observations = JSON.parse(readFileSync(output + 'observations.json', 'utf8'));
const tests = reports.flatMap(r => r.testResults.flatMap(file => file.assertionResults));
save('SS30.result.json', {caseId: 'SS30', status: 'FAIL', commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
  fixtureSHA256: sha(readFileSync('tests/skill-classification/fixtures.json')), oracleSHA256: fixture.oracleDigest.slice(7), originalPrompt: source.originalPrompt, oracle: source.oracle,
  executionKind: ['existing-regression', 'new-offline-mock'], API0: true, externalCalls: {JEV: 0, vendorAPI: 0, Claude: 0},
  counts: reports.map((r,i) => ({executionKind: commands[i].id, total: r.numTotalTests, passed: r.numPassedTests, failed: r.numFailedTests, pending: r.numPendingTests})),
  commands: receipts.map(({stdout, stderr, ...r}) => r),
  variants: source.variants.map(id => ({variantId: id, status: observations.filter(o => o.variantId === id).some(o =>
    tests.some(t => t.status === 'failed' && ((o.path === 'known-cost-invalid-response' && t.title.includes('known valid cost'))
      || (o.path === 'unbound-unresolvedItems' && t.title.includes('uncertainty must bind'))))) ? 'FAIL' : 'PASS_OFFLINE',
    observations: observations.filter(o => o.variantId === id), selected: 'NOTRUN', read: 'NOTRUN', applied: 'NOTRUN', verified: 'NOTRUN'})),
  agentSelectedSkillIds: null, selected: 'NOTRUN', read: 'NOTRUN', applied: 'NOTRUN', verified: 'NOTRUN', hostLive: 'NOTRUN',
  accuracyScore: null, accuracyReason: 'SS30 is operational oracle=null; originalPrompt=null; do not invent a golden selection.',
  evidence: ['source.json', 'engineering-test-plan.json', 'snapshot.json', 'existing-vitest.json', 'new-vitest.json', 'observations.json', 'existing-regression.command.json', 'new-offline-mock.command.json'],
  missingInputs: ['No original semantic prompt or frozen semantic golden for SS30.', 'No installed AGS classify_skills/record_skill_selection tool exposed in current host.',
    'No actual host-bound classification config/profile qualification/route/budget/task observation and selected/read/applied/verified receipts.'],
  boundaries: {sourceSpecPathPresent: existsSync('TEST-SPEC.seq7.ko.md'), repoAgentsSkillsPresent: existsSync('.agents/skills'), workspaceAgentsSkillsPresent: existsSync('<WORKSPACE_ROOT>/.agents/skills')},
  findings: [{id: 'SS30-F1', existingFinding: 'valid-cost-lost-with-invalid-RESP', rootCause: 'service validation throws and catch replaces known valid usage with unknownUsage before budget settlement', countAsNewRootCause: false},
    {id: 'SS30-F2', rootCause: 'response validation does not bind uncertain judgment IDs to unresolvedItems; PARTIAL with empty unresolvedItems passes and suppresses fallback', countAsNewRootCause: true}],
  sensitivityProof: 'NOTRUN: no production mutation or fixed green candidate; local test results do not attest AGENT actions.'});
process.exitCode = reports.some(r => r.numFailedTests > 0) ? 1 : 0;
