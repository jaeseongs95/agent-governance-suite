// Cross-process presence generation change while reconcile holds BEGIN IMMEDIATE (inside verify). Also sidecar observation for (i).
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, readFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { randomBytes, createHash } from 'node:crypto';
const dir = mkdtempSync(join(tmpdir(), 'midgen-')); const database = join(dir, 'm.sqlite3'); const trustPath = join(dir, 'trust.sqlite3');
process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = trustPath;
const { SessionMessageStore } = await import('/tmp/e9/mcp-server/src/session-message-store.ts');
const wakePort = await import('/tmp/e9/mcp-server/src/session-message-wake-port.ts');
const target = { host: 'portable', sessionId: 'mid-target' };
const pres = i => ({ ...target, instanceId: i, transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } });
const files = () => Object.fromEntries(readdirSync(dir).filter(n => n.startsWith('trust')).map(n => [n, { size: statSync(join(dir, n)).size, sha: createHash('sha256').update(readFileSync(join(dir, n))).digest('hex').slice(0, 16) }]));
for (const variant of ['to-current-instance-1-restart', 'to-new-instance-3']) {
  const s = new SessionMessageStore(database); const T0 = Date.now() - 120_000; const sid = `${variant}`;
  const tg = { host: 'portable', sessionId: sid }; const p = i => ({ ...pres(i), sessionId: sid });
  s.startPresence(p('inst-1'), T0); s.acquireRelay({ ...tg, transport: 'portable', relayId: 'relay-1', pid: 1, parentPid: 1 }, T0);
  s.send({ sender: { host: 'portable', sessionId: 'sender' }, target: tg, messageId: `mid-${variant}`, body: 'b' }, T0);
  const nonce = randomBytes(18).toString('base64url');
  const a = s.startManagedWake(s.reserveManagedWake({ ...tg, instanceId: 'inst-1', transport: 'portable', relayId: 'relay-1', nonce }, T0).attempt, T0 + 1).attempt;
  s.recordManagedWakeOutcome(a, 'accepted-or-unknown', T0 + 2); s.startPresence(p('inst-2'), T0 + 5);
  const rid = wakePort.recordWakeHookObservation({ ...tg, kind: 'user-input', wakeOnly: true, wakeCandidates: [nonce], actor: { kind: 'unknown', assurance: 'unknown', observedBy: 'portable:hook-payload' } }, T0 + 10);
  s.database.prepare("UPDATE wake_nonces SET late_observed_at = ? WHERE nonce = ?").run(new Date(T0 + 11).toISOString(), nonce);
  const beforeFiles = files();
  const events = [];
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const { SessionMessageStore } = await import('/tmp/e9/mcp-server/src/session-message-store.ts');
      const s = new SessionMessageStore(${JSON.stringify(database)}); console.log('ready');
      process.stdin.once('data', () => { const t0 = Date.now();
        const r = s.startPresence(${JSON.stringify(p(variant === 'to-new-instance-3' ? 'inst-3' : 'inst-1'))});
        console.log(JSON.stringify({ childStartedAt: t0, childCommittedAt: Date.now(), instanceId: r.instanceId, startedAt: r.startedAt })); s.close(); process.exit(0); });`],
    { cwd: '/tmp/e9', stdio: ['pipe', 'pipe', 'inherit'] });
  let out = ''; const ready = new Promise(r => child.stdout.on('data', d => { out += d; if (out.includes('ready')) r(); }));
  const childDone = new Promise(r => child.on('exit', () => r(out.replace('ready', ''))));
  await ready;
  const verify = (...args) => {
    const proof = wakePort.verifyHistoricalWakeObservation(...args);
    child.stdin.write('go\n'); events.push({ signalledAt: Date.now() });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); // hold the message-DB write lock while the child tries to change generation
    events.push({ verifyReturnAt: Date.now() }); return proof;
  };
  const r = s.reconcileHistoricalWake(tg, a.attemptId, rid, Date.now(), verify); events.push({ reconcileReturnedAt: Date.now(), reconciled: r.reconciled });
  const childOut = JSON.parse((await childDone).trim());
  console.log(JSON.stringify({ variant, events, child: childOut, childBlockedUntilCommit: childOut.childStartedAt < events[1].verifyReturnAt && childOut.childCommittedAt >= events[1].verifyReturnAt,
    row: s.database.prepare('SELECT state, observed_at, consumed_at FROM wake_nonces WHERE nonce = ?').get(nonce), second: s.reconcileHistoricalWake(tg, a.attemptId, rid).reconciled,
    trustFilesBefore: beforeFiles, trustFilesAfter: files() }));
  s.close();
}
