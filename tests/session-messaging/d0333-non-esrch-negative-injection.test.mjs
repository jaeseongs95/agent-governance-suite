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

const traceEnvironmentKey = 'AGS_D0333_TRACE_PATH';
const targetTest = 'packaged CLI binds history to explicit broker state directory: client-ensure';

function prepareTrace(tempDir) {
  const tracePath = join(tempDir, 'events.jsonl');
  const observerPath = join(tempDir, 'runner-observer.mjs');
  try {
    writeFileSync(tracePath, '', 'utf8');
    writeFileSync(observerPath, `
      import { appendFileSync } from 'node:fs';
      if (process.argv[1]?.replaceAll('\\\\', '/').endsWith('/vitest.mjs')) {
        const mark = event => {
          try { appendFileSync(process.env.${traceEnvironmentKey}, JSON.stringify({ event, at: Date.now() }) + '\\n'); }
          catch { try { process.stderr.write('D0333_TRACE_CAPTURE_FAILED\\n'); } catch { /* 진단 실패가 원래 종료를 바꾸지 않는다. */ } }
        };
        mark('runner-start');
        process.once('exit', code => mark(code === 0 ? 'runner-exit-0' : 'runner-exit-nonzero'));
      }
    `, 'utf8');
    return { tracePath, observerUrl: pathToFileURL(observerPath).href };
  } catch { return { tracePath, observerUrl: null }; }
}

// 임의의 단언 본문·인증 증거·인수를 노출하지 않고 실행기 출력의 판별 정보만 남긴다.
function boundedOutput(output) {
  output = typeof output === 'string' ? output : '';
  const lines = stripVTControlCharacters(output).split(/\r?\n/u);
  const observations = [];
  for (const line of lines) {
    if (line.includes(targetTest)) observations.push('target-test-mentioned');
    if (line.includes('AssertionError')) observations.push('AssertionError');
    if (line.includes('EPERM') && line.includes('ESRCH')) observations.push('EPERM-versus-ESRCH');
    if (line.includes('Test timed out')) observations.push('test-timeout');
    if (line.includes('D0333_TRACE_CAPTURE_FAILED')) observations.push('trace-capture-failed');
    for (const frame of line.matchAll(/historical-wake\.test\.mjs:\d+(?::\d+)?/gu)) observations.push(frame[0]);
    if (/^\s*(?:Test Files|Tests)\s/u.test(line)) {
      observations.push(...(line.match(/\d+ (?:passed|failed|skipped)/gu) ?? []));
    }
    if (observations.length >= 32) break;
  }
  return { bytes: Buffer.byteLength(output), observations: observations.slice(0, 32), filtered: true };
}

function attachFailureDiagnostic(error, result, tracePath, receiptPath, observerUrl) {
  const diagnostic = {
    runnerObservation: observerUrl ? 'PREPARED' : 'OBSERVER_SETUP_FAILED',
    error: result?.error ? { name: result.error.name, code: result.error.code, errno: result.error.errno } : null,
    status: result?.status ?? null,
    signal: result?.signal ?? null,
    stdout: boundedOutput(result?.stdout),
    stderr: boundedOutput(result?.stderr),
  };
  try {
    const lines = readFileSync(tracePath, 'utf8').slice(0, 8192).split('\n').filter(Boolean);
    diagnostic.events = [];
    for (const line of lines.slice(0, 32)) {
      try {
        const { event, at } = JSON.parse(line);
        if (typeof event !== 'string' || !/^[a-zA-Z0-9-]{1,48}$/u.test(event) || !Number.isSafeInteger(at)) throw new Error();
        diagnostic.events.push({ event, at });
      } catch { diagnostic.eventsCapture = 'PARTIAL_OR_INVALID'; }
    }
    if (lines.length > 32) diagnostic.eventsCapture = 'TRUNCATED';
  } catch { diagnostic.eventsCapture = 'READ_OR_PARSE_FAILED'; }
  if (receiptPath) {
    try {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      diagnostic.receipt = { pid: receipt.pid, reapCount: receipt.reapCount,
        frames: String(receipt.stack).match(/historical-wake\.test\.mjs:\d+(?::\d+)?/gu)?.slice(0, 4) ?? [] };
    } catch (captureError) { diagnostic.receiptCapture = captureError?.code === 'ENOENT' ? 'NOT_WRITTEN' : 'READ_OR_PARSE_FAILED'; }
  }
  try {
    const suffix = `\nD0333 diagnostic: ${JSON.stringify(diagnostic)}`;
    error.message += suffix;
    if (typeof error.stack === 'string' && !error.stack.includes(suffix)) error.stack += suffix;
  }
  catch { /* 진단을 덧붙이지 못해도 원래 예외를 그대로 다시 던진다. */ }
}

test('D0333 repair baseline: original historical-wake client-ensure passes cleanly on unmocked repaired code', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ags-d0333-baseline-'));
  const { tracePath, observerUrl } = prepareTrace(tempDir);
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [
        ...(observerUrl ? [`--import=${observerUrl}`] : []),
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
        env: { ...process.env, CI: '1', [traceEnvironmentKey]: tracePath },
        timeout: 45000,
      }
    );

    if (result.error) Reflect.deleteProperty(result.error, 'spawnargs');
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    const cleanOutput = stripVTControlCharacters((result.stdout || '') + (result.stderr || ''));
    expect(cleanOutput).toContain('packaged CLI binds history to explicit broker state directory: client-ensure');
    expect(cleanOutput).toContain('1 passed');
  } catch (error) {
    attachFailureDiagnostic(error, result, tracePath, undefined, observerUrl);
    throw error;
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
}, 60000);

test('D0333 negative injection on original historical-wake: reap loop strictly propagates AssertionError on non-ESRCH (EPERM)', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ags-d0333-reap-'));
  const { tracePath, observerUrl } = prepareTrace(tempDir);
  const injectorPath = join(tempDir, 'reap-injector.mjs');
  const receiptPath = join(tempDir, 'reap-receipt.json');
  const injectorUrl = pathToFileURL(injectorPath).href;
  const injectorCode = `
    import { appendFileSync, writeFileSync } from 'node:fs';
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
            try { appendFileSync(process.env.${traceEnvironmentKey}, JSON.stringify({ event: 'eperm-receipt-written', at: Date.now() }) + '\\n'); }
            catch { try { process.stderr.write('D0333_TRACE_CAPTURE_FAILED\\n'); } catch { /* 진단 실패가 주입할 EPERM을 바꾸지 않는다. */ } }
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

  let result;
  try {
    result = spawnSync(
      process.execPath,
      [
        ...(observerUrl ? [`--import=${observerUrl}`] : []),
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
        env: { ...process.env, CI: '1', [traceEnvironmentKey]: tracePath },
        timeout: 45000,
      }
    );

    if (result.error) Reflect.deleteProperty(result.error, 'spawnargs');
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
  } catch (error) {
    attachFailureDiagnostic(error, result, tracePath, receiptPath, observerUrl);
    throw error;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}, 60000);
