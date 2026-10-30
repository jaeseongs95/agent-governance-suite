import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
      '--reporter=verbose',
    ],
    {
      cwd: rootDir,
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
      timeout: 45000,
    }
  );

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  const cleanOutput = stripVTControlCharacters((result.stdout || '') + (result.stderr || ''));
  expect(cleanOutput).toContain('packaged CLI binds history to explicit broker state directory: client-ensure');
  expect(cleanOutput).toContain('1 passed');
}, 60000);

test('D0333 negative injection on original historical-wake: reap loop strictly propagates AssertionError on non-ESRCH (EPERM)', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ags-d0333-reap-'));
  const injectorPath = join(tempDir, 'reap-injector.mjs');
  const receiptPath = join(tempDir, 'reap-receipt.json');
  const injectorUrl = pathToFileURL(injectorPath).href;
  const injectorCode = `
    import { writeFileSync } from 'node:fs';
    const receiptFile = ${JSON.stringify(receiptPath)};
    const origKill = process.kill;
    let reapCount = 0;
    process.kill = function(pid, sig) {
      if (sig === 0) {
        const stack = String(new Error().stack || '');
        if (stack.includes('historical-wake.test.mjs')) {
          reapCount++;
          if (reapCount === 1) {
            writeFileSync(receiptFile, JSON.stringify({ pid, reapCount, stack }), 'utf8');
            const err = new Error('Operation not permitted (injected non-ESRCH EPERM)');
            err.code = 'EPERM';
            throw err;
          }
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
        '--reporter=verbose',
        `--execArgv=--import=${injectorUrl}`,
      ],
      {
        cwd: rootDir,
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
        timeout: 45000,
      }
    );

    // On repaired historical-wake.test.mjs (line 475: assert.equal(error?.code, 'ESRCH')),
    // injecting EPERM on process.kill(pid, 0) must fail the child test run (status === 1).
    // If historical-wake.test.mjs is reverted to the defective catch-all break, status is 0 and this test FAILS.
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt.reapCount).toBe(1);
    expect(Number.isInteger(receipt.pid) && receipt.pid > 0).toBe(true);
    expect(receipt.stack).toContain('historical-wake.test.mjs');
    const rawOutput = (result.stdout || '') + (result.stderr || '');
    const cleanOutput = stripVTControlCharacters(rawOutput);
    expect(cleanOutput).toContain('AssertionError');
    expect(cleanOutput).toMatch(/'EPERM' !== 'ESRCH'|expected 'EPERM' to deeply equal 'ESRCH'/);
    expect(cleanOutput).toMatch(/historical-wake\.test\.mjs:475/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}, 60000);
