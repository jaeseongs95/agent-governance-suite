import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {gzipSync} from 'node:zlib';
import {finalizePartial, planSourceArchive, writeCollectorRecord} from '../../.github/scripts/ags30-official-source-r11.mjs';

const cap = 8 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const legacyJson = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const rows = Array.from({length: 1800}, (_, i) => ({relativePath: `skills/fixture-${String(i).padStart(4, '0')}/SKILL.md`, bytes: 4096, sha256: 'a'.repeat(64)}));
const manifest = {head: 'b'.repeat(40), sourceTree: 'c'.repeat(40), files: rows.length, rows};
const record = {status: 'FAIL', sourceFreshness: 'PASS', genuineLegacyUpgrade: {status: 'PASS', processStatus: 'PASS'},
  phases: [{name: '04u8-genuine-upgrade', status: 'PASS', exitCode: 0}, {name: '07p-previous-broker', status: 'FAIL', exitCode: 1}],
  failure: {name: 'AssertionError', code: 'ERR_ASSERTION', message: 'original independent failure remains'}};

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'ags-al09-cap-'));
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  try {await run(directory);} finally {await fs.rm(directory, {recursive: true, force: true});}
}

// Uses the collector's real generated-JSON encoder, without executing the CI main or any product command.
async function generated(directory, name, value) {
  await writeCollectorRecord(directory, value);
  if (name !== 'result.json') await fs.rename(path.join(directory, 'result.json'), path.join(directory, name));
}

test('genuine proof and every raw byte coexist below the unchanged pre-compression cap without changing FAIL', async () => {
  await fixture(async directory => {
    const output = path.join(directory, 'result'); await fs.mkdir(output);
    const generatedFiles = new Map(['source-before.json', 'source-after.json', 'source-final.json', 'source-manifest.json', 'genuine-old-source-manifest.json'].map(name => [name, manifest]));
    generatedFiles.set('04u8-genuine-upgrade.receipt.json', {name: '04u8-genuine-upgrade', status: 'PASS', exitCode: 0});
    generatedFiles.set('07p-previous-broker.receipt.json', {name: '07p-previous-broker', status: 'FAIL', exitCode: 1});
    generatedFiles.set('result.json', record);
    const raw = new Map([
      ['04u8-genuine-upgrade.stdout.bin', Buffer.from('genuine upgrade fixture process PASS\n')],
      ['04u8-genuine-upgrade.stderr.bin', Buffer.from('original captured diagnostics\n')],
      ['07p-previous-broker.stdout.bin', Buffer.from('original previous-broker failure stdout\n')],
      ['07p-previous-broker.stderr.bin', Buffer.from('original previous-broker failure stderr\n')],
      ['genuine-upgrade/original-plan.json', Buffer.from('{ "integrityToken": "sealed-fixture-original", "preserveWhitespace": true }\n')],
      ['genuine-upgrade/original-history.json', Buffer.from('{ "history": ["original", "unmodified"] }\n')],
      ['genuine-upgrade/result.json', Buffer.from('{ "passed": true, "genuineOldServiceIssuance": true }\n')],
    ]);
    // Synthetic size regression for the reported R35 byte total; not recovered R35 evidence.
    const legacyBytes = [...generatedFiles.values()].reduce((sum, value) => sum + legacyJson(value).length, 0)
      + [...raw.values()].reduce((sum, value) => sum + value.length, 0);
    const originalTotal = 8_510_742;
    assert(legacyBytes < originalTotal);
    raw.set('all-other-original-raw.bin', Buffer.alloc(originalTotal - legacyBytes, 0x52));
    assert.equal([...generatedFiles.values()].reduce((sum, value) => sum + legacyJson(value).length, 0)
      + [...raw.values()].reduce((sum, value) => sum + value.length, 0), originalTotal);
    for (const [name, bytes] of raw) {
      await fs.mkdir(path.dirname(path.join(output, name)), {recursive: true});
      await fs.writeFile(path.join(output, name), bytes);
    }
    for (const [name, value] of generatedFiles) await generated(output, name, value);
    const githubOutput = path.join(directory, 'github-output');
    const observed = await finalizePartial(output, githubOutput, 'failure');
    assert.equal(observed.artifactOk, true, 'all original raw and genuine proof must fit unchanged 8MiB');
    assert(observed.bytes <= cap);
    assert.equal(observed.outcome, 'failure');
    for (const [name, bytes] of raw) assert.deepEqual(await fs.readFile(path.join(output, name)), bytes, name);
    for (const [name, value] of generatedFiles) assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, name), 'utf8')), value, name);
    const sealed = JSON.parse(await fs.readFile(path.join(output, 'finalization-files.json'), 'utf8'));
    assert.deepEqual(new Set(sealed.rows.map(row => row.relativePath)), new Set([...raw.keys(), ...generatedFiles.keys(), 'finalization.json']));
    let total = (await fs.stat(path.join(output, 'finalization-files.json'))).size;
    for (const row of sealed.rows) {
      const bytes = await fs.readFile(path.join(output, row.relativePath));
      assert.equal(row.bytes, bytes.length); assert.equal(row.sha256, sha(bytes)); total += bytes.length;
    }
    assert.equal(observed.bytes, total);
    assert.match(await fs.readFile(githubOutput, 'utf8'), /artifact_ok=true\n/u);
    const persisted = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8'));
    assert.deepEqual(persisted, record);
    console.log(JSON.stringify({fixture: 'R35_REPORTED_SIZE_SYNTHETIC_ALL_RAW_PRESERVED', originalBytes: originalTotal, actualFinalizedBytes: observed.bytes, cap, savedBytes: originalTotal - observed.bytes}));
  });
});

test('a highly compressible raw payload over 8MiB is still rejected before ZIP compression', async () => {
  await fixture(async directory => {
    const output = path.join(directory, 'result'); await fs.mkdir(output);
    const bytes = Buffer.alloc(cap + 1, 0x41);
    assert(gzipSync(bytes).length < cap);
    await fs.writeFile(path.join(output, 'original.stdout.bin'), bytes);
    const githubOutput = path.join(directory, 'github-output');
    const observed = await finalizePartial(output, githubOutput, 'failure');
    assert.equal(observed.artifactOk, false);
    assert.equal(observed.failure, 'Artifact cap exceeded');
    assert.match(await fs.readFile(githubOutput, 'utf8'), /artifact_ok=false\n/u);
    assert.deepEqual(await fs.readFile(path.join(output, 'original.stdout.bin')), bytes);
    await assert.rejects(fs.access(path.join(output, 'finalization-files.json')), {code: 'ENOENT'});
  });
});

test('source archive budget includes result/finalizer metadata and keeps the cap refusal', () => {
  const sourceRecord = {unit: 'fixture', nonce: 'a', sourceBinding: {runId: '1', attempt: '1'}, ...record};
  const existing = [{relativePath: 'original.stdout.bin', bytes: 1000, sha256: 'a'.repeat(64)}];
  const archive = {bytes: 1000, sha256: 'b'.repeat(64)};
  const fits = planSourceArchive(existing, sourceRecord, archive, cap);
  assert.equal(fits.descriptor.status, 'RETURNED'); assert(fits.maximumBytes > 2000 && fits.maximumBytes < cap);
  const exceeds = planSourceArchive([{...existing[0], bytes: cap}], sourceRecord, archive, cap);
  assert.equal(exceeds.descriptor.status, 'NOT_RETURNED_CAP');
  assert.equal(exceeds.descriptor.locator, null); assert(exceeds.maximumBytes > cap);
});
