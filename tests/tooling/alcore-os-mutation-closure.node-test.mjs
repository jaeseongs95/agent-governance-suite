import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const planPath = '.github/ci/ags30-r11/os-test-plan.json';
const dependencies = ['mcp-server/src/process-identity.ts', 'mcp-server/src/failure-diagnostics.ts', 'runtime/failure-diagnostics.mjs', 'mcp-server/src/session-message-protocol.ts'];
async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'ags-os-closure-'));
  t.after(async () => {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const sourceRoot = path.join(temporary, 'source'), outputRoot = path.join(temporary, 'proof');
  const seedBytes = await fs.readFile(path.join(repository, planPath)), seed = JSON.parse(seedBytes);
  for (const relative of [...seed.scopeFiles, ...dependencies, planPath, 'package.json', 'vitest.config.mjs', 'runtime/schema-validation.mjs']) {
    const destination = path.join(sourceRoot, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(repository, relative), destination);
  }
  for (const relative of ['runtime/engineering-practices', 'contracts']) {
    await fs.cp(path.join(repository, relative), path.join(sourceRoot, relative), { recursive: true });
  }
  await fs.symlink(path.join(repository, 'node_modules'), path.join(sourceRoot, 'node_modules'), 'junction');
  // The official collector loads its pinned helper outside the source tree in
  // which it installs dependencies. Reproduce that placement, with no package
  // reachable from the executing helper's directory.
  const helper = path.join(temporary, 'helpers', 'ags30-os-mutation-r01.mjs');
  await fs.mkdir(path.dirname(helper));
  await fs.copyFile(path.join(repository, '.github/scripts/ags30-os-mutation-r01.mjs'), helper);
  assert.throws(() => createRequire(helper).resolve('esbuild'), { code: 'MODULE_NOT_FOUND' });
  assert.ok(createRequire(path.join(sourceRoot, 'package.json')).resolve('esbuild'));
  const { collectOSMutations } = await import(pathToFileURL(helper).href);
  return { temporary, sourceRoot, outputRoot, seedBytes,
    run: () => collectOSMutations({ sourceRoot, planFile: path.join(sourceRoot, planPath), outputRoot, deadline: 0, wholeSourcePortableId: 'preparation-only-fixture' }) };
}
async function addImport(sourceRoot, specifier) {
  await fs.appendFile(path.join(sourceRoot, dependencies[0]), `\nexport * from ${JSON.stringify(specifier)};\n`);
}

test('new transitive imports and cycles are copied, snapshot-bound and actually importable without a fixed dependency list', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const additions = {
    'mcp-server/src/closure-extension.ts': 'import "./nested/closure-cycle.mjs"; export { closureValue } from "../../runtime/closure-leaf.mjs";\n',
    'mcp-server/src/nested/closure-cycle.mjs': 'import "../closure-extension.js";\n',
    'runtime/closure-leaf.mjs': 'export const closureValue = "dependency-chain-loaded";\n',
    'runtime/disconnected.mjs': 'throw new Error("Disconnected input must not be executed or copied.");\n',
  };
  for (const [relative, text] of Object.entries(additions)) {
    const target = path.join(f.sourceRoot, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text);
  }
  await addImport(f.sourceRoot, './closure-extension.js');
  // Actual preparation/copy/snapshot code; deliberate pre-execution stop. This
  // is not synthetic red evidence and does not replace the native OS proof.
  const result = await f.run();
  assert.equal(result.verdict, 'INCOMPLETE');
  assert.ok(result.cases.every(value => value.failureStage === 'PREPARATION'));
  // Match the isolated mutation runner's existing package/config boundary.
  await fs.copyFile(path.join(f.sourceRoot, 'package.json'), path.join(f.outputRoot, 'package.json'));
  const loader = pathToFileURL(await fs.realpath(path.join(repository, 'node_modules/tsx/dist/loader.mjs'))).href;
  const checkImport = () => spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e',
    "import { processStartTokenAsync, closureValue } from './mcp-server/src/process-identity.ts'; if (typeof processStartTokenAsync !== 'function' || closureValue !== 'dependency-chain-loaded') throw new Error('Incomplete runtime closure.');"],
  { cwd: f.outputRoot, timeout: 5000, encoding: 'utf8', windowsHide: true, maxBuffer: 65536 });
  const imported = checkImport(); assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.signal, null);
  const proof = JSON.parse(await fs.readFile(path.join(f.outputRoot, 'engineering-test-proof.json'), 'utf8'));
  for (const relative of [...dependencies, ...Object.keys(additions).filter(name => !name.endsWith('disconnected.mjs'))]) {
    assert.deepEqual(await fs.readFile(path.join(f.outputRoot, relative)), await fs.readFile(path.join(f.sourceRoot, relative)));
    assert.ok(proof.candidate.files.some(value => value.path === relative), 'Copied dependency must also be snapshot-bound: ' + relative);
  }
  assert.equal(new Set(proof.candidate.files.map(value => value.path)).size, proof.candidate.files.length);
  assert.ok(!proof.candidate.files.some(value => value.path === 'runtime/disconnected.mjs'));
  assert.deepEqual(await fs.readFile(path.join(f.sourceRoot, planPath)), f.seedBytes);
  await fs.unlink(path.join(f.outputRoot, 'runtime/failure-diagnostics.mjs'));
  const missing = checkImport(); assert.equal(missing.status, 1); assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/u);
});
test('a missing newly imported runtime dependency rejects preparation', { timeout: 15_000 }, async t => {
  const f = await fixture(t); await addImport(f.sourceRoot, './not-present.js');
  await assert.rejects(f.run(), /Could not resolve/u);
});
test('local imports cannot escape the source repository', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.temporary, 'outside.mjs'), 'export const outside = true;\n');
  await addImport(f.sourceRoot, '../../../outside.mjs');
  await assert.rejects(f.run(), /Unsafe path component|Artifact escapes its root/u);
});
test('an in-repository directory junction is rejected instead of hidden by resolver realpath', { timeout: 15_000 }, async t => {
  const f = await fixture(t), directory = path.join(f.sourceRoot, 'runtime', 'actual-input');
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'local.mjs'), 'export const linked = true;\n');
  await fs.symlink(directory, path.join(f.sourceRoot, 'runtime', 'linked-input'), 'junction');
  await addImport(f.sourceRoot, '../../runtime/linked-input/local.mjs');
  await assert.rejects(f.run(), /Symlinks are not allowed/u);
});
