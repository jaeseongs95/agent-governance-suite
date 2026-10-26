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
    'archive.length + manifestBytes.length > budget', 'const followupReceiptReserveBytes = 1.5 * 1024 * 1024', 'cap - existingBytes - followupReceiptReserveBytes',
    'sourceManifest.portableId', 'generatedRuntimePortableId: generated.portableId']) assert(packager.includes(guard), guard);
});

// Run the real packager allocation/write block. Only existing file sizes and
// filesystem writes are synthetic; the budget, refusal and manifest checks are
// production code. This does not generate a package or call CI.
const packageBudget = new AsyncFunction('assert', 'rowsAt', 'fileNames', 'fs', 'path', 'output', 'archive', 'manifest',
  segment(packager, 'const cap =', 'const sha =')
  + segment(packager, '  const existing = await rowsAt(output, await fileNames(output));', '  console.log(')
  + '\nreturn { budget, manifest };');
async function allocate({ existingBytes, archiveBytes, padding = 0, writes = [] }) {
  const manifest = { schemaVersion: 'SyntheticPackageBudget.v1', status: 'GENERATED_NOT_ACCEPTED',
    archive: { member: 'claude-package.actual.tar.gz', bytes: archiveBytes }, fixturePadding: 'x'.repeat(padding) };
  const result = await packageBudget(assert, async () => [{ bytes: existingBytes }], async () => ['existing.evidence'],
    { writeFile: async (destination, bytes, options) => {
      assert.deepEqual(options, { flag: 'wx' });
      writes.push({ name: path.basename(destination), bytes: Buffer.from(bytes) });
    } }, path, '/owned/package-output', Buffer.alloc(archiveBytes), manifest);
  return { ...result, writes };
}

test('07d observed package plus manifest fits remaining total budget after the explicit receipt reserve', async () => {
  const observed = { existingBytes: 4_944_739, archiveBytes: 1_497_821 };
  const probe = await allocate(observed);
  const probeManifest = probe.writes.find(file => file.name === 'claude-package.manifest.json');
  assert(probeManifest);
  // Calibrate fixture padding only; the independent oracle is the observed
  // 133,799-byte manifest and 8 MiB total cap, not a second budget algorithm.
  const admitted = await allocate({ ...observed, padding: 133_799 - probeManifest.bytes.length });
  const manifest = admitted.writes.find(file => file.name === 'claude-package.manifest.json');
  assert.equal(manifest.bytes.length, 133_799);
  assert.equal(observed.archiveBytes + manifest.bytes.length, 1_631_620);
  assert.equal(admitted.budget, 1_871_005);
  assert.equal(admitted.manifest.exportBudget.totalArtifactMaximumBytes, 8_388_608);
  assert.equal(admitted.manifest.exportBudget.followupReceiptReserveBytes, 1_572_864);
  assert.equal(admitted.manifest.exportBudget.finalCollectorCapStillRequired, true);
  assert.equal(admitted.manifest.status, 'GENERATED_NOT_ACCEPTED');
  assert.equal(admitted.manifest.archive.status, 'RETURNED');
  assert.equal(admitted.manifest.archive.member, 'claude-package.actual.tar.gz');
  assert.deepEqual(admitted.writes.map(file => file.name), ['claude-package.actual.tar.gz', 'claude-package.manifest.json']);
});

test('reserved follow-up bytes remain unavailable even when the package alone fits the global cap', async () => {
  const refused = await allocate({ existingBytes: 4_944_739, archiveBytes: 2_000_000 });
  assert(4_944_739 + 2_000_000 + refused.writes[0].bytes.length < 8_388_608);
  assert.equal(refused.manifest.status, 'NOT_RETURNED_CAP');
  assert.equal(refused.manifest.archive.status, 'NOT_RETURNED_CAP');
  assert.equal(refused.manifest.archive.member, null);
  assert.deepEqual(refused.writes.map(file => file.name), ['claude-package.manifest.json']);
});

test('a package exceeding the unchanged 8 MiB total cap remains refused', async () => {
  const refused = await allocate({ existingBytes: 6_000_000, archiveBytes: 2_500_000 });
  assert.equal(refused.manifest.status, 'NOT_RETURNED_CAP');
  assert.equal(refused.manifest.archive.member, null);
  assert.deepEqual(refused.writes.map(file => file.name), ['claude-package.manifest.json']);
});

test('a manifest alone exceeding the remaining package budget throws before any output write', async () => {
  const writes = [];
  await assert.rejects(() => allocate({ existingBytes: 6_814_744, archiveBytes: 0, padding: 2_000, writes }),
    /Package manifest alone exceeds remaining export budget/u);
  assert.deepEqual(writes, []);
});

test('exhausted global budget is clamped to zero and still fails closed', async () => {
  const writes = [];
  await assert.rejects(() => allocate({ existingBytes: 8_388_609, archiveBytes: 0, writes }),
    /Package manifest alone exceeds remaining export budget/u);
  assert.deepEqual(writes, []);
});

// Execute the existing final collector cap check without running its commands.
// Every later file size is included; admission by the earlier package allocator
// must never substitute for the final total-byte gate.
const finalGuardText = "    if (record.status !== 'SELECTED_CHECKS_PASS' || !artifactOk) process.exitCode = 1;";
const finalStart = collector.indexOf('    const finalRows = await tree(output);');
const finalEnd = collector.indexOf(finalGuardText, finalStart);
assert(finalStart >= 0 && finalEnd > finalStart, 'Actual final collector cap boundary is missing');
const finalBudget = new AsyncFunction('tree', 'output', 'config', 'fs', 'process', 'console', 'emitCollectorSummary', 'record',
  'let artifactOk;\n' + collector.slice(finalStart, finalEnd + finalGuardText.length) + '\nreturn { artifactOk, bytes };');
async function finalizeSizes(sizes) {
  const observed = [], diagnostics = [], fakeProcess = { env: { GITHUB_OUTPUT: '/owned/github-output' }, exitCode: 0 };
  const result = await finalBudget(async () => sizes.map(bytes => ({ bytes })), '/owned/output', { artifactMaximumBytesPerJob: 8_388_608 },
    { appendFile: async (...args) => { observed.push(args); } }, fakeProcess, { error: text => { diagnostics.push(text); } },
    () => {}, { status: 'SELECTED_CHECKS_PASS' });
  return { ...result, exitCode: fakeProcess.exitCode, diagnostics, observed };
}

test('later collection still fails the real final cap gate even after the 07d package was admitted', async () => {
  // Observed packing inputs + archive + manifest + actual 07d follow-up growth.
  const sizes = [4_944_739, 1_497_821, 133_799, 1_481_177];
  const within = await finalizeSizes(sizes);
  assert.equal(within.bytes, 8_057_536);
  assert.equal(within.artifactOk, true);
  assert.equal(within.exitCode, 0);
  const exceeded = await finalizeSizes([...sizes, 400_000]);
  assert.equal(exceeded.bytes, 8_457_536);
  assert.equal(exceeded.artifactOk, false);
  assert.equal(exceeded.exitCode, 1);
  assert.match(exceeded.diagnostics.join('\n'), /result exceeds per-job artifact cap; no upload/u);
  assert.match(exceeded.observed[0][1], /artifact_ok=false/u);
});
