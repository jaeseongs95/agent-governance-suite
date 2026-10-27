import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { waitForSessionMessageBrokerReady } from '../../mcp-server/src/session-message-client.js';
import { producerFailureReason } from '../../mcp-server/src/failure-diagnostics.js';

const dirs: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) { const done = once(c, 'close'); c.kill(); await done; }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});
async function capture(child: ChildProcess, state: string): Promise<Error> {
  try { await waitForSessionMessageBrokerReady(state, child, 7000, undefined, child.stdio[3] as import('node:stream').Readable); throw new Error('unexpected ready'); }
  catch (error) { return error as Error; }
}
it.each(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'ENOENT'])('real broker reports injected publish %s without private cause', async (code) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'd0298-publish-')); dirs.push(state);
  const broker = fileURLToPath(new URL('../../mcp-server/src/session-message-broker.ts', import.meta.url));
  const preload = fileURLToPath(new URL('./fixtures/d0298-publish-inject.cjs', import.meta.url));
  const child = spawn(process.execPath, ['--require', preload, '--import', 'tsx', broker, '--state-directory', state, '--startup-diagnostic'], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env: { ...process.env, AGS_TEST_PUBLISH_CODE: code },
  }); children.push(child);
  const error = await capture(child, state);
  expect(producerFailureReason(error)).toBe('BROKER_EXITED_BEFORE_READY');
  expect(error.message).toContain('startup diagnostic: BROKER_LOCK_PUBLISH_' + code);
  expect(error.message).not.toContain('PRIVATE_INJECTED_MARKER');
  expect(child.exitCode).toBe(1);
}, 15000);
it('rejects a forged publish suffix and private content', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'd0298-publish-')); dirs.push(state);
  const child = spawn(process.execPath, ['-e', "require('fs').writeSync(3,'BROKER_LOCK_PUBLISH_PRIVATE_INJECTED_MARKER\\n');process.exitCode=1"], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] }); children.push(child);
  const error = await capture(child, state);
  expect(producerFailureReason(error)).toBe('BROKER_EXITED_BEFORE_READY');
  expect(error.message).not.toContain('startup diagnostic:');
  expect(error.message).not.toContain('PRIVATE_INJECTED_MARKER');
});
