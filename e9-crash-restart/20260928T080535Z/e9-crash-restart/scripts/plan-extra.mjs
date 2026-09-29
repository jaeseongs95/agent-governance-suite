// Extra plan: double kill (second SIGKILL inside restart/WAL recovery or the retried op) and long outage (receipt TTL lapse).
import { readFileSync, writeFileSync } from 'node:fs';
const [planPath, version, seedArg, outPath] = process.argv.slice(2);
let seed = Number(seedArg) >>> 0;
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const { plan } = JSON.parse(readFileSync(planPath, 'utf8'));
const pool = plan.filter((p) => p.role === 'broker' && p.why !== 'timing' && /^S(04|08|09|14|16|17|18)/.test(p.step) && /BEGIN|COMMIT|UPDATE wake_nonces|INSERT INTO wake_nonces|UPDATE messages/.test(p.label));
const out = [];
for (let i = 0; i < 30; i++) {
  const p = pool[Math.floor(rnd() * pool.length)];
  out.push({ ...p, id: `${version}-dk-${String(i).padStart(3, '0')}`, event2: 1 + Math.floor(rnd() * 60), why: 'double-kill', outcome: rnd() < 0.5 ? 'submitted' : 'accepted-or-unknown' });
}
const claimBegin = plan.filter((p) => p.role === 'broker' && /^S(09|16|18)/.test(p.step) && p.label === 'exec:post|BEGIN IMMEDIATE');
claimBegin.forEach((p, i) => out.push({ ...p, id: `${version}-down-${i}`, downMs: 35000, why: 'outage-35s', outcome: 'submitted' }));
writeFileSync(outPath, JSON.stringify({ version, seed: Number(seedArg), plan: out }, null, 1));
console.log(version, out.length, out.filter((x) => x.downMs).map((x) => x.step + '@' + x.event).join(' '));
