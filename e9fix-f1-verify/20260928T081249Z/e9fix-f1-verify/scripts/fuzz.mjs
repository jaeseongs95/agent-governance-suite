// Concurrency fuzz driver: seeds S0..S1-1, 4 child processes per seed against the fix install broker.
// Usage: node fuzz.mjs <firstSeed> <count> <INST>
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const [first, count, INST] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
const PROCS = 4;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
const dirState = (d) => existsSync(d) ? readdirSync(d).sort().map((f) => `${f}:${statSync(`${d}/${f}`).size}:${sha(`${d}/${f}`)}:${statSync(`${d}/${f}`).mtimeMs}`).join(',') : 'NO_DIR';
function rows(R) { // read a scratch copy so observation never touches R
  const S = `${R}-obs`; rmSync(S, { recursive: true, force: true }); mkdirSync(S);
  for (const f of readdirSync(R)) if (/^session-messages\.sqlite3(-wal|-shm)?$/.test(f)) cpSync(`${R}/${f}`, `${S}/${f}`);
  const db = new DatabaseSync(`${S}/session-messages.sqlite3`);
  const w = db.prepare('SELECT rowid, * FROM wake_nonces ORDER BY rowid').all();
  const m = db.prepare('SELECT message_id, claimed_at, delivery_attempts, acknowledged_at FROM messages ORDER BY message_id').all();
  db.close(); rmSync(S, { recursive: true, force: true }); return { w, m };
}
const cliRec = (R, H, payload) => { const r = spawnSync(process.execPath, [`${INST}/mcp-server/dist/session-message-cli.mjs`], { input: JSON.stringify({ operation: 'reconcile-wake-observation', payload }), env: { PATH: process.env.PATH, HOME: H, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: R }, cwd: INST, encoding: 'utf8' });
  try { return JSON.parse(r.stdout).data?.reconciled; } catch { return `ERR:${r.stdout}${r.stderr}`.slice(0, 120); } };
const summary = [];
for (let s = first; s < first + count; s++) {
  const B = `/tmp/fuzz/s${s}`; rmSync(B, { recursive: true, force: true });
  const H = `${B}/home`, D = `${H}/.agent-governance-suite/session-messaging`, R = `${B}/R`;
  mkdirSync(R, { recursive: true, mode: 0o700 }); mkdirSync(D, { recursive: true });
  const seedOut = spawnSync(process.execPath, ['--import', 'tsx', '/tmp/ev/scripts/fuzz-seed.mjs', R, D], { cwd: '/tmp/fix', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: H } });
  if (seedOut.status !== 0) { summary.push({ seed: s, error: `seed failed ${seedOut.stderr.slice(0, 300)}` }); console.log(JSON.stringify(summary.at(-1))); continue; }
  const S = JSON.parse(seedOut.stdout);
  const dBefore = dirState(D);
  const pre = rows(R);
  const broker = spawn(process.execPath, [`${INST}/mcp-server/dist/session-message-broker.mjs`, '--state-directory', R], { env: { PATH: process.env.PATH, HOME: H }, cwd: INST, stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(`${R}/endpoint.json`); i++) await new Promise((r) => setTimeout(r, 50));
  const startAt = Date.now() + 2500;
  const kids = Array.from({ length: PROCS }, (_, p) => new Promise((res) => {
    const prng = s * 16 + p;
    const c = spawn(process.execPath, ['--import', 'tsx', '/tmp/ev/scripts/fuzz-child.mjs', R, INST, JSON.stringify(S), String(prng), String(startAt), String(process.pid), H], { cwd: '/tmp/fix', env: { PATH: process.env.PATH, HOME: H } });
    let o = '', e = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { e += d; });
    c.on('close', (code) => { let log; try { log = JSON.parse(o); } catch { log = null; } res({ prng, code, log, stderr: e.slice(0, 300) }); });
  }));
  const results = await Promise.all(kids);
  const mid = rows(R);
  // second pass: every reconcile must be false and change nothing
  const rerun = { A: cliRec(R, H, { target: S.A.target, attemptId: S.A.attemptId, sourceReceiptId: S.A.sourceReceiptId }),
    B: cliRec(R, H, { target: S.B.target, attemptId: S.B.attemptId, sourceReceiptId: S.A.sourceReceiptId }),
    C: cliRec(R, H, { target: S.C.target, attemptId: S.C.attemptId, sourceReceiptId: S.C.sourceReceiptId }),
    T: cliRec(R, H, { target: S.T.target, attemptId: S.T.attemptId, sourceReceiptId: S.A.sourceReceiptId }),
    U: cliRec(R, H, { target: S.U.target, attemptId: S.U.attemptId, sourceReceiptId: S.A.sourceReceiptId }) };
  const post = rows(R);
  broker.kill('SIGTERM'); await new Promise((r) => broker.once('exit', r));
  const dAfter = dirState(D);
  const ops = results.flatMap((r) => r.log ?? []);
  const byAttempt = (snap, id) => snap.w.find((x) => x.attempt_id === id);
  const active = {}; for (const x of post.w) if (x.state === 'reserved' || x.state === 'started') active[x.session_id] = (active[x.session_id] ?? 0) + 1;
  const aTrue = ops.filter((o) => o.op === 'reconcile-A' && o.v === true).length;
  const inv = {
    activeLe1: Object.values(active).every((n) => n <= 1),
    terminalUnchanged: ['T', 'U'].every((k) => JSON.stringify(byAttempt(pre, S[k].attemptId)) === JSON.stringify(byAttempt(post, S[k].attemptId))),
    noUnfoundedRelease: ['B', 'C'].every((k) => { const r = byAttempt(post, S[k].attemptId); return r.state === 'unknown' && r.consumed_at === null && r.observed_at === null; }),
    wrongTargetsFalse: ops.filter((o) => /reconcile-(B|C|T|U)/.test(o.op)).every((o) => o.v === false),
    reconcileATrueLe1: aTrue <= 1,
    aRowConsistent: (aTrue === 1) === (byAttempt(post, S.A.attemptId).state === 'observed'),
    rerunAllFalse: Object.values(rerun).every((v) => v === false),
    rerunNoChange: JSON.stringify(mid) === JSON.stringify(post),
    noMessageClaim: post.m.every((m) => m.claimed_at === null && m.delivery_attempts === 0),
    defaultPathUntouched: dBefore === dAfter,
    childrenOk: results.every((r) => r.code === 0 && r.log),
  };
  const reserveTrue = ops.filter((o) => o.op === 'reserve-A' && o.dispatch === true).length;
  const errs = ops.filter((o) => (typeof o.v === 'string') || o.error).map((o) => `${o.op}:${o.v ?? o.error}`);
  summary.push({ seed: s, prngSeeds: results.map((r) => r.prng), ops: ops.map((o) => `${o.op}=${o.v ?? o.dispatch ?? o.presence ?? ''}`), aTrue, reserveTrue, activeCounts: active, rerun, inv, pass: Object.values(inv).every(Boolean), errs, childStderr: results.map((r) => r.stderr).filter(Boolean) });
  console.log(JSON.stringify(summary.at(-1)));
  rmSync(B, { recursive: true, force: true });
}
const fails = summary.filter((x) => !x.pass);
console.log(JSON.stringify({ SUMMARY: true, seeds: summary.length, pass: summary.filter((x) => x.pass).length, fail: fails.length, failSeeds: fails.map((x) => x.seed),
  aTrueDist: summary.reduce((m, x) => (m[x.aTrue] = (m[x.aTrue] ?? 0) + 1, m), {}), reserveTrueDist: summary.reduce((m, x) => (m[x.reserveTrue] = (m[x.reserveTrue] ?? 0) + 1, m), {}),
  opCounts: summary.flatMap((x) => x.ops ?? []).reduce((m, o) => (m[o] = (m[o] ?? 0) + 1, m), {}) }));
