// aggregates runs/*/analysis.json -> summary.json + markdown tables (stdout)
import fs from 'node:fs';
const R = '/tmp/ev/runs';
const order = fs.readFileSync('/tmp/ev/scripts/order.txt', 'utf8').trim().split('\n').map(l => l.split(' '));
const cat = { p1: '구현(fib 메모이제이션)', p2: 'diff 리뷰', p3: '단순 설명(rebase/merge)', p4: '테스트 실행·수정', p5: '한국어 문단 다듬기', p6: '인사·잡담', p7: '고위험(push+태그, 원격 없음)', p8: '모호("좋게 만들어줘")', p9: '스크립트 안전 검토', x1: '대조: korean-prose-editor 명시', x2: '대조: /ponytail 명시' };
const rows = [];
for (const [seq, rid, arm, p] of order) {
  const f = `${R}/${rid}/analysis.json`;
  if (!fs.existsSync(f)) { rows.push({ seq, rid, arm, p, missing: true }); continue; }
  const a = JSON.parse(fs.readFileSync(f, 'utf8'));
  const retries = fs.readdirSync(R).filter(d => d.startsWith(rid + '.infra-attempt')).length;
  rows.push({ seq, rid, arm, p, retries, skills: a.usedAgsSkills.map(s => s.replace('agent-governance-suite:', '')), skillCallsRaw: a.skillCalls.map(s => s.skill),
    trigger: a.skillTriggerContexts.map(c => `${c.event}:${(c.context.match(/agent-governance-suite:[a-z-]+/g) || []).map(s => s.split(':')[1]).join('+')}`),
    mcp: a.mcpCalls, wf: a.workflowCalls.map(w => w.tool), agents: a.agentCalls.map(x => x.subagent_type), docReads: a.pluginDocReads.length,
    turns: a.result?.num_turns, end: a.result?.subtype, term: a.result?.terminal_reason, isErr: a.result?.is_error, exit: a.exit,
    denials: (a.permissionDenials || []).map(d => d.tool_name + (d.tool_input?.command ? `(${String(d.tool_input.command).slice(0, 50)})` : '')),
    sidOk: a.sessionIdMatchesRequested, model: a.init?.model, order: a.toolOrder, cost: a.result?.total_cost_usd, text: a.result?.text });
}
fs.writeFileSync('/tmp/ev/summary.json', JSON.stringify(rows, null, 1));
const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
let md = '## 실행별 표\n\n| seq | run | skill-trigger 훅 | 사용 스킬 | MCP workflow 도구 | 기타 MCP | Agent | 턴 | 종료 | 권한 거절 | 도구 순서 |\n|---|---|---|---|---|---|---|---|---|---|---|\n';
for (const r of [...rows].sort((x, y) => x.rid.localeCompare(y.rid))) {
  if (r.missing) { md += `| ${r.seq} | ${r.rid} | NOT_RUN | | | | | | | | |\n`; continue; }
  md += `| ${r.seq} | ${r.rid}${r.retries ? ` (infra 재시도 ${r.retries})` : ''} | ${esc(r.trigger.join(', ') || '-')} | ${esc(r.skills.join(', ') || '-')} | ${esc(r.wf.join('→') || '-')} | ${esc(r.mcp.filter(m => !r.wf.includes(m)).join(',') || '-')} | ${esc(r.agents.join(',') || '-')} | ${r.turns} | ${r.end}/${r.term} | ${esc(r.denials.join('; ') || '-')} | ${esc(r.order.join(' → ').slice(0, 400))} |\n`;
}
md += '\n## 범주별 비교표\n\n| prompt | 범주 | arm | 사용 스킬 분포(3회) | 스킬 사용 회수 | workflow 사용 회수 | 훅 안내 회수 | 턴(각 회) | 종료 |\n|---|---|---|---|---|---|---|---|---|\n';
const agg = {};
for (const p of Object.keys(cat)) for (const arm of ['base', 'cand']) {
  const rs = rows.filter(r => r.p === p && r.arm === arm && !r.missing);
  const dist = {}; for (const r of rs) { const k = r.skills.length ? r.skills.join('+') : '(없음)'; dist[k] = (dist[k] || 0) + 1; }
  const a = { n: rs.length, dist, skillRuns: rs.filter(r => r.skills.length).length, wfRuns: rs.filter(r => r.wf.length).length, trig: rs.filter(r => r.trigger.length).length, turns: rs.map(r => r.turns), ends: rs.map(r => r.term) };
  agg[`${p}/${arm}`] = a;
  md += `| ${p} | ${cat[p]} | ${arm} | ${esc(Object.entries(dist).map(([k, v]) => `${k}×${v}`).join(', '))} | ${a.skillRuns}/${a.n} | ${a.wfRuns}/${a.n} | ${a.trig}/${a.n} | ${a.turns.join(',')} | ${esc([...new Set(a.ends)].join(','))} |\n`;
}
fs.writeFileSync('/tmp/ev/aggregate.json', JSON.stringify(agg, null, 1));
console.log(md);
