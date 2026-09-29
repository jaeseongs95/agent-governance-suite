// deterministic seeded shuffle (mulberry32) of prompt x arm x rep
const seed = Number(process.argv[2]);
let a = seed >>> 0;
const rnd = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const prompts = ['p1','p2','p3','p4','p5','p6','p7','p8','p9','x1','x2'];
const items = [];
for (const p of prompts) for (const arm of ['base','cand']) for (let r = 1; r <= 3; r++) items.push(`${p}-${arm}-r${r} ${arm} ${p}`);
for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
items.forEach((x, i) => console.log(`${String(i + 1).padStart(2, '0')} ${x}`));
