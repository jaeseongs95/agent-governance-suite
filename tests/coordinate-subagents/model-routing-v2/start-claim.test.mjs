import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ModelRoutingStore } from '../../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { digest, seal } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { fixture, NOW } from './fixtures.mjs';

function setup(file = ':memory:') {
  const database = new DatabaseSync(file), store = new ModelRoutingStore(database), { decision } = fixture();
  onTestFinished(() => database.close());
  const { dispatchKey: key } = store.reserveDispatch(decision, { write: true }); store.transition(key, 0, 'accepted');
  return { database, store, decision, key, claim: (fn = () => NOW) => store.claimExecutionStart(key, 1, decision.decisionDigest, fn) };
}
function temporaryDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'AGS start 경합 '));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return join(dir, 'state.sqlite3');
}
function contender(file, key, decisionDigest, mode = 'reply') {
  const child = fork(new URL('./fixtures/start-claim-process.mjs', import.meta.url), [file, key, decisionDigest, NOW, mode],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '', readyDone = false, resultDone = false;
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => { if (message.type === 'ready') { readyDone = true; resolve(); } });
    child.once('error', reject);
    child.once('exit', () => { if (!readyDone) reject(new Error(`Contender exited before ready: ${stderr}`)); });
  });
  const result = new Promise((resolve, reject) => {
    child.on('message', message => { if (message.type === 'result') { resultDone = true; resolve(message); } });
    child.once('error', reject);
    child.once('exit', () => { if (!resultDone) reject(new Error(`Contender exited without result: ${stderr}`)); });
  });
  // Attach handlers immediately: unexpected early process exits must not become unhandled rejections.
  void ready.catch(() => {}); void result.catch(() => {});
  const closed = new Promise(resolve => child.once('close', resolve));
  onTestFinished(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  return { child, ready, result, closed };
}

describe('routing store atomic one-use execution claim', () => {
  it('changes only accepted state, revision and the first dispatch timestamp', () => {
    const h = setup(), before = h.store.dispatch(h.key);
    expect(h.claim()).toEqual({ dispatchKey: h.key, state: 'running', revision: 2, dispatchedAt: NOW, startClaimAcquired: true });
    expect(h.store.dispatch(h.key)).toEqual({ ...before, state: 'running', revision: 2, dispatched_at: NOW });
    expect(h.database.isTransaction).toBe(false);
    expect(() => h.claim()).toThrow(/DISPATCH_REVISION_CONFLICT/u);
    expect(() => h.store.claimExecutionStart(h.key, 2, h.decision.decisionDigest, () => NOW)).toThrow(/DISPATCH_START_UNAVAILABLE/u);
  });
  it.each(['reserved', 'running', 'unknown', 'succeeded', 'failed', 'cancelled', 'not-started'])('does not start %s or call the validator', state => {
    const h = setup(); h.database.prepare('UPDATE ags_model_dispatches_v2 SET state=? WHERE dispatch_key=?').run(state, h.key);
    const before = h.store.dispatch(h.key), validate = vi.fn(() => NOW);
    expect(() => h.claim(validate)).toThrow(/DISPATCH_START_UNAVAILABLE/u); expect(validate).not.toHaveBeenCalled();
    expect(h.store.dispatch(h.key)).toEqual(before);
  });
  it('does not reset an already recorded dispatched_at even if the row says accepted', () => {
    const h = setup(); h.database.prepare('UPDATE ags_model_dispatches_v2 SET dispatched_at=? WHERE dispatch_key=?').run(NOW, h.key);
    const before = h.store.dispatch(h.key); expect(() => h.claim()).toThrow(/DISPATCH_START_UNAVAILABLE/u);
    expect(h.store.dispatch(h.key)).toEqual(before);
  });
  it('requires the exact dispatch, decision digest and revision', () => {
    const h = setup(), validate = vi.fn(() => NOW), before = h.store.dispatch(h.key);
    for (const [key, revision, decisionDigest] of [[digest('other'), 1, h.decision.decisionDigest], [h.key, 2, h.decision.decisionDigest],
      [h.key, 1, digest('wrong-decision')]]) expect(() => h.store.claimExecutionStart(key, revision, decisionDigest, validate)).toThrow();
    expect(validate).not.toHaveBeenCalled(); expect(h.store.dispatch(h.key)).toEqual(before);
  });
  it('requires a local synchronous revalidator rather than an approval boolean', () => {
    const h = setup(), before = h.store.dispatch(h.key);
    for (const value of [undefined, null, true, NOW]) expect(() => h.store.claimExecutionStart(h.key, 1, h.decision.decisionDigest, value)).toThrow(/START_REVALIDATION_REQUIRED/u);
    expect(h.store.dispatch(h.key)).toEqual(before);
  });
  it.each([() => true, () => undefined, () => Promise.resolve(NOW), () => 'invalid-time'])('rolls back when the callback returns an invalid or asynchronous timestamp', callback => {
    const h = setup(), before = h.store.dispatch(h.key); expect(() => h.claim(callback)).toThrow();
    expect(h.store.dispatch(h.key)).toEqual(before); expect(h.database.isTransaction).toBe(false);
  });
  it('rolls back a final governance rejection without spending the claim', () => {
    const h = setup(), before = h.store.dispatch(h.key);
    expect(() => h.claim(() => { throw new Error('approval unavailable'); })).toThrow(/approval unavailable/u);
    expect(h.store.dispatch(h.key)).toEqual(before); expect(h.claim().startClaimAcquired).toBe(true);
  });
  it('rejects and rolls back same-connection changes inside the supposedly read-only callback', () => {
    const h = setup(), before = h.store.dispatch(h.key);
    expect(() => h.claim(() => { h.database.prepare("UPDATE ags_model_dispatches_v2 SET write_key=NULL WHERE dispatch_key=?").run(h.key); return NOW; })).toThrow(/DISPATCH_START_CONFLICT/u);
    expect(h.store.dispatch(h.key)).toEqual(before);
  });
  it('a busy writer rejects rather than clearing or retrying another connection', () => {
    const file = temporaryDatabase(), h = setup(file), other = new DatabaseSync(file);
    try {
      other.exec('BEGIN IMMEDIATE'); const validate = vi.fn(() => NOW);
      expect(() => h.claim(validate)).toThrow(/locked|busy/u); expect(validate).not.toHaveBeenCalled();
      other.prepare("UPDATE ags_model_dispatches_v2 SET state='unknown',revision=2 WHERE dispatch_key=?").run(h.key); other.exec('COMMIT');
      expect(h.store.dispatch(h.key)).toMatchObject({ state: 'unknown', revision: 2, dispatched_at: null });
      expect(() => h.claim()).toThrow();
    } finally { other.close(); }
  });
  it('uses the existing dispatch table and preserves schema version and unrelated rows', () => {
    const h = setup(); h.database.exec("PRAGMA user_version=24; CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('original');");
    const before = h.database.prepare("SELECT sql FROM sqlite_master ORDER BY type,name").all(); h.claim();
    expect(h.database.prepare("SELECT sql FROM sqlite_master ORDER BY type,name").all()).toEqual(before);
    expect(h.database.prepare('PRAGMA user_version').get().user_version).toBe(24);
    expect(h.database.prepare('SELECT value FROM unrelated').get().value).toBe('original');
  });
  it('does not conflate distinct read assignments with the same one-use claim', () => {
    const h = setup(), a = seal({ ...h.decision, binding: { ...h.decision.binding, assignmentId: 'read-a' } }, 'decisionDigest');
    const b = seal({ ...h.decision, binding: { ...h.decision.binding, assignmentId: 'read-b' } }, 'decisionDigest');
    for (const decision of [a, b]) {
      const { dispatchKey } = h.store.reserveDispatch(decision); h.store.transition(dispatchKey, 0, 'accepted');
      expect(h.store.claimExecutionStart(dispatchKey, 1, decision.decisionDigest, () => NOW).startClaimAcquired).toBe(true);
    }
  });
  it.each([1, 2, 3])('exactly one real process wins a simultaneous start race (round %s)', async () => {
    const file = temporaryDatabase(), h = setup(file);
    const a = contender(file, h.key, h.decision.decisionDigest), b = contender(file, h.key, h.decision.decisionDigest);
    await Promise.all([a.ready, b.ready]); a.child.send('go'); b.child.send('go');
    const results = await Promise.all([a.result, b.result]); await Promise.all([a.closed, b.closed]);
    expect(results.filter(result => result.acquired)).toHaveLength(1);
    expect(results.reduce((sum, result) => sum + result.validations, 0)).toBe(1);
    expect(h.store.dispatch(h.key)).toMatchObject({ state: 'running', revision: 2, dispatched_at: NOW });
  });
  it('a committed claim remains spent when its process loses the result', async () => {
    const file = temporaryDatabase(), h = setup(file), a = contender(file, h.key, h.decision.decisionDigest, 'drop-result');
    await a.ready; a.child.send('go'); await expect(a.result).rejects.toThrow(/without result/u); await a.closed;
    expect(h.store.dispatch(h.key)).toMatchObject({ state: 'running', revision: 2, dispatched_at: NOW });
    expect(() => h.claim()).toThrow(/DISPATCH_REVISION_CONFLICT/u);
  });
});
