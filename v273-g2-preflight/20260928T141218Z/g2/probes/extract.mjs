// usage: node extract.mjs <run dir> -> JSON summary of init, tool calls with result status, permission denials, final text
import fs from 'node:fs'; import path from 'node:path';
const dir = process.argv[2];
const lines = fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const out = { init: null, calls: [], denials: null, result: null };
const byId = new Map();
for (const e of lines) {
  if (e.type === 'system' && e.subtype === 'init') out.init = { cwd: e.cwd, permissionMode: e.permissionMode, model: e.model, claude_code_version: e.claude_code_version, tools: e.tools, mcp_servers: e.mcp_servers, plugins: e.plugins, skills: e.skills, slash_commands_count: (e.slash_commands || []).length };
  if (e.type === 'assistant') for (const c of e.message?.content || []) if (c.type === 'tool_use') { const r = { id: c.id, tool: c.name, input: JSON.stringify(c.input).slice(0, 300) }; byId.set(c.id, r); out.calls.push(r); }
  if (e.type === 'user') for (const c of e.message?.content || []) if (c.type === 'tool_result') { const r = byId.get(c.tool_use_id); if (!r) continue; const t = typeof c.content === 'string' ? c.content : (c.content || []).map(x => x.text || '').join(' '); r.is_error = !!c.is_error; r.denied = /requested permissions|permission to use|haven't granted|was blocked|not allowed|denied/i.test(t) && !!c.is_error; r.result = t.replace(/\s+/g, ' ').slice(0, 240); }
  if (e.type === 'result') { out.denials = e.permission_denials; out.result = { subtype: e.subtype, is_error: e.is_error, num_turns: e.num_turns, text: e.result }; }
}
console.log(JSON.stringify(out, null, 1));
