import type { ChildProcess } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { expect, it as baseIt, vi } from 'vitest';

// Default discovery skips this opt-in corpus; the dedicated wrapper rejects unsupported runs.
const it = baseIt.skipIf(process.platform !== 'win32' || process.env.AGS_WINDOWS_ARGV_OPT_IN !== '1');

// Instrument the real execFile; never replace its argv, options, events or callback.
const owned = vi.hoisted(() => [] as {
  child: ChildProcess; closed: Promise<void>; done: boolean; spawned: boolean;
  requestedAt: number; spawnAt: number | null; exitAt: number | null; closeAt: number | null;
}[]);
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, execFile: (...args: Parameters<typeof real.execFile>) => {
    const requestedAt = performance.now();
    const child = real.execFile(...args);
    const record = { child, closed: Promise.resolve(), done: false, spawned: false, requestedAt,
      spawnAt: null as number | null, exitAt: null as number | null, closeAt: null as number | null };
    record.closed = new Promise<void>((resolve) => child.once('close', () => {
      record.closeAt = performance.now(); record.done = true; resolve();
    }));
    child.once('spawn', () => { record.spawnAt = performance.now(); record.spawned = true; });
    child.once('exit', () => { record.exitAt = performance.now(); });
    owned.push(record);
    return child;
  } };
});

import { transportWakePort } from '../../mcp-server/src/session-message-wake-port.js';

type Witness = { pid: number; argv: string[]; entry: string; executable: string; project: string | null; sourceMetadataPresent: boolean };
const helper = fileURLToPath(new URL('./fixtures/windows-agentapi.cjs', import.meta.url));
const envKeys = ['ANTIGRAVITY_AGENTAPI_EXE', 'ANTIGRAVITY_PROJECT_ID', 'ANTIGRAVITY_SOURCE_METADATA',
  'AGS_ARGV_WITNESS', 'AGS_ARGV_MODE', 'AGS_ARGV_TOKEN', 'NODE_OPTIONS', 'NODE_PATH',
  'NODE_V8_COVERAGE', 'NODE_COMPILE_CACHE'] as const;

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  const deadline = performance.now() + milliseconds;
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      const check = () => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) reject(new Error('Owned Windows fixture deadline exceeded.'));
        else timer = setTimeout(check, remaining);
      };
      check();
    })]);
  } finally { clearTimeout(timer!); }
}

async function fixture(mode: string, sessionId: string, message: string) {
  // Registered opt-in cases fail on missing inputs; never turn an eligible run into a skip.
  expect(process.platform).toBe('win32');
  expect(process.env.AGS_WINDOWS_ARGV_OPT_IN).toBe('1');
  const output = process.env.AGS_WINDOWS_ARGV_OUTPUT;
  if (!output || !path.isAbsolute(output)) throw new Error('Missing frozen case/output binding.');
  const oldCwd = process.cwd();
  const oldEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  const directory = mkdtempSync(path.join(tmpdir(), 'ags-windows-argv-'));
  const work = path.join(directory, '공백 경로');
  const executable = path.join(work, 'native & %AGS_ARGV_TOKEN% 실행.exe');
  const witnessPath = path.join(directory, 'witness.jsonl');
  const first = owned.length;
  const observationStart = performance.now();
  const lifetimeCaseId = expect.getState().currentTestName?.match(/WARGV-\d{3}/u)?.[0] ?? null;
  let witnessWritten = false;
  const cleanup = {
    phase: 'restore' as 'restore' | 'children' | 'remove', cwdRestored: null as boolean | null,
    children: [] as typeof owned, rmStarted: null as number | null, rmEnded: null as number | null,
    rmResult: 'not-attempted' as 'not-attempted' | 'returned' | 'threw',
  };
  let outcome: string;
  let elapsed: number;
  let witness: Witness[];
  let spawned: boolean[];
  let lifecycle: { killed: boolean; exitCode: number | null; signalCode: NodeJS.Signals | null }[];
  let failure: { error: unknown } | null = null;
  let cleanupFailure: { error: unknown } | null = null;
  try {
    mkdirSync(work);
    // node.exe is the native Windows executable; 'agentapi' is its CJS entry.
    copyFileSync(process.execPath, executable);
    copyFileSync(helper, path.join(work, 'agentapi'));
    writeFileSync(path.join(work, 'package.json'), '{"type":"commonjs"}\n', { encoding: 'utf8', flag: 'wx' });
    writeFileSync(witnessPath, '', { encoding: 'utf8', flag: 'wx' });
    process.chdir(work); // Requires Vitest pool=forks (not worker_threads).
    process.env.ANTIGRAVITY_AGENTAPI_EXE = mode === 'missing-exe' ? path.join(work, 'absent.exe') : executable;
    process.env.ANTIGRAVITY_PROJECT_ID = 'source-project';
    process.env.ANTIGRAVITY_SOURCE_METADATA = 'synthetic-source';
    process.env.AGS_ARGV_WITNESS = witnessPath;
    process.env.AGS_ARGV_MODE = mode;
    process.env.AGS_ARGV_TOKEN = 'synthetic-expansion-value';
    delete process.env.NODE_OPTIONS;
    delete process.env.NODE_PATH;
    delete process.env.NODE_V8_COVERAGE;
    delete process.env.NODE_COMPILE_CACHE;
    const started = performance.now();
    outcome = await bounded(transportWakePort('gemini-queue').dispatch({ host: 'gemini', sessionId }, message), 16_000);
    elapsed = performance.now() - started;
    await bounded(Promise.all(owned.slice(first).map(record => record.closed)), 2_000);
    witness = readFileSync(witnessPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Witness);
    for (const row of witness) {
      expect(row.entry).toBe(path.join(work, 'agentapi'));
      expect(row.executable).toBe(executable);
    }
    spawned = owned.slice(first).map(record => record.spawned);
    lifecycle = owned.slice(first).map(record => ({
      killed: record.child.killed, exitCode: record.child.exitCode, signalCode: record.child.signalCode,
    }));
    expect(owned.slice(first).every(record => record.done)).toBe(true);
    expect(process.env.ANTIGRAVITY_PROJECT_ID).toBe('source-project');
    expect(process.env.ANTIGRAVITY_SOURCE_METADATA).toBe('synthetic-source');
    const caseId = expect.getState().currentTestName?.match(/WARGV-\d{3}/u)?.[0];
    if (!caseId || !output || !path.isAbsolute(output)) throw new Error('Missing frozen case/output binding.');
    writeFileSync(path.join(output, `${caseId}.json`), JSON.stringify({
      caseId, platform: process.platform, executable, outcome, elapsedMs: elapsed, witness, spawned, lifecycle,
      childCloseObserved: true, standInOnly: true,
    }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    witnessWritten = true;
  } catch (error) {
    failure = { error };
  } finally {
    cleanup.children = owned.slice(first);
    try {
      process.chdir(oldCwd);
      cleanup.cwdRestored = process.cwd() === oldCwd;
      for (const key of envKeys) {
        const value = oldEnv.get(key);
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      // Only retained ChildProcess handles from this fixture; no PID scans/taskkill.
      const children = owned.splice(first);
      cleanup.phase = 'children'; cleanup.children = children;
      for (const record of children) if (!record.done) record.child.kill('SIGKILL');
      try { await bounded(Promise.all(children.map(record => record.closed)), 3_000); }
      catch (error) { cleanupFailure = { error: new Error(`Owned child cleanup failed; retained fixture at ${directory}`, { cause: error }) }; }
      if (!cleanupFailure) {
        cleanup.phase = 'remove'; cleanup.rmStarted = performance.now();
        try {
          rmSync(directory, { recursive: true, maxRetries: 3, retryDelay: 100 });
          cleanup.rmResult = 'returned';
        } catch (error) { cleanup.rmResult = 'threw'; throw error; }
        finally { cleanup.rmEnded = performance.now(); }
      }
    } catch (error) { cleanupFailure = { error }; }
    // Observation only: no witness rewrite, extra file, wait, spawn or cleanup attempt.
    try {
      const targets = [['root', directory], ['work', work], ['executable', executable],
        ['entry', path.join(work, 'agentapi')], ['package', path.join(work, 'package.json')], ['witness', witnessPath]] as const;
      const short = (value: unknown) => typeof value === 'string' ? value.slice(0, 32) : null;
      const errorFields = (error: unknown) => {
        const value = (error && typeof error === 'object' ? error : {}) as Partial<NodeJS.ErrnoException>;
        return { code: short(value.code), errno: typeof value.errno === 'number' ? value.errno : null,
          syscall: short(value.syscall), target: targets.find(([, target]) => target === value.path)?.[0] ?? 'unknown' };
      };
      const relativeMs = (time: number | null) => time === null ? null : Math.round((time - observationStart) * 1000) / 1000;
      const remaining = cleanupFailure ? targets.map(([target, file]) => {
        try {
          const stat = lstatSync(file);
          return { target, kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', mode: stat.mode, code: null };
        } catch (error) { return { target, kind: null, mode: null, code: errorFields(error).code }; }
      }) : [];
      const lifetime = {
        schemaVersion: '1.0.0', caseId: lifetimeCaseId, capturedAfterCleanup: true, holder: 'UNKNOWN', sourceFixed: false,
        worker: { pid: process.pid, parentPid: process.ppid }, witnessWritten, bodyFailed: failure !== null,
        cwdRestored: cleanup.cwdRestored, phase: cleanup.phase,
        childrenOverflow: cleanup.children.length > 2,
        children: cleanup.children.slice(0, 2).map(record => ({ pid: record.child.pid ?? null,
          requestedMs: relativeMs(record.requestedAt), spawnMs: relativeMs(record.spawnAt),
          exitMs: relativeMs(record.exitAt), closeMs: relativeMs(record.closeAt), done: record.done,
          killed: record.child.killed, exitCode: record.child.exitCode, signalCode: record.child.signalCode })),
        rm: { startedMs: relativeMs(cleanup.rmStarted), endedMs: relativeMs(cleanup.rmEnded), result: cleanup.rmResult },
        failure: cleanupFailure ? errorFields(cleanupFailure.error) : null, remaining,
      };
      const json = JSON.stringify(lifetime);
      // <= 2048 payload bytes per case: all 11 marker lines remain below 32 KiB.
      const boundedJson = Buffer.byteLength(json, 'utf8') <= 2048 ? json
        : JSON.stringify({ schemaVersion: '1.0.0', caseId: lifetimeCaseId, holder: 'UNKNOWN', sourceFixed: false, observation: 'UNKNOWN_BUDGET' });
      console.error('__AGS_WARGV_LIFETIME__ ' + boundedJson);
    } catch { /* Missing/failed diagnostic output is UNKNOWN; preserve the original test failure. */ }
  }
  if (cleanupFailure) {
    if (failure) throw new AggregateError([failure.error, cleanupFailure.error], 'Windows argv body and cleanup both failed.', { cause: failure.error });
    throw cleanupFailure.error;
  }
  if (failure) throw failure.error;
  return { outcome: outcome!, elapsed: elapsed!, witness: witness!, spawned: spawned!, lifecycle: lifecycle! };
}

// Independently written literal corpus, not values computed by the product/parser.
it('WARGV-001 ascii', async () => {
  const result = await fixture('ok', 'session-123', 'hello');
  expect(result.outcome).toBe('submitted');
  expect(result.witness.map(row => row.argv)).toEqual([
    ['get-conversation-metadata', 'session-123'], ['send-message', 'session-123', 'hello'],
  ]);
  expect(result.witness.map(row => [row.project, row.sourceMetadataPresent])).toEqual([
    ['source-project', true], ['source-project', true],
  ]);
  expect(result.spawned).toEqual([true, true]);
});

it('WARGV-002 whitespace unicode', async () => {
  const result = await fixture('ok', '세션 이름', '한글 😀\t둘\r\n끝');
  expect(result.outcome).toBe('submitted');
  expect(result.witness.map(row => row.argv)).toEqual([
    ['get-conversation-metadata', '세션 이름'], ['send-message', '세션 이름', '한글 😀\t둘\r\n끝'],
  ]);
});

it('WARGV-003 quotes trailing backslash', async () => {
  const result = await fixture('ok', 'session "quoted"', 'a\\"b "double" tail\\');
  expect(result.outcome).toBe('submitted');
  expect(result.witness.map(row => row.argv)).toEqual([
    ['get-conversation-metadata', 'session "quoted"'], ['send-message', 'session "quoted"', 'a\\"b "double" tail\\'],
  ]);
});

it('WARGV-004 empty arguments', async () => {
  const result = await fixture('ok', '', '');
  expect(result.outcome).toBe('submitted');
  expect(result.witness.map(row => row.argv)).toEqual([
    ['get-conversation-metadata', ''], ['send-message', '', ''],
  ]);
});

it('WARGV-005 shell separators remain literal', async () => {
  const result = await fixture('ok', 'sid&|<>^', '& | < > ^ %AGS_ARGV_TOKEN% !AGS_ARGV_TOKEN! ; $(whoami) `echo`');
  expect(result.outcome).toBe('submitted');
  expect(result.witness.map(row => row.argv)).toEqual([
    ['get-conversation-metadata', 'sid&|<>^'],
    ['send-message', 'sid&|<>^', '& | < > ^ %AGS_ARGV_TOKEN% !AGS_ARGV_TOKEN! ; $(whoami) `echo`'],
  ]);
});

it('WARGV-006 invalid metadata does not send', async () => {
  const result = await fixture('invalid-json', 'synthetic-session', 'not sent');
  expect(result.outcome).toBe('definite-failure');
  expect(result.witness.map(row => row.argv)).toEqual([['get-conversation-metadata', 'synthetic-session']]);
  expect(result.spawned).toEqual([true]);
});

it('WARGV-007 metadata nonzero does not send', async () => {
  const result = await fixture('metadata-error', 'synthetic-session', 'not sent');
  expect(result.outcome).toBe('definite-failure');
  expect(result.witness.map(row => row.argv)).toEqual([['get-conversation-metadata', 'synthetic-session']]);
  expect(result.spawned).toEqual([true]);
});

it('WARGV-008 missing executable is definite before spawn', async () => {
  const result = await fixture('missing-exe', 'synthetic-session', 'not sent');
  expect(result.outcome).toBe('definite-failure');
  expect(result.witness).toEqual([]);
  expect(result.spawned).toEqual([false]);
});

it('WARGV-009 send nonzero after spawn is unknown', async () => {
  const result = await fixture('send-error', 'synthetic-session', 'synthetic-message');
  expect(result.outcome).toBe('accepted-or-unknown');
  expect(result.witness.map(row => row.argv)).toEqual([
    ['get-conversation-metadata', 'synthetic-session'], ['send-message', 'synthetic-session', 'synthetic-message'],
  ]);
  expect(result.spawned).toEqual([true, true]);
  expect(result.lifecycle[1]).toMatchObject({ killed: false, exitCode: 29 });
});

it('WARGV-010 send timeout after spawn is unknown and reaped', async () => {
  const result = await fixture('send-timeout', 'synthetic-session', 'synthetic-message');
  expect(result.outcome).toBe('accepted-or-unknown');
  expect(result.witness.map(row => row.argv)).toEqual([
    ['get-conversation-metadata', 'synthetic-session'], ['send-message', 'synthetic-session', 'synthetic-message'],
  ]);
  expect(result.spawned).toEqual([true, true]);
  expect(result.lifecycle[1]?.killed).toBe(true);
  expect(result.lifecycle[1]?.exitCode === 0 && result.lifecycle[1]?.signalCode === null).toBe(false);
  expect(result.elapsed).toBeGreaterThanOrEqual(9_000);
  expect(result.elapsed).toBeLessThan(16_000);
}, 25_000);

it('WARGV-011 NUL rejected before send spawn', async () => {
  const result = await fixture('ok', 'synthetic-session', 'invalid\0message');
  expect(result.outcome).toBe('definite-failure');
  expect(result.witness.map(row => row.argv)).toEqual([['get-conversation-metadata', 'synthetic-session']]);
  expect(result.spawned).toEqual([true]);
});
