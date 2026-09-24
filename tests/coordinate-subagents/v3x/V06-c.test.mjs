import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, test } from 'vitest';
import {
  buildCurrentHostIntegrationManifest, parseHostIntegrationManifest,
} from '../../../mcp-server/src/host-integration/manifest.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'host-integration.json'), 'utf8'));
const scripts = {
  'scope-baseline': 'skills/change-scope-guardian/scripts/capture-workspace-baseline.mjs',
  'scope-compare': 'skills/change-scope-guardian/scripts/compare-change-scope.mjs',
  'acceptance-cli': 'skills/acceptance-evidence-validator/scripts/cli.mjs',
};
const entry = (id) => manifest.entryPoints.find((item) => item.id === id);
let work;
let candidate;
let repo;

function listFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    return item.isDirectory() ? listFiles(path.join(directory, item.name), relative) : [relative];
  });
}

/** Invoke like the VM: entry path from the manifest; scope takes the request file, acceptance takes --input. */
function run(id, request, packageRoot = candidate) {
  const requestFile = path.join(work, `request-${id}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(requestFile, typeof request === 'string' ? request : JSON.stringify(request));
  const args = id === 'acceptance-cli' ? ['--input', requestFile] : [requestFile];
  return spawnSync(process.execPath, [path.join(packageRoot, entry(id).path), ...args], {
    cwd: work, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' },
  });
}

function json(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function taskEnvelope() {
  return {
    schemaVersion: '1.0.0',
    taskId: 'v06c-task',
    objective: 'Edit file',
    scope: { included: ['file.txt'], excluded: ['secret.txt'] },
    acceptanceCriteria: ['File is updated'],
    riskLevel: 'low',
    workUnits: [{ id: 'unit-1', objective: 'Edit file', dependencies: [], writeTargets: ['file.txt'] }],
    requiredCapabilities: [],
    constraints: [],
    authorization: { allowedActions: ['edit'], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: 'simple', hasConflicts: false },
    orchestration: { requested: false, mcpAvailable: false },
  };
}

function withRemoved(file, check) {
  const target = path.join(candidate, file);
  rmSync(target);
  try {
    check();
  } finally {
    copyFileSync(path.join(root, file), target);
  }
}

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'ags-v06c-'));
  candidate = path.join(work, 'package');
  for (const artifact of manifest.artifacts) {
    const target = path.join(candidate, artifact.path);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(root, artifact.path), target);
  }
  copyFileSync(path.join(root, 'host-integration.json'), path.join(candidate, 'host-integration.json'));
  repo = path.join(work, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(repo, 'file.txt'), 'content\n');
  writeFileSync(path.join(repo, 'secret.txt'), 'keep\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

test('official manifest advertises the three existing skill CLIs with hashed transitive closures', () => {
  assert.deepEqual(manifest, buildCurrentHostIntegrationManifest(root));
  assert.deepEqual(manifest.entryPoints.map((item) => item.id), ['mcp-server', ...Object.keys(scripts)]);
  assert.equal(entry('host-attestation-cli'), undefined);
  for (const [id, script] of Object.entries(scripts)) {
    const closure = entry(id).executionClosure;
    assert.equal(entry(id).path, script);
    assert.ok(closure.includes('runtime/schema-validation.mjs'), id);
    assert.ok(closure.some((file) => file.endsWith('/contracts/upstream/task-envelope.v1.schema.json')), id);
  }
  assert.ok(entry('scope-compare').executionClosure.includes('skills/change-scope-guardian/scripts/lib.mjs'));
  assert.ok(entry('acceptance-cli').executionClosure.includes('skills/acceptance-evidence-validator/scripts/core.mjs'));
});

test('isolated package holds only the manifest and declared closure, outside any node_modules tree', () => {
  assert.deepEqual(listFiles(candidate).sort(), ['host-integration.json', ...manifest.artifacts.map((item) => item.path)].sort());
  for (let directory = candidate; ; directory = path.dirname(directory)) {
    assert.equal(existsSync(path.join(directory, 'node_modules')), false, directory);
    if (path.dirname(directory) === directory) break;
  }
  const fromRepo = path.relative(root, candidate);
  assert.ok(fromRepo.startsWith('..') || path.isAbsolute(fromRepo), fromRepo);
  assert.deepEqual(parseHostIntegrationManifest(manifest, candidate), manifest);
});

test('isolated scripts run with VM argument forms: pass, semantic refusal, and invalid input', () => {
  const task = taskEnvelope();
  const capture = { schemaVersion: '1.0.0', mode: 'capture', repositoryRoot: repo, comparisonTarget: 'working-tree', taskEnvelope: task };
  const baseline = json(run('scope-baseline', capture));
  assert.match(baseline.manifestSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(baseline.entries.map((item) => item.path).sort(), ['file.txt', 'secret.txt']);

  const verify = { schemaVersion: '1.0.0', mode: 'verify', repositoryRoot: repo, comparisonTarget: 'working-tree', baseline, baselineArtifactDigest: baseline.manifestSha256, taskEnvelope: task };
  writeFileSync(path.join(repo, 'file.txt'), 'changed\n');
  const pass = json(run('scope-compare', verify));
  assert.equal(pass.verdict, 'PASS');
  assert.deepEqual(pass.findings, []);
  assert.match(pass.currentDigest, /^[a-f0-9]{64}$/);
  assert.equal(typeof pass.summary, 'object');

  writeFileSync(path.join(repo, 'secret.txt'), 'leaked\n');
  const blocked = json(run('scope-compare', verify));
  assert.equal(blocked.verdict, 'BLOCKED');
  assert.ok(blocked.findings.includes('excluded:secret.txt'));

  const wrongMode = run('scope-baseline', { ...capture, mode: 'verify' });
  assert.equal(wrongMode.status, 1);
  assert.match(wrongMode.stderr, /mode must be capture/);
  const malformed = run('scope-compare', '{ not json');
  assert.equal(malformed.status, 1);
  const schemaInvalid = run('scope-baseline', { repositoryRoot: repo, comparisonTarget: 'working-tree' });
  assert.equal(schemaInvalid.status, 1);
  assert.match(schemaInvalid.stderr, /request schema validation failed/);

  const fixtures = path.join(root, 'tests/acceptance-evidence-validator/fixtures');
  assert.equal(json(run('acceptance-cli', readFileSync(path.join(fixtures, 'passing.json'), 'utf8'))).verdict, 'PASS');
  assert.equal(json(run('acceptance-cli', readFileSync(path.join(fixtures, 'failing.json'), 'utf8'))).verdict, 'FAIL');
  const invalid = run('acceptance-cli', { schemaVersion: '1.0.0' });
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'INVALID_INPUT');
});

test('each script runs from a package holding only its own declared closure, in VM commit mode', () => {
  const packages = Object.fromEntries(Object.keys(scripts).map((id) => {
    const packageRoot = path.join(work, `only-${id}`);
    for (const file of [...entry(id).executionClosure, 'host-integration.json']) {
      const target = path.join(packageRoot, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(root, file), target);
    }
    return [id, packageRoot];
  }));
  const commitRepo = path.join(work, 'commit-repo');
  mkdirSync(commitRepo);
  const git = (...args) => execFileSync('git', ['-C', commitRepo, ...args], { encoding: 'utf8' }).trim();
  const commitFile = (file, content) => {
    writeFileSync(path.join(commitRepo, file), content);
    git('add', '.');
    git('commit', '-qm', `edit ${file}`);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(commitRepo, 'secret.txt'), 'keep\n');
  const c0 = commitFile('file.txt', 'content\n');
  const task = taskEnvelope();
  const request = (mode, commit, extra = {}) => ({ schemaVersion: '1.0.0', mode, repositoryRoot: commitRepo, comparisonTarget: 'commit', commit, taskEnvelope: task, ...extra });
  const baseline = json(run('scope-baseline', request('capture', c0), packages['scope-baseline']));
  const verify = (commit) => json(run('scope-compare',
    request('verify', commit, { baseline, baselineArtifactDigest: baseline.manifestSha256 }), packages['scope-compare']));
  const c1 = commitFile('file.txt', 'changed\n');
  writeFileSync(path.join(commitRepo, 'secret.txt'), 'uncommitted\n'); // the commit tree, not the worktree, is judged
  assert.equal(verify(c1).verdict, 'PASS');
  const refused = verify(commitFile('secret.txt', 'leaked\n'));
  assert.equal(refused.verdict, 'BLOCKED');
  assert.ok(refused.findings.includes('excluded:secret.txt'));

  const fixtures = path.join(root, 'tests/acceptance-evidence-validator/fixtures');
  const accept = (name) => json(run('acceptance-cli', readFileSync(path.join(fixtures, name), 'utf8'), packages['acceptance-cli'])).verdict;
  assert.equal(accept('passing.json'), 'PASS');
  assert.equal(accept('failing.json'), 'FAIL');
});

test('missing closure files fail both the manifest check and actual execution', () => {
  const capture = { schemaVersion: '1.0.0', mode: 'capture', repositoryRoot: repo, comparisonTarget: 'working-tree', taskEnvelope: taskEnvelope() };
  const acceptance = readFileSync(path.join(root, 'tests/acceptance-evidence-validator/fixtures/passing.json'), 'utf8');
  const cases = [
    ['scope-baseline', 'skills/change-scope-guardian/scripts/lib.mjs', capture],
    ['scope-baseline', 'skills/change-scope-guardian/contracts/change-scope-request.v1.schema.json', capture],
    ['acceptance-cli', 'runtime/schema-validation.mjs', acceptance],
    ['acceptance-cli', 'skills/acceptance-evidence-validator/contracts/upstream/task-envelope.v1.schema.json', acceptance],
  ];
  for (const [id, file, request] of cases) {
    assert.ok(entry(id).executionClosure.includes(file), file);
    withRemoved(file, () => {
      assert.throws(() => parseHostIntegrationManifest(manifest, candidate), /Missing package file/);
      assert.notEqual(run(id, request).status, 0, file);
    });
  }
  assert.equal(run('scope-baseline', capture).status, 0);
});

test('tampering, bare imports, and path escapes are rejected', () => {
  const core = 'skills/acceptance-evidence-validator/scripts/core.mjs';
  writeFileSync(path.join(candidate, core), `${readFileSync(path.join(root, core), 'utf8')}\n// modified\n`);
  try {
    assert.throws(() => parseHostIntegrationManifest(manifest, candidate), /Artifact hash mismatch/);
  } finally {
    copyFileSync(path.join(root, core), path.join(candidate, core));
  }

  const capture = scripts['scope-baseline'];
  const original = readFileSync(path.join(root, capture), 'utf8');
  for (const [specifier, message] of [
    ['../../../../outside.mjs', /Invalid package-relative path/],
    ['ajv', /imports outside the package/],
    ['./missing.mjs', /Missing package file/],
  ]) {
    writeFileSync(path.join(candidate, capture), `import "${specifier}";\n${original}`);
    try {
      assert.throws(() => buildCurrentHostIntegrationManifest(candidate), message);
    } finally {
      copyFileSync(path.join(root, capture), path.join(candidate, capture));
    }
  }
  assert.deepEqual(buildCurrentHostIntegrationManifest(candidate), manifest);

  const escapedEntry = structuredClone(manifest);
  escapedEntry.entryPoints[1].path = '../outside.mjs';
  assert.throws(() => parseHostIntegrationManifest(escapedEntry, candidate), /Invalid package-relative path/);
  const escapedClosure = structuredClone(manifest);
  escapedClosure.entryPoints[3].executionClosure.push('skills/../../outside.mjs');
  assert.throws(() => parseHostIntegrationManifest(escapedClosure, candidate), /Invalid package-relative path/);
  const undeclared = structuredClone(manifest);
  undeclared.entryPoints[2].executionClosure = undeclared.entryPoints[2].executionClosure
    .filter((file) => file !== undeclared.entryPoints[2].path);
  assert.throws(() => parseHostIntegrationManifest(undeclared, candidate), /omits entry point/);
});
