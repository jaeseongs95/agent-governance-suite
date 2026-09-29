// F1 probe: broker --state-directory R (no trust env) vs reconcile's verify default path. Run with cwd=/tmp/e9, node --import tsx.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
const R = mkdtempSync(join(tmpdir(), 'f1-state-')); const H = mkdtempSync(join(tmpdir(), 'f1-home-'));
process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = join(R, 'trust.sqlite3');
const { SessionMessageStore } = await import('/tmp/e9/mcp-server/src/session-message-store.ts');
const wakePort = await import('/tmp/e9/mcp-server/src/session-message-wake-port.ts');
const { resolveTrustDatabasePath } = await import('/tmp/e9/mcp-server/src/runtime-config.ts');
const { waitForSessionMessageBrokerReady } = await import('/tmp/e9/mcp-server/src/session-message-client.ts');
const target = { host: 'portable', sessionId: 'f1-target' };
const pres = i => ({ ...target, instanceId: i, transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } });
const store = new SessionMessageStore(join(R, 'session-messages.sqlite3'));
const T0 = Date.now() - 120_000;
store.startPresence(pres('inst-1'), T0);
store.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-1', pid: process.pid, parentPid: process.pid }, T0);
store.send({ sender: { host: 'portable', sessionId: 'sender' }, target, messageId: 'f1-message', body: 'b' }, T0);
const nonce = randomBytes(18).toString('base64url');
const a = store.startManagedWake(store.reserveManagedWake({ ...target, instanceId: 'inst-1', transport: 'portable', relayId: 'relay-1', nonce }, T0).attempt, T0 + 1).attempt;
store.recordManagedWakeOutcome(a, 'accepted-or-unknown', T0 + 2);
store.startPresence(pres('inst-2'), T0 + 5);
const obs = { ...target, kind: 'user-input', wakeOnly: true, wakeCandidates: [nonce], actor: { kind: 'unknown', assurance: 'unknown', observedBy: 'portable:hook-payload' } };
const rid = wakePort.recordWakeHookObservation(obs, T0 + 10); // written to R/trust.sqlite3 (the broker's own wake reader path)
store.database.prepare("UPDATE wake_nonces SET late_observed_at = ? WHERE state = 'unknown'").run(new Date(T0 + 11).toISOString());
store.close();
const brokerEnv = { PATH: process.env.PATH, HOME: H };
const defaultTrust = resolveTrustDatabasePath(brokerEnv, process.platform, H, '/tmp/e9');
console.log(JSON.stringify({ R, brokerWakeReaderPath: join(R, 'trust.sqlite3'), reconcileVerifyDefaultPath: defaultTrust }));
const install = join(R, 'install'); mkdirSync(install);
for (const n of ['session-message-broker.mjs', 'session-message-cli.mjs']) copyFileSync(`/tmp/e9/mcp-server/dist/${n}`, join(install, n));
const broker = spawn(process.execPath, [join(install, 'session-message-broker.mjs'), '--state-directory', R], { env: brokerEnv, cwd: install, stdio: 'ignore' });
const exited = once(broker, 'exit');
try {
  await waitForSessionMessageBrokerReady(R, broker, 8000);
  const run = () => { const o = spawnSync(process.execPath, [join(install, 'session-message-cli.mjs')], { env: { PATH: process.env.PATH, HOME: H, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: R }, cwd: install, encoding: 'utf8', timeout: 10000,
    input: JSON.stringify({ operation: 'reconcile-wake-observation', payload: { target, attemptId: a.attemptId, sourceReceiptId: rid } }) }); return { code: o.status, out: o.stdout.trim(), err: o.stderr.trim() }; };
  console.log('run1 (receipt only in R/trust.sqlite3):', JSON.stringify(run()));
  console.log('default trust exists after run1:', existsSync(defaultTrust), existsSync(dirname(defaultTrust)) ? readdirSync(dirname(defaultTrust)) : 'dir-missing');
  mkdirSync(dirname(defaultTrust), { recursive: true }); copyFileSync(join(R, 'trust.sqlite3'), defaultTrust);
  console.log('run2 (same trust db copied to default path):', JSON.stringify(run()));
} finally { broker.kill(); await exited; }
