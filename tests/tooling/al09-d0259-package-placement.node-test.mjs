import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const collector = await fs.readFile(new URL('../../.github/scripts/ags30-official-source-r11.mjs', import.meta.url), 'utf8');
const packager = await fs.readFile(new URL('../../.github/scripts/ags30-claude-package-r01.mjs', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function segment(text, start, end) {
  const first = text.indexOf(start), last = text.indexOf(end, first);
  assert(first >= 0 && last > first, 'Actual production boundary is missing');
  return text.slice(first, last);
}
// Execute the actual composition block; only the external package command and
// its returned manifest are replaced. This is not a full Linux artifact test.
const compose = new AsyncFunction('record', 'process', 'shardIndex', 'command', 'path', 'source', 'output', 'fs',
  segment(collector, '    record.claudePackaging =', '    let testsPass ='));
async function place(platform, shardIndex, phaseStatus = 'PASS', packageStatus = 'GENERATED_NOT_ACCEPTED') {
  const record = {}, calls = [];
  await compose(record, { platform, execPath: '/owned/node' }, shardIndex,
    async (...args) => { calls.push(args); return { receipt: { status: phaseStatus } }; }, path,
    '/owned/source', '/owned/output', { readFile: async () => JSON.stringify({ status: packageStatus, archive: { member: 'claude-package.actual.tar.gz' } }) });
  return { record, calls };
}

test('the full Claude package is exported once on Linux shard 3', async () => {
  const { record, calls } = await place('linux', 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '06a-claude-package');
  assert.deepEqual(calls[0][2], [path.join('/owned/source', '.github/scripts/ags30-claude-package-r01.mjs'), '/owned/source', '/owned/output']);
  assert.equal(record.claudePackaging.archiveMember, 'claude-package.actual.tar.gz');
  assert.equal(record.claudePackaging.wholeAcceptance, 'NOT_CLAIMED');
});

test('Linux shard 1 retains its existing proof roles without a duplicate package', async () => {
  for (const [platform, shard] of [['linux', 1], ['linux', 2], ['linux', 4], ['win32', 1], ['win32', 2], ['win32', 3], ['win32', 4]]) {
    const { record, calls } = await place(platform, shard);
    assert.equal(calls.length, 0, `${platform}/${shard} must not package`);
    assert.equal(record.claudePackaging.status, 'SKIP_NOT_LINUX_SHARD_3');
  }
});

test('package command failure and cap refusal remain failures at the new placement', async () => {
  const failed = await place('linux', 3, 'FAIL');
  assert.equal(failed.record.claudePackaging.status, 'FAIL');
  const refused = await place('linux', 3, 'PASS', 'NOT_RETURNED_CAP');
  assert.equal(refused.record.claudePackaging.status, 'NOT_RETURNED_CAP');
  assert(collector.includes("!['FAIL', 'NOT_RETURNED_CAP'].includes(record.claudePackaging.status)"));
});

const entry = new Function('assert', 'process',
  segment(packager, 'const [sourceArg, outputArg]', 'const source ='));
const env = { GITHUB_ACTIONS: 'true', AGS_CI_SHARD_INDEX: '3', RUNNER_OS: 'Linux',
  GITHUB_RUN_ID: '40258685549', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'verify-release' };
function processFixture(overrides = {}, platform = 'linux') {
  return { platform, argv: ['node', 'packager', '/owned/source', '/owned/output'], env: { ...env, ...overrides } };
}
test('the real packager entry requires official Linux shard 3', () => {
  assert.doesNotThrow(() => entry(assert, processFixture()));
  for (const overrides of [{ AGS_CI_SHARD_INDEX: '1' }, { AGS_CI_SHARD_INDEX: '2' }, { AGS_CI_SHARD_INDEX: '4' }, { GITHUB_ACTIONS: 'false' }, { RUNNER_OS: 'Windows' }]) {
    assert.throws(() => entry(assert, processFixture(overrides)));
  }
  assert.throws(() => entry(assert, processFixture({}, 'win32')));
});

const bind = new AsyncFunction('assert', 'process', 'json', 'path', 'output',
  segment(packager, 'const sourceManifest =', 'const executionSources ='));
const binding = { runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, job: env.GITHUB_JOB, shardIndex: 3 };
test('package source binding rejects wrong run, attempt, job or shard', async () => {
  await bind(assert, processFixture(), async () => binding, path, '/owned/output');
  for (const wrong of [{ runId: '40253712258' }, { attempt: '2' }, { job: 'foreign-job' }, { shardIndex: 1 }]) {
    await assert.rejects(() => bind(assert, processFixture(), async () => ({ ...binding, ...wrong }), path, '/owned/output'));
  }
});

test('the returned manifest names the real placement and keeps source and archive guards', () => {
  assert(packager.includes("job: sourceManifest.job, runnerOs: 'Linux', shardIndex: 3,"));
  assert(packager.includes("execution: 'OFFICIAL_CI_LINUX_SHARD_3'"));
  for (const guard of ["assert.equal(head, sourceManifest.head)", "assert.equal(sourceTree, sourceManifest.sourceTree)",
    "assert.deepEqual(generatedBefore.map", "assert.deepEqual(bodyAfter, bodyBefore", "assert.deepEqual(generatedAfter, generatedBefore",
    'archive.length + manifestBytes.length > budget', 'const maximumExportBytes = 1_500_000', 'cap - existingBytes',
    'sourceManifest.portableId', 'generatedRuntimePortableId: generated.portableId']) assert(packager.includes(guard), guard);
});
