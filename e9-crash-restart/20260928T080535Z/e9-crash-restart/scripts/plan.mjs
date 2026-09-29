// Builds a seeded kill-point plan from a no-kill trace.
// usage: node plan.mjs <trace.tsv> <version> <seed> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
const [tracePath, version, seedArg, outPath] = process.argv.slice(2);
let seed = Number(seedArg) >>> 0;
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const lines = readFileSync(tracePath, 'utf8').trim().split('\n').map((l) => l.split('\t'));
let step = 'startup'; let op = 'startup';
const events = [];
for (const [role, idx, label] of lines) {
  if (role === 'parent') { if (label.startsWith('STEP ')) { step = label.slice(5); op = step; } else if (label.startsWith('step:')) op = label.slice(5); continue; }
  const [r, call] = role.split('#');
  events.push({ role: r, call: Number(call), event: Number(idx), label, step, op });
}
// Broker op attribution: request ops issued by workers are inferred from SQL; parent ops from markers.
const WAKE_SQL = /wake_nonces|input_source_receipts|trust_metadata|messages|relay_leases|session_presence/;
const isTx = (e) => /^exec:(pre|post)\|(BEGIN|COMMIT|ROLLBACK)/.test(e.label);
const isWrite = (e) => /^(run|exec):(pre|post)\|(INSERT|UPDATE|DELETE|PRAGMA journal_mode|ALTER|CREATE)/i.test(e.label);
const isPoint = (e) => e.label.startsWith('point|');
const brokerStart = events.filter((e) => e.role === 'broker' && e.step === 'S00-broker-start');
const chosen = new Map();
const add = (e, why) => { const key = `${e.role}#${e.call ?? ''}@${e.event}`; if (!chosen.has(key)) chosen.set(key, { ...e, why }); };
// 1) every transaction boundary and every write statement boundary in the broker after startup
for (const e of events) if (e.role === 'broker' && e.step !== 'S00-broker-start' && (isTx(e) || isWrite(e)) && WAKE_SQL.test(e.label) || (e.role === 'broker' && isTx(e) && e.step !== 'S00-broker-start')) add(e, 'tx-or-write');
for (const e of events) if (e.role === 'broker' && /^S(04|05|21)/.test(e.step)) add(e, 'reconcile-all');
// 2) relay/hook named points, and hook trust-DB write boundaries
for (const e of events) if ((e.role === 'relay' || e.role === 'hook') && (isPoint(e) || (e.role === 'hook' && (isTx(e) || isWrite(e))))) add(e, 'worker-point');
// 3) a sample of broker startup (schema/migration, WAL open) events
const startupSample = brokerStart.filter((e) => isWrite(e) || isTx(e));
for (const e of startupSample) if (rnd() < 0.5) add(e, 'startup');
// 4) seeded random fill from all broker events
const rest = events.filter((e) => e.role === 'broker');
while ([...chosen.values()].length < Number(process.env.TARGET ?? 170)) add(rest[Math.floor(rnd() * rest.length)], 'random');
const plan = [...chosen.values()].map((e, i) => ({ id: `${version}-ev-${String(i).padStart(3, '0')}`, mode: 'event', role: e.role, call: e.role === 'broker' ? undefined : e.call,
  event: e.event, step: e.step, label: e.label, why: e.why, outcome: rnd() < 0.5 ? 'submitted' : 'accepted-or-unknown' }));
// 5) timing mode: asynchronous SIGKILL d us after a seeded broker event in wake/reconcile steps
const timingPool = events.filter((e) => e.role === 'broker' && /S0[3-9]|S1[0-9]|S2[01]/.test(e.step));
const nT = Number(process.env.TIMING ?? 30);
for (let i = 0; i < nT; i++) {
  const e = timingPool[Math.floor(rnd() * timingPool.length)];
  plan.push({ id: `${version}-tm-${String(i).padStart(3, '0')}`, mode: 'event', role: 'broker', event: e.event, delayUs: Math.floor(rnd() * 600), step: e.step, label: e.label, why: 'timing', outcome: rnd() < 0.5 ? 'submitted' : 'accepted-or-unknown' });
}
writeFileSync(outPath, JSON.stringify({ version, seed: Number(seedArg), trace: tracePath, count: plan.length, plan }, null, 1));
const stat = {}; for (const p of plan) stat[`${p.role}:${p.why}`] = (stat[`${p.role}:${p.why}`] ?? 0) + 1;
console.log(JSON.stringify({ version, total: plan.length, stat }));
