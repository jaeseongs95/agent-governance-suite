// Runs one fuzz trial: N worker processes share one throwaway state directory.
// Usage: node orchestrator.mjs <srcRoot> <seed> <nProcs> <steps> <outDir> [killRate]
import { fork } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { check } from './checker.mjs';

const [srcRoot, seedArg, nArg, stepsArg, outDir, killArg] = process.argv.slice(2);
const seed = Number(seedArg); const n = Number(nArg); const steps = Number(stepsArg);
const killRate = killArg === undefined ? 0.5 : Number(killArg);
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rand = mulberry32((seed * 31337 + n) >>> 0);

const label = `${srcRoot.includes('v271') ? 'v271' : 'v53'}-n${n}-s${seed}`;
const stateDir = join('/tmp/fuzzstate', label);
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });
process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = join(stateDir, 'trust.sqlite3');
process.env.HOME = stateDir;
const mod = (p) => import(pathToFileURL(join(srcRoot, 'mcp-server/src', p)).href);
const { SessionMessageStore } = await mod('session-message-store.ts');
const { recordWakeHookObservation } = await mod('session-message-wake-port.ts');
const { adaptHostInput } = await mod('host-input-adapter.ts');

const BASE = Date.parse('2026-09-28T00:00:00.000Z');
const dbPath = join(stateDir, 'session-messages.sqlite3');
const store = new SessionMessageStore(dbPath);
store.database.exec(`
CREATE TABLE h_clock (id INTEGER PRIMARY KEY, ms INTEGER NOT NULL);
CREATE TABLE h_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT, op TEXT, tbl TEXT, kind TEXT, key TEXT, host TEXT, session_id TEXT,
  old_state TEXT, new_state TEXT, old_late TEXT, new_late TEXT, gen TEXT, instance_id TEXT, attempt_id TEXT, old_epoch INTEGER, new_epoch INTEGER,
  old_relay TEXT, new_relay TEXT, now_ms INTEGER, extra TEXT);
CREATE TABLE h_ops (rowid INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT, worker INTEGER, pid INTEGER, op TEXT, args TEXT, result TEXT, error TEXT, now_ms INTEGER, wall_ms INTEGER);
CREATE TABLE h_pool (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, worker INTEGER, payload TEXT);
CREATE TABLE h_effects (rowid INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT, worker INTEGER, host TEXT, session_id TEXT, nonce TEXT, nonce_digest TEXT,
  attempt_id TEXT, epoch INTEGER, generation TEXT, instance_id TEXT, relay_id TEXT, row_state TEXT, row_epoch INTEGER, now_ms INTEGER);
`);
store.database.prepare('INSERT INTO h_clock (id, ms) VALUES (1, ?)').run(BASE);
const caps = { supportedInjection: ['peer-wake'], idleWake: 'silent' };
for (const sessionId of ['wake-t0', 'wake-t1']) {
  store.startPresence({ host: 'portable', sessionId, instanceId: 'inst-0', transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: caps }, BASE);
}
// Warm the trust key once so workers do not race on first key creation.
const warm = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: 'wake-t0', agent_id: '', prompt: '[agent-governance-suite:wake:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA]' }, 'portable').observation;
recordWakeHookObservation(warm, BASE);
store.close();

const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
let nextIndex = 0; const live = new Map(); const exits = []; const kills = [];
function spawn() {
  const index = nextIndex++;
  const child = fork(worker, [srcRoot, stateDir, String(seed), String(index), String(steps)],
    { cwd: srcRoot, execArgv: ['--import', 'tsx', '--no-warnings'], silent: true, env: process.env });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', () => {});
  const done = new Promise((resolve) => child.on('exit', (code, signal) => { live.delete(index); exits.push({ index, code, signal, stderr: stderr.slice(0, 2000) }); resolve(); }));
  live.set(index, { child, done });
  return done;
}
const all = [];
for (let i = 0; i < n; i += 1) all.push(spawn());
// Seeded kill schedule: SIGKILL a live worker at a random delay and start a replacement.
const killPlan = [];
for (let i = 0; i < n; i += 1) if (rand() < killRate) killPlan.push({ delay: 150 + Math.floor(rand() * 1500), victim: Math.floor(rand() * n) });
await Promise.all(killPlan.map(async (k) => {
  await new Promise((r) => setTimeout(r, k.delay));
  const entry = live.get(k.victim);
  if (!entry) return;
  entry.child.kill('SIGKILL');
  kills.push({ at: k.delay, victim: k.victim });
  all.push(spawn());
}));
while (live.size) await Promise.all([...live.values()].map((e) => e.done));
await Promise.all(all);

const result = check(dbPath);
const summary = { label, seed, n, steps, killRate, killPlan, kills, exits: exits.map((e) => ({ index: e.index, code: e.code, signal: e.signal, stderr: e.stderr || undefined })), ...result };
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${label}.json`), JSON.stringify(summary, null, 1));
const hasViolation = Object.values(result.invariants).some((v) => v.violations > 0);
if (hasViolation) {
  const size = statSync(dbPath).size;
  // Keep the DB for violating seeds (after WAL checkpoint via checker's connection close).
  if (size < 10 * 1024 * 1024) copyFileSync(dbPath, join(outDir, `${label}.sqlite3`));
}
if (!process.env.KEEP_STATE) rmSync(stateDir, { recursive: true, force: true });
console.log(JSON.stringify({ label, ops: result.opCount, errors: result.errorCount, violations: Object.fromEntries(Object.entries(result.invariants).map(([k, v]) => [k, v.violations])) }));
