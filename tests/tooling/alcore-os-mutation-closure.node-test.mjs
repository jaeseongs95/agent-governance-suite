import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectOSMutations } from '../../.github/scripts/ags30-os-mutation-r01.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
test('the real OS collector copies and pins an importable transitive identity dependency closure', { timeout: 15_000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'ags-os-closure-'));
  const sourceRoot = path.join(temporary, 'source'), outputRoot = path.join(temporary, 'proof');
  const planPath = '.github/ci/ags30-r11/os-test-plan.json';
  const seedBytes = await fs.readFile(path.join(repository, planPath));
  const seed = JSON.parse(seedBytes);
  const dependencies = ['mcp-server/src/process-identity.ts', 'mcp-server/src/failure-diagnostics.ts', 'runtime/failure-diagnostics.mjs'];
  try {
    for (const relative of [...seed.scopeFiles, ...dependencies, planPath, 'package.json', 'vitest.config.mjs', 'runtime/schema-validation.mjs']) {
      const destination = path.join(sourceRoot, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(repository, relative), destination);
    }
    for (const relative of ['runtime/engineering-practices', 'contracts']) {
      await fs.cp(path.join(repository, relative), path.join(sourceRoot, relative), { recursive: true });
    }
    await fs.symlink(path.join(repository, 'node_modules'), path.join(sourceRoot, 'node_modules'), 'junction');
    // Exercise real preparation/copy/snapshot code, then deliberately stop before
    // native mutation execution. INCOMPLETE is required, never synthetic red proof.
    const result = await collectOSMutations({ sourceRoot, planFile: path.join(sourceRoot, planPath), outputRoot, deadline: 0, wholeSourcePortableId: 'preparation-only-fixture' });
    assert.equal(result.verdict, 'INCOMPLETE');
    assert.ok(result.cases.every(value => value.failureStage === 'PREPARATION'));
    const loader = pathToFileURL(await fs.realpath(path.join(repository, 'node_modules/tsx/dist/loader.mjs'))).href;
    const checkImport = () => spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e',
      "import { processStartTokenAsync } from './mcp-server/src/process-identity.ts'; if (typeof processStartTokenAsync !== 'function') throw new Error('Missing identity API.');"],
    { cwd: outputRoot, timeout: 5000, encoding: 'utf8', windowsHide: true, maxBuffer: 65536 });
    const imported = checkImport();
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.signal, null);
    const proof = JSON.parse(await fs.readFile(path.join(outputRoot, 'engineering-test-proof.json'), 'utf8'));
    for (const relative of dependencies) {
      assert.deepEqual(await fs.readFile(path.join(outputRoot, relative)), await fs.readFile(path.join(sourceRoot, relative)));
      assert.ok(proof.candidate.files.some(value => value.path === relative), 'Copied dependency must also be snapshot-bound: ' + relative);
    }
    assert.deepEqual(await fs.readFile(path.join(sourceRoot, planPath)), seedBytes);
    // A successful import check must reject a missing transitive runtime file.
    await fs.unlink(path.join(outputRoot, 'runtime/failure-diagnostics.mjs'));
    const missing = checkImport();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/u);
  } finally {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
