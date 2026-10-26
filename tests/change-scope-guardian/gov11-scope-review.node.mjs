import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { canonicalJson, sha256, validateReport } from '../../skills/change-scope-guardian/scripts/lib.mjs';

const root = resolve(import.meta.dirname, '../..');
const evidence = process.env.GOV11_EVIDENCE_DIR;
const fixtureParent = evidence ? join(evidence, 'fixtures') : join(root, 'work/gov11-fixtures');
mkdirSync(fixtureParent, { recursive: true });
const descriptor = JSON.parse(readFileSync(join(root, 'skills/change-scope-guardian/integration/skill-descriptor.json'), 'utf8'));
const stage = { stageId: 'gov11-scope', capability: 'change-scope-assurance', satisfiedCapabilities: ['change-scope-assurance'], gate: { validator: 'change-scope-report.v1' }, ...descriptor.providers[1] };
const runtimeUrl = process.env.GOV11_WORKFLOW_SERVICE_URL ?? pathToFileURL(join(root, 'mcp-server/src/workflow-service.ts')).href;
const { register } = await import(pathToFileURL(createRequire(runtimeUrl).resolve('tsx/esm/api')).href);
register();
const { WorkflowService } = await import(runtimeUrl);
// No constructor, workflow store, signing key, registration or DB is needed for the real mapping consumer.
const consumer = Object.create(WorkflowService.prototype);

function task() {
  return { schemaVersion: '1.0.0', taskId: 'gov11', objective: 'Repair source', scope: { included: ['src/**'], excluded: ['excluded/**'] }, acceptanceCriteria: ['Scope is reviewed'], riskLevel: 'low', workUnits: [], requiredCapabilities: [], constraints: [], authorization: { allowedActions: ['edit'], prohibitedActions: ['main', 'tag', 'install', 'delete', 'DB'], approvalRequired: ['release', 'deploy', 'permission-expansion'] }, decision: { complexity: 'simple', hasConflicts: false }, orchestration: { requested: false, mcpAvailable: false } };
}
function git(repo, ...args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }
function fixture() {
  const repo = mkdtempSync(join(fixtureParent, 'scope-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Scope Fixture');
  git(repo, 'config', 'user.email', 'scope@example.invalid');
  git(repo, 'config', 'core.autocrlf', 'false');
  mkdirSync(join(repo, 'src')); mkdirSync(join(repo, 'excluded'));
  writeFileSync(join(repo, 'src/app.txt'), 'baseline\n'); writeFileSync(join(repo, 'excluded/data.txt'), 'preserve\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'synthetic initial state');
  return repo;
}
function cli(script, request, label, expectedExit = 0) {
  const args = [join(root, `skills/change-scope-guardian/scripts/${script}.mjs`)];
  const run = spawnSync(process.execPath, args, { input: JSON.stringify(request), encoding: 'utf8', windowsHide: true });
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, `${label}.json`), JSON.stringify({ command: [process.execPath, ...args], exitCode: run.status, stdout: run.stdout, stderr: run.stderr, request }, null, 2) + '\n');
  }
  assert.equal(run.status, expectedExit, run.stderr);
  return expectedExit === 0 ? JSON.parse(run.stdout) : run;
}
function capture(repo, t, label) { return cli('capture-workspace-baseline', { schemaVersion: '1.0.0', mode: 'capture', repositoryRoot: repo, comparisonTarget: 'working-tree', taskEnvelope: t }, label); }
function verify(repo, t, baseline, label) {
  return cli('compare-change-scope', { schemaVersion: '1.0.0', mode: 'verify', repositoryRoot: repo, comparisonTarget: 'working-tree', taskEnvelope: t, ...(baseline ? { baseline, baselineArtifactDigest: baseline.manifestSha256 } : {}) }, label);
}
function check(report, label) {
  cli('validate-report', { artifact: report, expectedArtifactDigest: report.reportSha256 }, label);
  return consumer.mappedState(stage, { kind: 'output', output: report, artifacts: [], error: null });
}

test('GOV11 actual CLI identifies known unplanned scope and actual consumer blocks review without user approval', () => {
  const repo = fixture(), t = task(), authorization = canonicalJson(t.authorization);
  const baseline = capture(repo, t, 'unplanned-capture');
  writeFileSync(join(repo, 'unplanned.txt'), 'necessary related source\n');
  const before = git(repo, 'status', '--porcelain=v1');
  const report = verify(repo, t, baseline, 'unplanned-report');
  assert.equal(report.verdict, 'NEEDS_REVIEW');
  assert.equal(report.summary.unplanned, 1); assert.equal(report.summary['ownership-unknown'], 0);
  assert.deepEqual(report.findings, ['unplanned:unplanned.txt']);
  assert.deepEqual(check(report, 'unplanned-validate'), { state: 'blocked', errorRequired: false });
  assert.equal(git(repo, 'status', '--porcelain=v1'), before);
  assert.equal(canonicalJson(t.authorization), authorization);
});

test('GOV11 existing user content remains unchanged until a real overlap requires ownership review', () => {
  const repo = fixture(), t = task();
  writeFileSync(join(repo, 'src/app.txt'), 'user change\n');
  const baseline = capture(repo, t, 'overlap-capture');
  const untouched = verify(repo, t, baseline, 'untouched-report');
  assert.equal(untouched.verdict, 'PASS'); check(untouched, 'untouched-validate');
  assert.equal(readFileSync(join(repo, 'src/app.txt'), 'utf8'), 'user change\n');
  writeFileSync(join(repo, 'src/app.txt'), 'user plus task change\n');
  const report = verify(repo, t, baseline, 'overlap-report');
  assert.equal(report.verdict, 'NEEDS_REVIEW');
  assert.deepEqual(report.findings, ['preexisting-overlap:src/app.txt']);
  assert.deepEqual(check(report, 'overlap-validate'), { state: 'blocked', errorRequired: false });
  assert.equal(readFileSync(join(repo, 'src/app.txt'), 'utf8'), 'user plus task change\n');
});

test('GOV11 explicit exclusions stay BLOCKED even with known unplanned files', () => {
  const repo = fixture(), t = task(), baseline = capture(repo, t, 'excluded-capture');
  writeFileSync(join(repo, 'unplanned.txt'), 'new\n'); writeFileSync(join(repo, 'excluded/data.txt'), 'changed\n');
  const report = verify(repo, t, baseline, 'excluded-report');
  assert.equal(report.verdict, 'BLOCKED'); assert.equal(report.summary.excluded, 1); assert.equal(report.summary.unplanned, 1);
  assert.equal(check(report, 'excluded-validate').state, 'blocked');
});

for (const dirty of [false, true]) test(`GOV11 absent baseline is genuine INCONCLUSIVE with dirty=${dirty}`, () => {
  const repo = fixture(), t = task();
  if (dirty) writeFileSync(join(repo, 'src/app.txt'), 'unknown owner\n');
  const report = verify(repo, t, undefined, `unknown-${dirty}-report`);
  assert.equal(report.verdict, 'INCONCLUSIVE');
  assert.equal(report.summary['ownership-unknown'], dirty ? 1 : 0);
  assert.deepEqual(check(report, `unknown-${dirty}-validate`), { state: 'needs-input', errorRequired: false });
});

test('GOV11 cannot rewrite known violations into PASS or INCONCLUSIVE even with a new checksum', () => {
  const repo = fixture(), t = task(), baseline = capture(repo, t, 'forged-capture');
  writeFileSync(join(repo, 'unplanned.txt'), 'new\n');
  const report = verify(repo, t, baseline, 'forged-report');
  for (const verdict of ['PASS', 'INCONCLUSIVE', 'NEEDS_APPROVAL']) {
    const { reportSha256: _ignored, ...unsigned } = { ...report, verdict };
    const forged = { ...unsigned, reportSha256: sha256(canonicalJson(unsigned)) };
    assert.throws(() => validateReport(forged, forged.reportSha256), /does not match|schema validation/);
  }
  const { reportSha256: _ignored, ...missingBaseline } = { ...report, baselineDigest: '0'.repeat(64), verdict: 'INCONCLUSIVE' };
  const hidden = { ...missingBaseline, reportSha256: sha256(canonicalJson(missingBaseline)) };
  assert.throws(() => validateReport(hidden, hidden.reportSha256), /cannot classify known scope changes/);
  assert.throws(() => validateReport(report, 'f'.repeat(64)), /frozen digest/);
});

test('GOV11 frozen baseline trust and task scope remain enforced by actual CLI', () => {
  const repo = fixture(), t = task(), baseline = capture(repo, t, 'trust-capture');
  for (const mutation of ['digest', 'task']) {
    const request = { schemaVersion: '1.0.0', mode: 'verify', repositoryRoot: repo, comparisonTarget: 'working-tree', taskEnvelope: t, baseline, baselineArtifactDigest: baseline.manifestSha256 };
    if (mutation === 'digest') request.baselineArtifactDigest = 'f'.repeat(64);
    else request.taskEnvelope = { ...t, objective: 'unapproved different goal' };
    const failed = cli('compare-change-scope', request, `trust-${mutation}-reject`, 1);
    assert.match(failed.stderr, /frozen digest|taskEnvelope digest/);
  }
});

test('GOV11 actual state consumer rejects approval and passing claims for unresolved review', () => {
  const report = { verdict: 'NEEDS_REVIEW' };
  const provider = { kind: 'output', output: report, artifacts: [], error: null };
  const originalValidator = consumer.validator, originalRegistry = consumer.registry;
  consumer.validator = { providerResult: () => provider }; consumer.registry = { rootDirectory: root };
  try {
    for (const state of ['needs-approval', 'passed', 'needs-input']) {
      assert.throws(() => consumer.assertResultSemantics(stage, { stageId: stage.stageId, state, output: provider, error: null, evidence: [] }, 'gov11', undefined), /state does not match/);
    }
    assert.doesNotThrow(() => consumer.assertResultSemantics(stage, { stageId: stage.stageId, state: 'blocked', output: provider, error: null, evidence: [] }, 'gov11', undefined));
  } finally { consumer.validator = originalValidator; consumer.registry = originalRegistry; }
});
