import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '../..');

test('D0333 repair baseline: original historical-wake client-ensure passes cleanly on unmocked repaired code', () => {
  const result = spawnSync(
    process.execPath,
    [
      './node_modules/vitest/vitest.mjs',
      'run',
      'tests/session-messaging/historical-wake.test.mjs',
      '-t',
      'packaged CLI binds history to explicit broker state directory: client-ensure',
    ],
    {
      cwd: rootDir,
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
      timeout: 30000,
    }
  );

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('packaged CLI binds history to explicit broker state directory: client-ensure');
  expect(result.stdout).toContain('1 passed');
});

test('D0333 negative injection on original historical-wake: reap loop strictly propagates AssertionError on non-ESRCH (EPERM)', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ags-d0333-reap-'));
  const injectorPath = join(tempDir, 'reap-injector.mjs');
  const injectorUrl = pathToFileURL(injectorPath).href;
  const injectorCode = `
    const origKill = process.kill;
    let reapCount = 0;
    process.kill = function(pid, sig) {
      if (sig === 0) {
        reapCount++;
        if (reapCount === 1) {
          const err = new Error('Operation not permitted (injected non-ESRCH EPERM)');
          err.code = 'EPERM';
          throw err;
        }
      }
      return origKill.apply(this, arguments);
    };
  `;
  writeFileSync(injectorPath, injectorCode, 'utf8');

  try {
    const result = spawnSync(
      process.execPath,
      [
        './node_modules/vitest/vitest.mjs',
        'run',
        'tests/session-messaging/historical-wake.test.mjs',
        '-t',
        'packaged CLI binds history to explicit broker state directory: client-ensure',
        `--execArgv=--import=${injectorUrl}`,
      ],
      {
        cwd: rootDir,
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
        timeout: 30000,
      }
    );

    // On repaired historical-wake.test.mjs (line 475: assert.equal(error?.code, 'ESRCH')),
    // injecting EPERM on process.kill(pid, 0) must fail the child test run (status === 1).
    // If historical-wake.test.mjs is reverted to the defective catch-all break, status is 0 and this test FAILS.
    expect(result.status).toBe(1);
    const rawOutput = (result.stdout || '') + (result.stderr || '');
    const cleanOutput = stripVTControlCharacters(rawOutput);
    expect(cleanOutput).toContain('AssertionError');
    expect(cleanOutput).toMatch(/'EPERM' !== 'ESRCH'|expected 'EPERM' to deeply equal 'ESRCH'/);
    expect(cleanOutput).toMatch(/historical-wake\.test\.mjs:475/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
