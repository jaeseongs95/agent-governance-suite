import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { assertCurrentRuntime, verifyUpgradeSource } from '../../validation/run-upgrade-test.mjs';
import { assertGenuineUpgradeResult, emitCollectorSummary } from '../../.github/scripts/ags30-official-source-r11.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = [];
const configPath = '.github/ci/ags30-r11/execution-config.json';
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture({ pnpm = '11.20.0', node = '26.1.0', packageManager = 'pnpm@' + pnpm, pinnedConfig = true } = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'al06-d0040-toolchain-'));
  temporary.push(directory);
  const contents = { 'package.json': JSON.stringify({ packageManager }), 'pnpm-lock.yaml': 'frozen fixture\n',
    'scripts/run-tests.mjs': 'export {};\n', 'mcp-server/src/workflow-service.ts': 'export {};\n', [configPath]: JSON.stringify({ pnpm, node }) };
  const rows = [];
  for (const [relativePath, text] of Object.entries(contents)) {
    const filename = path.join(directory, relativePath);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, text);
    if (pinnedConfig || relativePath !== configPath) rows.push({ relativePath, bytes: Buffer.byteLength(text), sha256: sha(text) });
  }
  const loader = path.join(directory, 'node_modules/tsx/dist/loader.mjs');
  await fs.mkdir(path.dirname(loader), { recursive: true });
  await fs.writeFile(loader, '');
  const manifestBytes = Buffer.from(JSON.stringify({ head: 'a'.repeat(40), sourceTree: 'b'.repeat(40), files: rows.length, rows }));
  const manifestPath = path.join(directory, 'manifest.json');
  await fs.writeFile(manifestPath, manifestBytes);
  return { directory, commit: 'a'.repeat(40), tree: 'b'.repeat(40), manifestPath,
    serviceSha256: sha(contents['mcp-server/src/workflow-service.ts']), pin: sha(manifestBytes) };
}

it('accepts a different current toolchain only when verified config, package contract and observed runtime agree', async () => {
  const input = await fixture();
  const current = await verifyUpgradeSource(input, input.commit, input.pin);
  expect(current.toolchain).toEqual({ pnpm: '11.20.0', node: '26.1.0' });
  expect(() => assertCurrentRuntime(current.toolchain, 'v26.1.0')).not.toThrow();
  expect(() => assertCurrentRuntime(current.toolchain, 'v24.22.1')).toThrow('Current Node runtime must match');
});

it('rejects package/config mismatch, malformed versions, unpinned config and changed verified config bytes', async () => {
  for (const options of [{ packageManager: 'pnpm@11.19.0' }, { pnpm: 'anything' }, { node: '26' }, { pinnedConfig: false }]) {
    const input = await fixture(options);
    await expect(verifyUpgradeSource(input, input.commit, input.pin)).rejects.toThrow();
  }
  const input = await fixture();
  await fs.appendFile(path.join(input.directory, configPath), '\n');
  await expect(verifyUpgradeSource(input, input.commit, input.pin)).rejects.toThrow('Source size differs');
});

it('keeps the historical package contract fixed while current configuration can change', async () => {
  const old = await fixture({ packageManager: 'pnpm@11.19.0' });
  const checked = await verifyUpgradeSource(old, old.commit, old.pin, { historical: true });
  expect(checked.toolchain).toBeNull();
  const changed = await fixture({ packageManager: 'pnpm@11.20.0' });
  await expect(verifyUpgradeSource(changed, changed.commit, changed.pin, { historical: true })).rejects.toThrow();
});

async function actualBlock({ banner = '11.20.0' } = {}) {
  const text = await fs.readFile(path.join(root, '.github/scripts/ags30-official-source-r11.mjs'), 'utf8');
  const start = text.indexOf('    // The historical service is required once per OS');
  const end = text.indexOf("    mustPass(await command('04a-new-test-syntax'", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('context', 'with(context){' + text.slice(start, end) + '}');
  const oldHead = 'b3285616c896afdcbb298e3a08dffd612ddfa7b8';
  const oldTree = '797ccf5960fea8fcebe16025d7786ca389ab6fbc';
  const head = 'a'.repeat(40);
  const rows = [{ relativePath: 'mcp-server/src/workflow-service.ts', sha256: 'c'.repeat(64) }];
  const outcome = { passed: true, genuineOldServiceIssuance: true, sameSqliteStoreReopened: true, historyUnchangedOnRejection: true,
    originalHmacNotReissued: true, originalSigningKeyNotAccessed: true, originalHistoryRetained: true, newExplicitPrePassed: true,
    genuineMissingPhaseCode: 'BINDING_REQUIRED', corruptedCopyCode: 'INVALID_INPUT', oldPreResultCode: 'BINDING_REQUIRED',
    sameRootReplanOrdinal: 2, newRootCount: 0, sourceOld: oldHead, sourceCurrent: head };
  const pass = name => ({ receipt: { name, status: 'PASS' }, stdout: Buffer.from('') });
  const record = {}, calls = [];
  const context = { assert, path, process, sha, config: { pnpm: '11.20.0' }, shardIndex: 1, work: '/owned/work', output: '/owned/output', source: '/owned/source',
    pnpmCli: '/owned/tools/pnpm.cjs', head, sourceTree: 'b'.repeat(40), transport: { sha256: 'd'.repeat(64) }, manifest: { rows }, record,
    git: async name => { const p = pass(name); p.stdout = Buffer.from(name === '04u3-old-head' ? oldHead : name === '04u4-old-tree' ? oldTree : ''); return p; },
    command: async (name, executable, argv) => { calls.push({ name, executable, argv }); const p = pass(name); if (name.startsWith('04u7-')) p.stdout = Buffer.from(banner + '\n'); return p; },
    buildHeadManifest: async () => ({ files: 1733, rows }), writeJson: async () => {},
    fs: { readFile: async name => Buffer.from(name.endsWith('result.json') ? JSON.stringify(outcome) : '{}') },
    mustPass: p => { assert.equal(p.receipt.status, 'PASS'); return p; }, assertGenuineUpgradeResult };
  await run(context);
  return { record, calls };
}

it('actual collector banner gate follows config.pnpm instead of the old literal', async () => {
  const observed = await actualBlock();
  expect(observed.record.genuineLegacyUpgrade.status).toBe('PASS');
  expect(observed.calls.filter(row => row.name.startsWith('04u7-'))).toHaveLength(2);
});

it('actual collector still rejects a banner that disagrees with its configured entry', async () => {
  await expect(actualBlock({ banner: '11.19.0' })).rejects.toThrow();
});

it('CI summary separates per-OS D40 process/outcome and an independent original 07p failure', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const runnerOs of ['Linux', 'Windows']) {
    for (const scenario of [
      { upgrade: { status: 'FAIL', processStatus: 'PASS' }, phase: '04u8-genuine-upgrade' },
      { upgrade: { status: 'FAIL', processStatus: 'FAIL' }, phase: '04u8-genuine-upgrade' },
      { upgrade: { status: 'PASS', processStatus: 'PASS' }, phase: '07p-previous-broker' }
    ]) {
      const record = { status: 'FAIL', runnerOs, shardIndex: 1, sourceFreshness: 'PASS', genuineLegacyUpgrade: scenario.upgrade,
        failure: { name: 'AssertionError', code: 'ERR_ASSERTION' }, phases: [{ name: scenario.phase, status: 'FAIL', exitCode: 1 }] };
      emitCollectorSummary(record, 100, true);
      const summary = JSON.parse(log.mock.calls.at(-1)[0]);
      expect(summary.status).toBe('FAIL');
      expect(summary.genuineLegacyUpgrade).toEqual({ phase: '04u8-genuine-upgrade', runnerOs, shardIndex: 1, ...scenario.upgrade });
      expect(summary.phases[0].name).toBe(scenario.phase);
      expect(summary.failureCode).toBe('ERR_ASSERTION');
    }
  }
});
