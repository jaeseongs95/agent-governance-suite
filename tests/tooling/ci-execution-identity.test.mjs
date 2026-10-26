import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { buildHeadManifest, deriveExecutionIdentity } from '../../.github/scripts/ags30-official-source-r11.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = [];
const nonce = 'd40472dd-9496-4c39-96c1-b7c43caf8b3c';
const unit = 'CI-EXECUTION-IDENTITY-FIXTURE';
const runnerOs = process.platform === 'win32' ? 'Windows' : 'Linux';
const helperRelative = '.github/scripts/ags30-official-source-r11.mjs';
const configRelative = '.github/ci/ags30-r11/execution-config.json';
const sha = data => createHash('sha256').update(data).digest('hex');

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function git(directory, args) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', ...args],
    { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function commit(directory, message) {
  git(directory, ['add', '.']);
  git(directory, ['-c', 'commit.gpgsign=false', '-c', 'user.name=CI fixture',
    '-c', 'user.email=ci-fixture@example.invalid', 'commit', '-m', message]);
  return git(directory, ['rev-parse', 'HEAD']);
}

async function fixture() {
  const tempRoot = path.resolve(tmpdir());
  const pad = Math.max(0, 123 - tempRoot.length - runnerOs.length);
  const directory = await fs.mkdtemp(path.join(tempRoot, `ci-execution-identity-${'x'.repeat(pad)}`));
  temporary.push(directory);
  const checkout = path.join(directory, 'checkout');
  await fs.mkdir(path.join(checkout, 'skills'), { recursive: true });
  await fs.writeFile(path.join(checkout, 'skills/fixture.txt'), 'CI-only Git source fixture\n');
  git(checkout, ['init', '-b', 'release-3.0']);
  const baseline = commit(checkout, 'fixture baseline');
  const config = JSON.parse(await fs.readFile(path.join(root, configRelative), 'utf8'));
  config.unit = unit;
  config.nonce = nonce;
  config.node = process.versions.node;
  config.gitContext.skillBaseline = baseline;
  for (const relative of [helperRelative, ...Object.keys(config.ownershipHelpers).map(name => '.github/scripts/' + name)]) {
    const destination = path.join(checkout, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(root, relative), destination);
    expect(await fs.readFile(destination)).toEqual(await fs.readFile(path.join(root, relative)));
  }
  const configFile = path.join(checkout, configRelative);
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, JSON.stringify(config, null, 2) + '\n');
  commit(checkout, 'fixture actual source');
  // The required OS helper is deliberately absent. A successful source-binding
  // prefix must stop with ENOENT before pnpm bootstrap or any product command.
  return { directory, checkout, configFile, helper: path.join(checkout, helperRelative) };
}

function invoke(f, args, env) {
  return spawnSync(process.execPath, [f.helper, ...args], { cwd: f.checkout, env,
    encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
}

async function collect(f, overrides = {}) {
  const runnerTemp = await fs.mkdtemp(path.join(f.directory, 'runner-'));
  const githubOutput = path.join(runnerTemp, 'github-output.txt');
  const env = { ...process.env, RUNNER_TEMP: runnerTemp, RUNNER_OS: runnerOs, AGS_CI_SHARD_INDEX: '1',
    GITHUB_OUTPUT: githubOutput, GITHUB_WORKSPACE: f.checkout,
    GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', npm_config_offline: 'true',
    GITHUB_REPOSITORY: 'jaeseongs95/agent-governance-suite', GITHUB_REPOSITORY_ID: '1362118877',
    GITHUB_REF: 'refs/heads/release-3.0', GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '1001', GITHUB_JOB: 'verify-release', GITHUB_SHA: git(f.checkout, ['rev-parse', 'HEAD']), ...overrides };
  delete env.JEV_API_KEY;
  delete env.AGS_JEV_ENDPOINT;
  const result = invoke(f, [f.configFile], env);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  const work = path.join(runnerTemp, `ags30-${nonce}-${runnerOs}`);
  const source = path.join(work, 'source');
  expect(work.length).toBeGreaterThanOrEqual(208);
  expect(work.length).toBeLessThanOrEqual(240);
  expect(source.length).toBeLessThanOrEqual(247);
  const output = path.join(work, 'result');
  const record = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8'));
  expect(record).toMatchObject({ unit, nonce, status: 'FAIL', sourceFreshness: 'NOT_RUN', runtimeCandidate: 'NOT_GENERATED' });
  expect(record.phases.some(phase => phase.name.startsWith('02-'))).toBe(false);
  if (record.phases.some(phase => phase.name === '01c-checkout-official-source' && phase.status === 'PASS')) {
    const clonedHelper = path.join(source, helperRelative);
    expect(clonedHelper.length).toBeGreaterThan(260);
    expect((await fs.stat(clonedHelper)).isFile()).toBe(true);
    const objectRoot = path.join(source, '.git', 'objects');
    const buckets = (await fs.readdir(objectRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^[a-f0-9]{2}$/.test(entry.name));
    expect(buckets.length).toBeGreaterThan(0);
    const objects = await fs.readdir(path.join(objectRoot, buckets[0].name));
    expect(objects.length).toBeGreaterThan(0);
    const looseObject = path.join(objectRoot, buckets[0].name, objects[0]);
    expect(looseObject.length).toBeGreaterThan(260);
    expect((await fs.stat(looseObject)).isFile()).toBe(true);
  }
  return { result, env, output, githubOutput, record };
}

it('one config identity derives a closed work path and artifact label on both operating systems', () => {
  for (const os of ['Linux', 'Windows']) {
    const identity = deriveExecutionIdentity({ unit, nonce, shardCount: 4 },
      { RUNNER_TEMP: tmpdir(), RUNNER_OS: os, AGS_CI_SHARD_INDEX: '3' });
    expect(identity).toEqual({ unit, nonce, shardIndex: 3, shardRef: '3/4',
      work: path.join(path.resolve(tmpdir()), `ags30-${nonce}-${os}`),
      artifactName: `ags30-official-${nonce}-${os}-shard-3` });
    expect(Object.isFrozen(identity)).toBe(true);
  }
});

it.each(['../escape', nonce + '\nartifact_ok=true', '', 'not-a-uuid'])('unsafe nonce is rejected before deriving any output: %j', value => {
  expect(() => deriveExecutionIdentity({ unit, nonce: value, shardCount: 4 },
    { RUNNER_TEMP: tmpdir(), RUNNER_OS: runnerOs, AGS_CI_SHARD_INDEX: '1' })).toThrow('Invalid execution nonce');
});

it('the identity boundary retains unit, OS and four-shard validation', () => {
  const config = { unit, nonce, shardCount: 4 };
  const environment = { RUNNER_TEMP: tmpdir(), RUNNER_OS: runnerOs, AGS_CI_SHARD_INDEX: '1' };
  expect(() => deriveExecutionIdentity({ ...config, unit: '' }, environment)).toThrow('Missing execution unit');
  expect(() => deriveExecutionIdentity(config, { ...environment, RUNNER_OS: 'unsupported' })).toThrow();
  expect(() => deriveExecutionIdentity(config, { ...environment, AGS_CI_SHARD_INDEX: '5' })).toThrow();
  expect(() => deriveExecutionIdentity({ ...config, shardCount: 5 }, environment)).toThrow();
});

it('the actual collector attempt gate and independent finalizer consume the same config-only identity', async () => {
  const f = await fixture();
  const observed = await collect(f, { GITHUB_RUN_ATTEMPT: '2' });
  expect(observed.record.phases).toEqual([]);
  expect(observed.record.failure).toMatchObject({ name: 'AssertionError', code: 'ERR_ASSERTION' });
  expect(observed.record.failure.message).toContain("'2' !== '1'");
  const originalRecord = await fs.readFile(path.join(observed.output, 'result.json'));
  const finalized = invoke(f, ['--finalize', 'failure'], observed.env);
  expect(finalized.error).toBeUndefined();
  expect(finalized.status, finalized.stderr).toBe(0);
  const outputs = await fs.readFile(observed.githubOutput, 'utf8');
  expect(outputs.split('\n').filter(line => line.startsWith('result_path='))).toEqual([
    `result_path=${observed.output}`, `result_path=${observed.output}`]);
  expect(outputs).toContain(`artifact_name=ags30-official-${nonce}-${runnerOs}-shard-1\n`);
  expect(await fs.readFile(path.join(observed.output, 'result.json'))).toEqual(originalRecord);
  const finalization = JSON.parse(await fs.readFile(path.join(observed.output, 'finalization.json'), 'utf8'));
  expect(finalization).toMatchObject({ outcome: 'failure', evidenceState: 'OBSERVED_FILES_MAY_BE_PARTIAL',
    collectorCompletionRequired: false, artifactMaximumBytes: 8388608 });
  const manifest = JSON.parse(await fs.readFile(path.join(observed.output, 'finalization-files.json'), 'utf8'));
  for (const row of manifest.rows) {
    const bytes = await fs.readFile(path.join(observed.output, row.relativePath));
    expect({ bytes: bytes.length, sha256: sha(bytes) }).toEqual({ bytes: row.bytes, sha256: row.sha256 });
  }
  const duplicateCollector = invoke(f, [f.configFile], observed.env);
  expect(duplicateCollector.status).toBe(1);
  expect(duplicateCollector.stderr).toContain('EEXIST');
  const duplicateFinalizer = invoke(f, ['--finalize', 'failure'], observed.env);
  expect(duplicateFinalizer.status).toBe(1);
  expect(duplicateFinalizer.stderr).toContain('EEXIST');
  expect(await fs.readFile(path.join(observed.output, 'result.json'))).toEqual(originalRecord);
});

it('the actual collector binds different HEADs and runs without rotating the config nonce', async () => {
  const f = await fixture();
  const configBytes = await fs.readFile(f.configFile);
  const first = await collect(f);
  expect(first.record.failure.code).toBe('ENOENT');
  const before = JSON.parse(await fs.readFile(path.join(first.output, 'source-manifest.json'), 'utf8'));
  const marker = Buffer.from('second exact source candidate\n');
  await fs.writeFile(path.join(f.checkout, 'candidate-marker.txt'), marker);
  const secondHead = commit(f.checkout, 'fixture next actual head');
  const second = await collect(f, { GITHUB_RUN_ID: '1002' });
  expect(second.record.failure.code).toBe('ENOENT');
  const after = JSON.parse(await fs.readFile(path.join(second.output, 'source-manifest.json'), 'utf8'));
  expect(after).toMatchObject({ head: secondHead, sourceTree: git(f.checkout, ['rev-parse', 'HEAD^{tree}']),
    runId: '1002', attempt: '1', job: 'verify-release', shardIndex: 1 });
  expect(before).toMatchObject({ runId: '1001', attempt: '1' });
  expect(after.head).not.toBe(before.head);
  expect(after.rows).toContainEqual({ relativePath: 'candidate-marker.txt', bytes: marker.length, sha256: sha(marker) });
  expect(await fs.readFile(f.configFile)).toEqual(configBytes);
});

it('the actual collector rejects a triggering HEAD that differs from its checkout', async () => {
  const f = await fixture();
  const observed = await collect(f, { GITHUB_SHA: 'f'.repeat(40) });
  expect(observed.record.failure.message).toContain('Runner checkout must equal the triggering push HEAD');
  expect(observed.record.phases.map(phase => phase.name)).toEqual(['01b-observe-workflow-head']);
  await expect(fs.access(path.join(observed.output, 'source-manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['config', 'helper'])('the actual collector rejects changed executing %s bytes after its HEAD was frozen', async target => {
  const f = await fixture();
  await fs.appendFile(target === 'config' ? f.configFile : f.helper, target === 'config' ? '\n' : '\n// integrity probe\n');
  const observed = await collect(f);
  expect(observed.record.failure).toMatchObject({ name: 'AssertionError', code: 'ERR_ASSERTION' });
  expect(observed.record.phases.some(phase => phase.name === '01h-observe-index' && phase.status === 'PASS')).toBe(true);
  expect(JSON.parse(await fs.readFile(path.join(observed.output, 'source-manifest.json'), 'utf8')).head).toBe(observed.env.GITHUB_SHA);
});

it('the original raw Git manifest validator rejects bytes that do not match the reported OID', async () => {
  const bytes = Buffer.from('actual Git blob\n');
  const oid = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
  const inventory = `100644 blob ${oid} ${bytes.length}\tfixture.txt\0`;
  const binding = { runId: '1001', attempt: '1', job: 'verify-release', shardIndex: 1,
    head: 'a'.repeat(40), sourceTree: 'b'.repeat(40) };
  const correct = await buildHeadManifest(inventory, async () => bytes, binding);
  expect(correct).toMatchObject({ ...binding, files: 1, rows: [{ relativePath: 'fixture.txt', bytes: bytes.length, sha256: sha(bytes) }] });
  const changed = Buffer.from(bytes);
  changed[0] ^= 1;
  await expect(buildHeadManifest(inventory, async () => changed, binding)).rejects.toThrow('Checkout blob bytes differ from actual HEAD');
});
