// Aggregates campaign results into markdown tables + a cross-version key map.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const load = (p) => existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const versions = [['e9', 'e9'], ['53', 'v53']];
const C = ['a_integrity', 'b_reattach', 'c_unknown_preserved', 'd_reconcile_idempotent', 'e_new_generation_effect', 'f_schema'];
const out = {}; let md = '';
// occurrence key: step|label|nth within step (role-aware) so the same code-path boundary can be matched across versions
function keyed(planPath) {
  const { plan } = JSON.parse(readFileSync(planPath, 'utf8'));
  return plan;
}
function traceKeys(tracePath) {
  const lines = readFileSync(tracePath, 'utf8').trim().split('\n').map((l) => l.split('\t'));
  let step = 'startup'; const counts = {}; const map = {};
  for (const [role, idx, label] of lines) {
    if (role === 'parent') { if (label.startsWith('STEP ')) step = label.slice(5); continue; }
    const k = `${role}|${step}|${label}`; counts[k] = (counts[k] ?? 0) + 1;
    map[`${role}@${idx}`] = `${k}|#${counts[k]}`;
  }
  return map;
}
const summary = {};
for (const [v, wt] of versions) {
  const rerun = load(`/tmp/ev/results-rerun-${wt}.jsonl`); const rr = new Set(rerun.map((r) => r.id));
  const superseded = [...load(`/tmp/ev/results-${wt}.jsonl`), ...load(`/tmp/ev/results-extra-${wt}.jsonl`)].filter((r) => rr.has(r.id));
  const rows = [...load(`/tmp/ev/results-${wt}.jsonl`).filter((r) => !rr.has(r.id)), ...rerun.map((r) => ({ ...r, rerun: true })), ...load(`/tmp/ev/results-extra-${wt}.jsonl`).filter((r) => !rr.has(r.id)), ...load(`/tmp/ev/results-ctl-${wt}.jsonl`)];
  const tk = traceKeys(`/tmp/ev/ref/trace-${wt}.tsv`);
  const s = { supersededHarnessRuns: superseded.map((r) => r.id), total: rows.length, killed: 0, notTriggered: 0, harness: 0, byCheck: {}, byMode: {}, fails: [] };
  let table = `| id | mode | role | step | kill label (trace) | killed | restarts | a | b | c | d | e | f |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of rows.sort((x, y) => x.id.localeCompare(y.id))) {
    const sp = r.spec ?? {};
    const role = sp.role === 'broker' ? 'broker#1' : `${sp.role}#${sp.call}`;
    r.key = tk[`${role}@${sp.event}`] ?? null;
    if (r.killed) s.killed++; else s.notTriggered++;
    if (r.harnessIssues) s.harness++;
    const mode = sp.why === 'timing' ? 'timing' : sp.why === 'double-kill' ? 'double' : sp.why?.startsWith('outage') ? sp.why : 'boundary';
    s.byMode[mode] = (s.byMode[mode] ?? 0) + 1;
    for (const c of C) { const vv = r.verdicts?.[c] ?? 'NOT_RUN'; (s.byCheck[c] ??= {})[vv] = (s.byCheck[c][vv] ?? 0) + 1; if (vv === 'FAIL') s.fails.push({ id: r.id, check: c, key: r.key }); }
    const cell = (c) => { const x = r.verdicts?.[c]; return x === 'PASS' ? 'P' : x === 'FAIL' ? '**F**' : x === 'NA' ? 'NA' : x ?? '-'; };
    table += `| ${r.id} | ${mode}${sp.delayUs !== undefined ? `(+${sp.delayUs}us)` : ''}${sp.event2 ? `(2nd@${sp.event2})` : ''}${sp.downMs ? `(down ${sp.downMs}ms)` : ''} | ${sp.role}${sp.call ? '#' + sp.call : ''} | ${sp.step} | \`${String(sp.label).slice(0, 70).replace(/\|/g, '/')}\` @${sp.event} | ${r.killed === null ? '-' : r.killed ? 'Y' : 'NOT_TRIGGERED'} | ${r.restarts ?? '-'} | ${C.map(cell).join(' | ')} |\n`;
  }
  summary[v] = s; out[v] = rows;
  writeFileSync(`/tmp/ev/killpoints-${v}.md`, `# Kill points ${v}\n\n${table}`);
}
// cross-version: same code-path boundary key
const keys53 = new Map(out['53'].filter((r) => r.key).map((r) => [r.key, r]));
const cross = [];
for (const r of out.e9) {
  const fails = C.filter((c) => r.verdicts?.[c] === 'FAIL');
  if (!fails.length) continue;
  const m = keys53.get(r.key);
  cross.push({ id: r.id, key: r.key, fails, v53: m ? { id: m.id, verdicts: m.verdicts } : 'no-equivalent-point-in-53' });
}
const sharedKeys = out.e9.filter((r) => r.key && keys53.has(r.key)).length;
writeFileSync('/tmp/ev/aggregate.json', JSON.stringify({ summary, cross, sharedKeys }, null, 1));
console.log(JSON.stringify({ summary, cross: cross.length, sharedKeys }, null, 1));
