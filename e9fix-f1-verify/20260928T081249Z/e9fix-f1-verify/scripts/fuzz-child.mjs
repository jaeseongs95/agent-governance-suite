// Fuzz child: seeded random sequence of reconcile (public CLI), generation change and reserve-wake (broker client).
// Usage: node --import tsx fuzz-child.mjs <R> <INST> <seedJson> <prngSeed> <startAtMs> <driverPid> <HOME>
import { spawn } from 'node:child_process';
const [R, INST, seedJson, prngSeed, startAt, driverPid, HOME] = process.argv.slice(2);
const S = JSON.parse(seedJson);
const { sessionMessageRequest } = await import('/tmp/fix/mcp-server/src/session-message-client.ts');
let a = Number(prngSeed) >>> 0; const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const cli = (payload) => new Promise((res) => {
  const c = spawn(process.execPath, [`${INST}/mcp-server/dist/session-message-cli.mjs`], { env: { PATH: process.env.PATH, HOME, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: R }, cwd: INST });
  let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; });
  c.on('close', (code) => { let v; try { const j = JSON.parse(o); v = j.ok === false ? `ERR:${j.error}` : j.data?.reconciled; } catch { v = `PARSE:${o.slice(0, 80)}`; } res({ code, v }); });
  c.stdin.end(JSON.stringify({ operation: 'reconcile-wake-observation', payload }));
});
const req = async (op, p) => { try { return await sessionMessageRequest(op, p, R); } catch (e) { return { error: e.message }; } };
while (Date.now() < Number(startAt)) await new Promise((r) => setTimeout(r, 2));
const log = [];
const n = 2 + Math.floor(rnd() * 4);
for (let i = 0; i < n; i++) {
  const x = rnd();
  if (x < 0.30) log.push({ op: 'reconcile-A', ...(await cli({ target: S.A.target, attemptId: S.A.attemptId, sourceReceiptId: S.A.sourceReceiptId })) });
  else if (x < 0.40) log.push({ op: 'reconcile-B-with-A-receipt', ...(await cli({ target: S.B.target, attemptId: S.B.attemptId, sourceReceiptId: S.A.sourceReceiptId })) });
  else if (x < 0.50) log.push({ op: 'reconcile-C-default-only', ...(await cli({ target: S.C.target, attemptId: S.C.attemptId, sourceReceiptId: S.C.sourceReceiptId })) });
  else if (x < 0.57) log.push({ op: 'reconcile-T-with-A-receipt', ...(await cli({ target: S.T.target, attemptId: S.T.attemptId, sourceReceiptId: S.A.sourceReceiptId })) });
  else if (x < 0.62) log.push({ op: 'reconcile-U-with-A-receipt', ...(await cli({ target: S.U.target, attemptId: S.U.attemptId, sourceReceiptId: S.A.sourceReceiptId })) });
  else if (x < 0.80) { // generation change on A (new instance + relay)
    const inst = `instance-g${prngSeed}-${i}`;
    const p = await req('presence-start', { target: S.A.target, instanceId: inst, transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, supportedInjection: ['peer-wake'], idleWake: 'silent' });
    const r = await req('acquire-relay', { target: S.A.target, transport: 'portable', relayId: `relay-${inst}`, pid: Number(driverPid), parentPid: Number(driverPid) });
    log.push({ op: 'gen-change-A', inst, presence: p?.error ?? 'ok', relay: r?.error ?? JSON.stringify(r) });
  } else { // reserve-wake on A at the latest instance this child knows (or instance-2)
    const st = await req('presence', { target: S.A.target });
    const inst = st?.presence?.instanceId ?? st?.instanceId ?? 'instance-2';
    const r = await req('reserve-wake', { target: S.A.target, nonce: `fz-${prngSeed}-${i}-${Math.floor(rnd() * 1e9)}-abcdefghij`, instanceId: inst, relayId: `relay-${inst}`, transport: 'portable' });
    log.push({ op: 'reserve-A', inst, dispatch: r?.dispatch ?? null, error: r?.error ?? null });
  }
}
process.stdout.write(JSON.stringify(log) + '\n');
