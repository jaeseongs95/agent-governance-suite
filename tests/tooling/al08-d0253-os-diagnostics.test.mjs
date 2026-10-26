import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { captureSnapshot } from '../../runtime/engineering-practices/core.mjs';
import { afterEach, expect, it, vi } from 'vitest';
import { collectOSMutations } from '../../.github/scripts/ags30-os-mutation-r01.mjs';
import { emitCollectorSummary, osProofFailure, recordCollectorFailure, recordOSProofEvidence,
  writeCollectorRecord } from '../../.github/scripts/ags30-official-source-r11.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const roles = { redReceipt: 'red.receipt.json', greenReceipt: 'green.receipt.json', redReport: 'red.vitest.json', greenReport: 'green.vitest.json' };
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(mode, snapshotRoot = root) {
  const work = await fs.mkdtemp(path.join(tmpdir(), 'al08-d0253-PRIVATE_IMPORT_SENTINEL-'));
  temporary.push(work);
  const sourceRoot = path.join(work, 'source'), outputRoot = path.join(work, 'result', 'os-proof');
  const copy = async (relative, target = relative, from = root) => {
    const destination = path.join(sourceRoot, target);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(from, relative), destination);
  };
  await copy('runtime/schema-validation.mjs');
  for (const file of (await fs.readdir(path.join(root, 'contracts'))).filter(file => /^engineering-.*\.v1\.schema\.json$/u.test(file))) await copy(`contracts/${file}`);
  const runner = 'runtime/engineering-practices/runner.mjs';
  await copy('tests/tooling/fixtures/al08-d0253-runner.mjs', runner);
  expect(await fs.readFile(path.join(sourceRoot, runner))).toEqual(await fs.readFile(path.join(root, 'tests/tooling/fixtures/al08-d0253-runner.mjs')));
  const plan = JSON.parse(await fs.readFile(path.join(root, '.github/ci/ags30-r11/os-test-plan.json'), 'utf8'));
  // Keep the declared seeds, including computed worker inputs, and derive their
  // local runtime and engineering-core dependencies instead of mirroring imports by hand.
  const graph = await build({ absWorkingDir: snapshotRoot,
    entryPoints: [...plan.scopeFiles, 'runtime/engineering-practices/core.mjs'],
    outdir: 'diagnostic-fixture-closure', bundle: true, write: false, metafile: true,
    platform: 'node', format: 'esm', target: 'node24', packages: 'external', logLevel: 'silent' });
  const inputs = Object.keys(graph.metafile.inputs).map(file =>
    path.relative(snapshotRoot, path.resolve(snapshotRoot, file)).split(path.sep).join('/'));
  for (const file of captureSnapshot(snapshotRoot, [...new Set([...plan.scopeFiles, ...inputs])]).files) {
    await copy(file.path, file.path, snapshotRoot);
  }
  for (const file of ['package.json', 'vitest.config.mjs']) await copy(file);
  const callsFile = path.join(work, 'runner-calls.jsonl');
  const production = await fs.readFile(path.join(sourceRoot, 'mcp-server/src/broker-process-lock.ts'));
  plan.scopeFiles.push('diagnostic-fixture.json');
  await fs.writeFile(path.join(sourceRoot, 'diagnostic-fixture.json'), JSON.stringify({ mode, callsFile, productionDigest: `sha256:${sha(production)}` }));
  await fs.mkdir(path.join(sourceRoot, 'node_modules/vitest'), { recursive: true });
  await fs.symlink(await fs.realpath(path.join(root, 'node_modules/esbuild')), path.join(sourceRoot, 'node_modules/esbuild'), 'junction');
  // realpath input only: the fixture runner never executes this data file.
  await copy('LICENSE', 'node_modules/vitest/vitest.mjs');
  const planFile = path.join(work, 'plan.json');
  await fs.writeFile(planFile, JSON.stringify(plan));
  await fs.mkdir(path.dirname(outputRoot), { recursive: true });
  return { work, sourceRoot, outputRoot, planFile, callsFile,
    collect: deadline => collectOSMutations({ sourceRoot, outputRoot, planFile,
      deadline: deadline ?? Date.now() + 120_000, wholeSourcePortableId: 'fixture-whole-source-not-acceptance' }) };
}

async function persistedSummary(f, evidence, error) {
  const record = { status: 'FAIL', sourceFreshness: 'PASS', runtimeValidation: 'FAIL', phases: [] };
  const passing = evidence ? recordOSProofEvidence(record, evidence) : false;
  if (error) recordCollectorFailure(record, error);
  await writeCollectorRecord(path.dirname(f.outputRoot), record);
  const persisted = JSON.parse(await fs.readFile(path.join(path.dirname(f.outputRoot), 'result.json'), 'utf8'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  emitCollectorSummary(persisted, 123, true);
  expect(log).toHaveBeenCalledTimes(1);
  const serialized = log.mock.calls[0][0];
  const summary = JSON.parse(serialized);
  log.mockRestore();
  expect(serialized).not.toContain('PRIVATE_');
  expect(summary.status).toBe('FAIL');
  return { record: persisted, summary, passing };
}

async function assertRefs(f, evidence, summary, expectedRoles) {
  for (const row of evidence.cases) {
    const projected = summary.aggregateFailures[0].cases.find(item => item.caseId === row.caseId);
    for (const [role, suffix] of Object.entries(roles)) {
      if (!expectedRoles.includes(role)) {
        expect(row.artifacts[role]).toBeNull();
        expect(projected.artifacts[role]).toBeNull();
        await expect(fs.access(path.join(f.outputRoot, `${row.caseId}.${suffix}`))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        const file = `${row.caseId}.${suffix}`, bytes = await fs.readFile(path.join(f.outputRoot, file));
        expect(row.artifacts[role]).toEqual({ path: file, bytes: bytes.length, sha256: sha(bytes) });
        expect(projected.artifacts[role]).toEqual({ path: `os-proof/${file}`, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
}

it.each([['red-throw', 'RED_EXECUTION', []], ['green-throw', 'GREEN_EXECUTION', ['redReceipt']]])(
  'D0253 actual %s catch preserves original failure and only written references', async (mode, stage, expectedRoles) => {
    const f = await fixture(mode), evidence = await f.collect();
    const { record, summary, passing } = await persistedSummary(f, evidence);
    expect(passing).toBe(false); expect(evidence.verdict).toBe('INCOMPLETE');
    expect(record.mutationSensitivity).toEqual(evidence);
    expect(record.formalEngineeringProof).toBe('INCOMPLETE');
    for (const row of evidence.cases) {
      expect(row).toMatchObject({ status: 'INVALID_OR_INCOMPLETE_EVIDENCE', failureStage: stage });
      expect(row.error).toContain('PRIVATE_RUNNER_SENTINEL');
    }
    expect(summary.aggregateFailures[0]).toMatchObject({ phase: '07-os-mutation-proof', status: 'FAIL', code: 'OS_PROOF_NOT_CONSISTENT' });
    expect(summary.aggregateFailures[0].cases.map(row => row.caseId)).toEqual(['OS-001', 'OS-002', 'OS-003']);
    expect(summary.aggregateFailures[0].cases.every(row => row.failureStage === stage)).toBe(true);
    expect(summary.aggregateFailures[0].cases.every(row => row.redStatus === (mode === 'red-throw' ? 'UNVERIFIED' : 'FAIL')
      && row.greenStatus === 'UNVERIFIED')).toBe(true);
    await assertRefs(f, evidence, summary, expectedRoles);
  });

it.each(['witness-reject', 'spawn-error'])('D0253 actual %s remains inadmissible after green and reports', async mode => {
  const f = await fixture(mode), evidence = await f.collect();
  const { record, summary, passing } = await persistedSummary(f, evidence);
  expect(passing).toBe(false); expect(record.formalEngineeringProof).toBe('INCOMPLETE');
  expect(evidence.cases.every(row => row.failureStage === 'RED_WITNESS' && row.greenStatus === 'PASS')).toBe(true);
  expect(evidence.cases.every(row => row.redStatus === (mode === 'spawn-error' ? 'SPAWN_ERROR' : 'FAIL'))).toBe(true);
  expect(summary.aggregateFailures[0].cases.every(row => row.code === 'OS_RED_WITNESS_REJECTED')).toBe(true);
  const proof = JSON.parse(await fs.readFile(path.join(f.outputRoot, 'engineering-test-proof.json'), 'utf8'));
  expect(proof.proofs.every(row => row.status === 'NOT_RUN' && row.red.path === '' && row.green.path === '')).toBe(true);
  await assertRefs(f, evidence, summary, Object.keys(roles));
});

it('D0253 missing report preserves its actual phase and does not invent report references', async () => {
  const f = await fixture('report-missing'), evidence = await f.collect();
  const { summary } = await persistedSummary(f, evidence);
  expect(evidence.cases.every(row => row.failureStage === 'REPORT_READ' && row.error.includes('ENOENT'))).toBe(true);
  expect(summary.aggregateFailures[0].cases.every(row => row.code === 'OS_REPORT_UNAVAILABLE')).toBe(true);
  await assertRefs(f, evidence, summary, ['redReceipt', 'greenReceipt']);
});

it('D0253 a rejected green cannot repair the proof even when the fixture red reaches its witness', async () => {
  const f = await fixture('green-reject'), evidence = await f.collect();
  const { record, summary, passing } = await persistedSummary(f, evidence);
  expect(passing).toBe(false); expect(record.formalEngineeringProof).toBe('INCOMPLETE');
  expect(evidence.cases.every(row => row.failureStage === 'GREEN_WITNESS' && row.redStatus === 'FAIL' && row.greenStatus === 'FAIL')).toBe(true);
  expect(summary.aggregateFailures[0].cases.every(row => row.code === 'OS_GREEN_WITNESS_REJECTED')).toBe(true);
  const proof = JSON.parse(await fs.readFile(path.join(f.outputRoot, 'engineering-test-proof.json'), 'utf8'));
  expect(proof.proofs.every(row => row.status === 'NOT_RUN' && row.red.path === '' && row.green.path === '')).toBe(true);
  await assertRefs(f, evidence, summary, Object.keys(roles));
});

it('D0253 budget rejection executes no runner and keeps the original preparation gate', async () => {
  const f = await fixture('witness-reject'), evidence = await f.collect(Date.now() + 94_000);
  const { summary } = await persistedSummary(f, evidence);
  expect(evidence.cases.every(row => row.failureStage === 'PREPARATION')).toBe(true);
  await expect(fs.access(f.callsFile)).rejects.toMatchObject({ code: 'ENOENT' });
  await assertRefs(f, evidence, summary, []);
});

it('D0253 real import failure before any case reaches the actual collector record and console boundaries', async () => {
  const f = await fixture('witness-reject');
  await fs.unlink(path.join(f.sourceRoot, 'runtime/engineering-practices/runner.mjs'));
  let original;
  try { await f.collect(); } catch (error) { original = error; }
  expect(original).toBeInstanceOf(Error);
  expect(original.code).toMatch(/ERR_MODULE_NOT_FOUND|ERR_LOAD_URL/u);
  const { record, summary } = await persistedSummary(f, null, original);
  expect(record.failure).toEqual({ name: original.name, message: original.message, code: original.code });
  expect(record.failure.message).toContain('PRIVATE_IMPORT_SENTINEL');
  expect(summary.failureType).toBe(original.name); expect(summary.failureCode).toBe(original.code);
  expect(summary.aggregateFailures).toEqual([]);
  expect(record).not.toHaveProperty('mutationSensitivity');
  await expect(fs.access(f.outputRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('D0253 projection refuses unknown cases, arbitrary paths and malformed reference metadata', async () => {
  const f = await fixture('witness-reject'), evidence = await f.collect();
  for (const invalid of [
    { path: '../../PRIVATE_PATH', bytes: 1, sha256: 'a'.repeat(64) },
    { path: 'OS-002.red.receipt.json', bytes: 1, sha256: 'a'.repeat(64) },
    { path: 'OS-001.red.receipt.json', bytes: -1, sha256: 'a'.repeat(64) },
    { path: 'OS-001.red.receipt.json', bytes: 8 * 1024 * 1024 + 1, sha256: 'a'.repeat(64) },
    { path: 'OS-001.red.receipt.json', bytes: 1, sha256: 'PRIVATE_HASH' },
  ]) {
    const malformed = structuredClone(evidence);
    malformed.cases[0].artifacts.redReceipt = invalid;
    expect(osProofFailure(malformed).cases[0].artifacts.redReceipt).toBeNull();
  }
  const unrelated = structuredClone(evidence);
  unrelated.cases[0].caseId = 'PRIVATE_UNKNOWN_CASE';
  const projected = osProofFailure(unrelated);
  expect(projected.cases[0].status).toBe('UNVERIFIED');
  expect(Object.values(projected.cases[0].artifacts).every(value => value === null)).toBe(true);
  expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
  const duplicate = structuredClone(evidence);
  duplicate.cases.push(structuredClone(duplicate.cases[0]));
  expect(osProofFailure(duplicate).cases[0].status).toBe('UNVERIFIED');
  expect(Object.values(osProofFailure(duplicate).cases[0].artifacts).every(value => value === null)).toBe(true);
  expect(osProofFailure({ verdict: 'CONSISTENT' })).toBeNull();
  const positive = { aggregateFailures: [{ code: 'EXISTING_FAILURE' }] };
  expect(recordOSProofEvidence(positive, { verdict: 'CONSISTENT' })).toBe(true);
  expect(positive.aggregateFailures).toEqual([{ code: 'EXISTING_FAILURE' }]);
});

it('D0253 fixture copies and snapshot-binds a newly added transitive local dependency', async () => {
  const original = await fixture('witness-reject');
  const additions = {
    'mcp-server/src/diagnostic-fixture-link.mjs': 'export { diagnosticFixtureValue } from "../../runtime/diagnostic-fixture-leaf.mjs";\n',
    'runtime/diagnostic-fixture-leaf.mjs': 'export const diagnosticFixtureValue = 73;\n',
  };
  for (const [relative, text] of Object.entries(additions)) await fs.writeFile(path.join(original.sourceRoot, relative), text);
  await fs.appendFile(path.join(original.sourceRoot, 'mcp-server/src/process-identity.ts'),
    '\nexport * from "./diagnostic-fixture-link.mjs";\n');
  await fs.writeFile(path.join(original.sourceRoot, 'runtime/engineering-practices/diagnostic-fixture-extension.mjs'),
    'export const engineeringFixtureValue = 91;\n');
  await fs.appendFile(path.join(original.sourceRoot, 'runtime/engineering-practices/core.mjs'),
    '\nexport * from "./diagnostic-fixture-extension.mjs";\n');
  const f = await fixture('witness-reject', original.sourceRoot);
  await f.collect();
  const proof = JSON.parse(await fs.readFile(path.join(f.outputRoot, 'engineering-test-proof.json'), 'utf8'));
  for (const relative of Object.keys(additions)) {
    expect(await fs.readFile(path.join(f.outputRoot, relative))).toEqual(await fs.readFile(path.join(original.sourceRoot, relative)));
    expect(proof.candidate.files.some(file => file.path === relative)).toBe(true);
  }
  const imported = await import(pathToFileURL(path.join(f.outputRoot, 'mcp-server/src/diagnostic-fixture-link.mjs')).href);
  expect(imported.diagnosticFixtureValue).toBe(73);
  const core = await import(pathToFileURL(path.join(f.sourceRoot, 'runtime/engineering-practices/core.mjs')).href);
  expect(core.engineeringFixtureValue).toBe(91);
});
