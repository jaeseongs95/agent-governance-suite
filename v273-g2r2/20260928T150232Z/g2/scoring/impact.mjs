// usage: node impact.mjs <runs dir> -> runs whose assistant-authored text contains a failure-impact classification ("실패 영향")
import fs from 'node:fs';
const R = process.argv[2]; const hits = {};
for (const rid of fs.readdirSync(R).filter(d => /^[px]\d-(base|cand)-r\d$/.test(d)).sort()) {
  let n = 0;
  for (const l of fs.readFileSync(`${R}/${rid}/stream.jsonl`, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== 'assistant') continue;
    for (const c of e.message?.content || []) if (c.type === 'text' && /실패 영향/.test(c.text)) n++;
    if (e.type === 'result' && /실패 영향/.test(e.result || '')) n++;
  }
  if (n) { const [p, arm] = rid.split('-'); (hits[arm] ??= []).push(rid); }
}
for (const arm of ['base', 'cand']) console.log(arm, (hits[arm] || []).length, (hits[arm] || []).join(' '));
