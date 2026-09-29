// Trust-DB write contention vs reconcile read-only verification. node --import tsx probe-contention.mjs <K targets> <R reconcilers> <W writers> <seed>
import { fork } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { randomBytes } from 'node:crypto';
const [role] = process.argv.slice(2);
const imp = p => import(`/tmp/e9/mcp-server/src/${p}`);
const obsFor = (target, n) => ({ ...target, kind: 'user-input', wakeOnly: true, wakeCandidates: [n], actor: { kind: 'unknown', assurance: 'unknown', observedBy: `${target.host}:hook-payload` } });
if (role === 'writer' || role === 'reconciler') {
  const wakePort = await imp('session-message-wake-port.ts');
  const { SessionMessageStore } = await imp('session-message-store.ts');
  const { dispatchSessionMessageBrokerOperation: dispatch } = await imp('session-message-broker.ts');
  process.on('message', async cfg => {
    process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = cfg.trustPath;
    const until = Date.now() + cfg.ms; let n = 0; const results = []; const errors = [];
    if (role === 'writer') {
      while (Date.now() < until) { try { wakePort.recordWakeHookObservation(obsFor({ host: 'portable', sessionId: `noise-${n % 7}` }, randomBytes(18).toString('base64url'))); n++; } catch (e) { errors.push(e.message); } }
      process.send({ n, errors: [...new Set(errors)].slice(0, 5), errorCount: errors.length });
    } else {
      const store = new SessionMessageStore(cfg.database);
      for (const t of cfg.items) {
        const t0 = process.hrtime.bigint();
        try { const r = dispatch(store, 'reconcile-wake-observation', { target: t.target, attemptId: t.attemptId, sourceReceiptId: t.sourceReceiptId }); results.push({ sid: t.target.sessionId, ok: r.reconciled, us: Number(process.hrtime.bigint() - t0) / 1000 }); }
        catch (e) { results.push({ sid: t.target.sessionId, error: e.message }); }
      }
      store.close(); process.send({ results });
    }
    process.exit(0);
  });
} else {
  const [K, R, W, seed] = process.argv.slice(2).map(Number);
  const { SessionMessageStore } = await imp('session-message-store.ts');
  const wakePort = await imp('session-message-wake-port.ts');
  const { dispatchSessionMessageBrokerOperation: dispatch } = await imp('session-message-broker.ts');
  const dir = mkdtempSync(join(tmpdir(), 'contend-')); const database = join(dir, 'm.sqlite3'); const trustPath = join(dir, 'trust.sqlite3');
  process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = trustPath;
  const store = new SessionMessageStore(database); const T0 = Date.now() - 120_000; const items = [];
  const pres = (target, i) => ({ ...target, instanceId: i, transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } });
  for (let k = 0; k < K; k++) {
    const target = { host: 'portable', sessionId: `ct-${k}` };
    store.startPresence(pres(target, 'inst-1'), T0); store.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-1', pid: 1, parentPid: 1 }, T0);
    store.send({ sender: { host: 'portable', sessionId: 'sender' }, target, messageId: `contend-${k}`, body: 'b' }, T0);
    const nonce = randomBytes(18).toString('base64url');
    const a = store.startManagedWake(store.reserveManagedWake({ ...target, instanceId: 'inst-1', transport: 'portable', relayId: 'relay-1', nonce }, T0).attempt, T0 + 1).attempt;
    store.recordManagedWakeOutcome(a, 'accepted-or-unknown', T0 + 2); store.startPresence(pres(target, 'inst-2'), T0 + 5);
    const rid = wakePort.recordWakeHookObservation(obsFor(target, nonce), T0 + 10);
    store.database.prepare("UPDATE wake_nonces SET late_observed_at = ? WHERE nonce = ?").run(new Date(T0 + 11).toISOString(), nonce);
    items.push({ target, attemptId: a.attemptId, sourceReceiptId: rid });
  }
  store.close();
  const spawnRole = r => fork(new URL(import.meta.url), [r], { cwd: '/tmp/e9', execArgv: ['--import', 'tsx'] });
  const writers = Array.from({ length: W }, () => spawnRole('writer'));
  const recs = Array.from({ length: R }, () => spawnRole('reconciler'));
  const wDone = writers.map(c => new Promise(r => c.once('message', r)));
  const rDone = recs.map(c => new Promise(r => c.once('message', r)));
  writers.forEach(c => c.send({ trustPath, ms: 8000 }));
  await new Promise(r => setTimeout(r, 1500));
  recs.forEach((c, i) => c.send({ trustPath, database, items: items.filter((_, k) => k % R === i) }));
  const rr = (await Promise.all(rDone)).flatMap(m => m.results); const ww = await Promise.all(wDone);
  const first = { ok: rr.filter(x => x.ok === true).length, rejected: rr.filter(x => x.ok === false).length, errors: rr.filter(x => x.error).map(x => x.error) };
  // second pass without contention: rejected rows that succeed now were spurious rejections
  const s2 = new SessionMessageStore(database); const retry = [];
  for (const it of items) { const r = dispatch(s2, 'reconcile-wake-observation', it); if (r.reconciled) retry.push(it.target.sessionId); }
  const states = s2.database.prepare('SELECT state, count(*) n FROM wake_nonces GROUP BY state').all(); s2.close();
  const us = rr.filter(x => x.us).map(x => x.us).sort((a, b) => a - b);
  console.log(JSON.stringify({ K, R, W, seed, first, writerReceipts: ww.map(w => w.n), writerErrors: ww.flatMap(w => w.errors), spuriousRejectedThenOk: retry.length, spuriousSample: retry.slice(0, 5), states,
    reconcileMicros: { p50: us[Math.floor(us.length / 2)], p99: us[Math.floor(us.length * 0.99)], max: us.at(-1) }, trustFiles: readdirSync(dir).filter(n => n.startsWith('trust')) }));
}
