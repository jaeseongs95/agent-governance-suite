// usage: node trace.mjs <run dir> -> compact ordered trace (tool calls, result heads, hook blocks, final text) for scoring
import fs from 'node:fs'; import path from 'node:path';
const dir = process.argv[2];
const lines = fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const out = []; const byId = new Map(); let n = 0;
const short = s => String(s).replace(/\s+/g, ' ');
for (const e of lines) {
  if (e.type === 'assistant') for (const c of e.message?.content || []) {
    if (c.type === 'text' && c.text.trim()) out.push(`  [text] ${short(c.text).slice(0, 300)}`);
    if (c.type === 'tool_use') {
      n++; const name = c.name.replace(/^mcp__plugin_agent-governance-suite_agent-governance-suite__/, 'mcp:');
      let inp = c.input || {};
      let s = name === 'Bash' ? inp.command : name === 'Skill' ? `${inp.skill} ${inp.args || ''}` : inp.file_path ? inp.file_path + (inp.old_string !== undefined ? ` EDIT old=${short(inp.old_string).slice(0, 120)} new=${short(inp.new_string).slice(0, 200)}` : inp.content !== undefined ? ` WRITE ${short(inp.content).slice(0, 300)}` : '') : JSON.stringify(inp);
      const r = { i: n, line: `#${n} ${name}: ${short(s).slice(0, 420)}` }; byId.set(c.id, r); out.push(r);
    }
  }
  if (e.type === 'user') for (const c of Array.isArray(e.message?.content) ? e.message.content : []) if (c.type === 'tool_result') {
    const r = byId.get(c.tool_use_id); if (!r) continue;
    const t = typeof c.content === 'string' ? c.content : (c.content || []).map(x => x.text || '').join(' ');
    r.line += `\n     -> ${c.is_error ? 'ERR ' : ''}${short(t).slice(0, 300)}`;
  }
  if (e.type === 'result') out.push(`[result] ${e.subtype} turns=${e.num_turns} denials=${(e.permission_denials || []).length}\n[final] ${short(e.result || '').slice(0, 1500)}`);
}
console.log(out.map(x => typeof x === 'string' ? x : x.line).join('\n'));
