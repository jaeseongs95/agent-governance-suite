// Fuzz worker: persistent process; one run per 'run' message. ROOT env selects implementation (e9 or v53).
import { appendFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.FUZZ_ROOT;
const IMPL = process.env.FUZZ_IMPL; // 'e9' | 'v53'
const imp = p => import(pathToFileURL(`${ROOT}/mcp-server/src/${p}`).href);
const { SessionMessageStore } = await imp('session-message-store.ts');
const { dispatchSessionMessageBrokerOperation: dispatch } = await imp('session-message-broker.ts');
const wakePort = await imp('session-message-wake-port.ts');
const { TrustStore } = await imp('trust-store.ts');

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const obsFor = (target, nonces) => ({ host: target.host, sessionId: target.sessionId, kind: 'user-input', wakeOnly: true,
  wakeCandidates: nonces, actor: { kind: 'unknown', assurance: 'unknown', observedBy: `${target.host}:hook-payload` } });
const presenceInput = (target, instanceId) => ({ ...target, instanceId, transport: 'portable', wakeVisibility: 'silent',
  canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } });

process.send({ type: 'ready', pid: process.pid });
let go = null;
process.on('message', async msg => {
  if (msg.type === 'go') { go?.(); return; }
  if (msg.type === 'exit') process.exit(0);
  if (msg.type !== 'run') return;
  const cfg = msg.cfg; const w = msg.worker;
  process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = cfg.trustPath;
  const log = []; let store;
  try {
    store = new SessionMessageStore(cfg.database);
    const reader = wakePort.createWakeHookObservationReader(cfg.trustPath);
    const rnd = mulberry32(cfg.seed * 1009 + w * 7919 + cfg.n * 131);
    const pick = a => a[Math.floor(rnd() * a.length)];
    const myAttempts = []; const pendingOutcomes = [];
    const weights = cfg.ops; // [[name, weight]]
    const total = weights.reduce((s, [, x]) => s + x, 0);
    const chooseOp = () => { let r = rnd() * total; for (const [name, x] of weights) { if ((r -= x) < 0) return name; } return weights[0][0]; };
    process.send({ type: 'armed' });
    await new Promise(r => { go = r; });
    for (let i = 0; i < cfg.opsPerWorker; i++) {
      const t = pick(cfg.targets); const target = t.target; const op = chooseOp();
      const entry = { w, i, op, sid: target.sessionId, t0: Date.now() };
      try {
        switch (op) {
          case 'reconcile': {
            if (IMPL !== 'e9') { entry.skipped = true; break; }
            const p = { target, attemptId: t.attempt.attemptId, sourceReceiptId: t.sourceReceiptId };
            entry.payload = p;
            if (process.env.FUZZ_MUTANT === 'verify-bypass') entry.result = store.reconcileHistoricalWake(p.target, p.attemptId, p.sourceReceiptId, Date.now(),
              () => ({ sourceReceiptId: p.sourceReceiptId, contentDigest: 'sha256:mutant', observedAt: t.startedAt, receiptExpiresAt: t.startedAt }));
            else entry.result = dispatch(store, 'reconcile-wake-observation', p);
            break;
          }
          case 'reconcile-bad': {
            if (IMPL !== 'e9') { entry.skipped = true; break; }
            const other = pick(cfg.targets); const kind = pick(['swap-receipt', 'swap-attempt', 'swap-target', 'missing-receipt']);
            const p = { target, attemptId: t.attempt.attemptId, sourceReceiptId: t.sourceReceiptId };
            if (kind === 'swap-receipt') p.sourceReceiptId = other.sourceReceiptId;
            if (kind === 'swap-attempt') p.attemptId = other.attempt.attemptId;
            if (kind === 'swap-target') p.target = other.target;
            if (kind === 'missing-receipt') p.sourceReceiptId = `source-${randomBytes(8).toString('hex')}`;
            entry.kind = kind; entry.payload = p; entry.same = other.target.sessionId === target.sessionId;
            entry.result = dispatch(store, 'reconcile-wake-observation', p); break;
          }
          case 'gen-change': {
            const inst = `inst-w${w}-${i}`; const p = store.startPresence(presenceInput(target, inst));
            entry.instanceId = inst; entry.generation = p.startedAt; break;
          }
          case 'end-presence': {
            const p = store.presence(target); if (p.instanceId) entry.result = store.endPresence(target, 'fuzz-end', p.instanceId); break;
          }
          case 'relay-cycle': {
            const p = store.presence(target);
            if (!p.instanceId) { entry.noop = 'no-presence'; break; }
            // keep current presence alive (may refresh an expired lease => new birth generation)
            store.startPresence(presenceInput(target, p.instanceId));
            const relayId = `relay-w${w}`;
            entry.acquired = store.acquireRelay({ ...target, transport: 'portable', relayId, pid: process.pid, parentPid: process.pid });
            const nonce = randomBytes(18).toString('base64url');
            const cur = store.presence(target);
            const reserved = store.reserveManagedWake({ ...target, instanceId: cur.instanceId, transport: 'portable', relayId, nonce, resume: rnd() < 0.3 });
            entry.reserved = reserved.dispatch; if (!reserved.dispatch) break;
            entry.attemptId = reserved.attempt.attemptId; entry.nonce = reserved.attempt.nonce;
            if (rnd() < 0.3) await sleep(Math.floor(rnd() * 3));
            const started = store.startManagedWake(reserved.attempt);
            entry.started = started.dispatch; if (!started.dispatch) break;
            const a = started.attempt; myAttempts.push(a);
            appendFileSync(cfg.effects, JSON.stringify({ w, pid: process.pid, i, sid: target.sessionId, nonce: a.nonce, attemptId: a.attemptId,
              epoch: a.dispatchEpoch, instanceId: a.instanceId, generation: a.generation, at: Date.now() }) + '\n');
            if (process.env.FUZZ_MUTANT === 'double-effect') appendFileSync(cfg.effects, JSON.stringify({ w, pid: process.pid, i, sid: target.sessionId, nonce: a.nonce, attemptId: a.attemptId, epoch: a.dispatchEpoch, mutant: true }) + '\n');
            const outcome = pick(['submitted', 'submitted', 'accepted-or-unknown', 'accepted-or-unknown', 'accepted-or-unknown', 'definite-failure']); entry.outcome = outcome;
            if (rnd() < 0.4) { pendingOutcomes.push({ a, outcome }); entry.deferred = true; }
            else entry.recorded = store.recordManagedWakeOutcome(a, outcome);
            break;
          }
          case 'hook-current': {
            const row = store.database.prepare(`SELECT nonce, attempt_id, state FROM wake_nonces WHERE host = ? AND session_id = ?
              AND state IN ('started','submitted','unknown') AND nonce IS NOT NULL AND attempt_id <> ?`).get(target.host, target.sessionId, t.attempt.attemptId);
            const nonce = row?.nonce ?? (myAttempts.length ? pick(myAttempts).nonce : null);
            if (!nonce) { entry.noop = 'no-nonce'; break; }
            const obs = obsFor(target, [nonce]); const rid = wakePort.recordWakeHookObservation(obs);
            entry.nonce = nonce; entry.receiptId = rid;
            const r = store.claimHostWake(target, obs, rid, reader);
            entry.result = { recognized: r.recognized, messages: r.messages.length, binding: r.binding?.attemptId ?? null }; break;
          }
          case 'hook-old': {
            const obs = obsFor(target, [t.attempt.nonce]); const rid = wakePort.recordWakeHookObservation(obs);
            entry.nonce = t.attempt.nonce; entry.receiptId = rid;
            const r = store.claimHostWake(target, obs, rid, reader);
            entry.result = { recognized: r.recognized, messages: r.messages.length, binding: r.binding?.attemptId ?? null }; break;
          }
          case 'late-outcome-old': {
            const outcome = pick(['submitted', 'definite-failure', 'accepted-or-unknown']);
            entry.outcome = outcome; entry.attemptId = t.attempt.attemptId;
            entry.result = store.recordManagedWakeOutcome(t.attempt, outcome); break;
          }
          case 'late-outcome-mine': {
            const x = pendingOutcomes.length ? pendingOutcomes.shift() : myAttempts.length ? { a: pick(myAttempts), outcome: pick(['submitted', 'definite-failure', 'accepted-or-unknown']) } : null;
            if (!x) { entry.noop = 'none'; break; }
            entry.attemptId = x.a.attemptId; entry.epoch = x.a.dispatchEpoch; entry.outcome = x.outcome;
            entry.result = store.recordManagedWakeOutcome(x.a, x.outcome); break;
          }
          case 'send': {
            entry.result = store.send({ sender: { host: 'portable', sessionId: `sender-w${w}` }, target, messageId: `msg-${cfg.seed}-${w}-${i}`, body: 'fuzz body' }).messageId; break;
          }
          case 'read-only': {
            if (IMPL === 'e9') {
              const r = TrustStore.readVerifiedInputSource(cfg.trustPath, t.sourceReceiptId);
              const v = wakePort.verifyHistoricalWakeObservation(target, t.attempt.nonce, t.sourceReceiptId, t.startedAt, t.lateAt ?? t.startedAt, Date.now(), cfg.trustPath);
              entry.result = { receipt: Boolean(r), verified: Boolean(v) };
            }
            entry.status = store.managedWakeStatus(target)?.state ?? null; break;
          }
          default: entry.noop = 'unknown-op';
        }
      } catch (error) { entry.error = String(error?.message ?? error); entry.code = error?.code ?? error?.errcode ?? null; }
      entry.t1 = Date.now(); log.push(entry);
      if (rnd() < 0.5) await sleep(Math.floor(rnd() * 3)); else await new Promise(r => setImmediate(r));
    }
    for (const x of pendingOutcomes) {
      const entry = { w, i: 'flush', op: 'late-outcome-mine', attemptId: x.a.attemptId, epoch: x.a.dispatchEpoch, outcome: x.outcome, t0: Date.now() };
      try { entry.result = store.recordManagedWakeOutcome(x.a, x.outcome); } catch (error) { entry.error = String(error?.message ?? error); }
      log.push(entry);
    }
  } catch (error) { log.push({ w, fatal: String(error?.stack ?? error) }); }
  finally { try { store?.close(); } catch { /* */ } }
  process.send({ type: 'done', log });
});
