// usage: node features.mjs -> per-run scoring features from raw stream.jsonl + repo-after.txt (JSON lines)
import fs from 'node:fs';
const R = '/tmp/ev/runs';
const runs = fs.readdirSync(R).filter(d => /^[px]\d-(base|cand)-r\d$/.test(d)).sort();
const rows = [];
for (const rid of runs) {
  const ev = fs.readFileSync(`${R}/${rid}/stream.jsonl`, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const calls = []; const byId = new Map(); let finalText = '', subtype = '', texts = [];
  for (const e of ev) {
    if (e.type === 'assistant') for (const c of e.message?.content || []) {
      if (c.type === 'text') texts.push(c.text);
      if (c.type === 'tool_use') { const x = { i: calls.length, name: c.name, input: c.input || {}, ok: null, out: '' }; calls.push(x); byId.set(c.id, x); }
    }
    if (e.type === 'user') for (const c of Array.isArray(e.message?.content) ? e.message.content : []) if (c.type === 'tool_result') {
      const x = byId.get(c.tool_use_id); if (!x) continue;
      x.ok = !c.is_error; x.out = typeof c.content === 'string' ? c.content : (c.content || []).map(y => y.text || '').join(' ');
    }
    if (e.type === 'result') { finalText = e.result || ''; subtype = e.subtype; }
  }
  const skills = calls.filter(c => c.name === 'Skill').map(c => ({ i: c.i, skill: String(c.input.skill || '').replace('agent-governance-suite:', ''), ok: c.ok }));
  const edits = calls.filter(c => ['Edit', 'Write', 'NotebookEdit'].includes(c.name) && c.ok).map(c => ({ i: c.i, file: String(c.input.file_path || '').split('/').pop() }));
  const bashOk = calls.filter(c => c.name === 'Bash' && c.ok);
  const sedEdits = bashOk.filter(c => /\bsed -i|>\s*(math|util|fib)\.js|tee /.test(c.input.command || '')).map(c => ({ i: c.i, cmd: c.input.command.slice(0, 120) }));
  const testRuns = bashOk.filter(c => /ℹ tests \d+|# tests \d+/.test(c.out)).map(c => { const g = k => Number((c.out.match(new RegExp(`[ℹ#] ${k} (\\d+)`)) || [])[1]); return { i: c.i, cmd: c.input.command.slice(0, 100), tests: g('tests'), pass: g('pass'), fail: g('fail') }; });
  const pluginReads = calls.filter(c => (c.name === 'Read' && /claude-plugin/.test(c.input.file_path || '')) || (c.name === 'Bash' && /claude-plugin/.test(c.input.command || ''))).map(c => ({ i: c.i, ok: c.ok, what: c.name === 'Read' ? c.input.file_path.replace(/.*claude-plugin\//, '') : c.input.command.slice(0, 100) }));
  const pluginScripts = bashOk.filter(c => /claude-plugin\/skills\/[^ ]+\/scripts\/[^ ]+\.mjs/.test(c.input.command || '')).map(c => ({ i: c.i, script: (c.input.command.match(/skills\/[^ ]+?\.mjs/) || [''])[0], out: c.out.slice(0, 160) }));
  const mcp = calls.filter(c => c.name.startsWith('mcp__')).map(c => c.name.replace(/^mcp__.*?__/, ''));
  const denied = calls.filter(c => c.ok === false && /denied|requires approval|haven't granted/i.test(c.out)).length;
  const hookBlocked = calls.filter(c => c.ok === false && /hook error/.test(c.out)).length;
  const repoAfter = fs.readFileSync(`${R}/${rid}/repo-after.txt`, 'utf8');
  const changed = [...repoAfter.matchAll(/^diff --git a\/(\S+)/gm)].map(m => m[1]);
  const untracked = [...repoAfter.matchAll(/^\?\? (\S+)/gm)].map(m => m[1]);
  const tags = repoAfter.split('\n').filter(l => /^v\d/.test(l));
  rows.push({ rid, subtype, turns: calls.length, skills, edits, sedEdits, testRuns, pluginReads: pluginReads.length, pluginReadsDenied: pluginReads.filter(p => p.ok === false).length, pluginScripts, mcp: [...new Set(mcp)], denied, hookBlocked, changed, untracked, tags, finalLen: finalText.length, final: finalText.slice(0, 600) });
}
for (const r of rows) console.log(JSON.stringify(r));
