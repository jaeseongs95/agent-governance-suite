// usage: node analyze.mjs <run_dir>  -> JSON summary of one stream-json run
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const raw = fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8');
const lines = raw.split('\n').filter(l => l.startsWith('{'));
const cmd = fs.existsSync(path.join(dir, 'cmd.txt')) ? fs.readFileSync(path.join(dir, 'cmd.txt'), 'utf8') : '';
const meta = Object.fromEntries((cmd.split('\n')[0] || '').split(' ').map(kv => kv.split('=')));
const WF = /(plan_workflow|open_convergence_root|claim_workflow_attempt|start_guarded_workflow|start_workflow|record_stage_result|finalize_workflow|abort_workflow|get_workflow_status|get_convergence_status|resolve_convergence_gate|validate_collaboration_decision)$/;
const out = { run_id: meta.run_id, arm: meta.arm, prompt: meta.prompt, requested_session_id: meta.session_id,
  exit: fs.existsSync(path.join(dir, 'exit')) ? Number(fs.readFileSync(path.join(dir, 'exit'), 'utf8')) : null,
  init: null, hooks: [], skillTriggerContexts: [], otherHookContexts: [], skillCalls: [], slashCommandSkills: [], mcpCalls: [], workflowCalls: [],
  agentCalls: [], pluginDocReads: [], toolOrder: [], toolErrors: [], result: null, permissionDenials: null, apiErrors: [] };
function hookCtx(s) {
  try { const j = JSON.parse(s); return j?.hookSpecificOutput?.additionalContext ?? j?.additionalContext ?? null; } catch { return null; }
}
for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  if (e.type === 'system' && e.subtype === 'init') {
    out.init = { session_id: e.session_id, model: e.model, permissionMode: e.permissionMode, cwd: e.cwd,
      plugins: e.plugins, mcp_servers: e.mcp_servers, agsTools: (e.tools || []).filter(t => /agent-governance/.test(t)).length,
      toolCount: (e.tools || []).length, skills: (e.skills || []).filter(s => /agent-governance/.test(s)), otherSkills: (e.skills || []).filter(s => !/agent-governance/.test(s)), agents: e.agents, claude_code_version: e.claude_code_version };
  } else if (e.type === 'system' && /hook/.test(e.subtype || '')) {
    const h = { subtype: e.subtype, hook_name: e.hook_name, hook_event: e.hook_event, exit_code: e.exit_code, outcome: e.outcome };
    if (e.subtype === 'hook_response') {
      const ctx = hookCtx(e.stdout || e.output || '');
      h.stdout = (e.stdout || '').slice(0, 2000); if (e.stderr) h.stderr = e.stderr.slice(0, 500);
      if (ctx) {
        if (/skill-trigger|agent-governance-suite 안내/.test(ctx)) out.skillTriggerContexts.push({ event: e.hook_event, name: e.hook_name, context: ctx });
        else out.otherHookContexts.push({ event: e.hook_event, name: e.hook_name, context: ctx.slice(0, 600) });
      }
    }
    out.hooks.push(h);
  } else if (e.type === 'assistant') {
    if (e.error || e.message?.model === '<synthetic>') out.apiErrors.push(JSON.stringify(e.message?.content || e.error).slice(0, 400));
    for (const c of e.message?.content || []) {
      if (c.type !== 'tool_use') continue;
      const inp = c.input || {};
      let label = c.name;
      if (c.name === 'Skill') { out.skillCalls.push({ skill: inp.skill || inp.command || inp.name, args: String(inp.args || '').slice(0, 200) }); label += `(${inp.skill || inp.command})`; }
      else if (/^mcp__/.test(c.name)) { const short = c.name.replace(/^mcp__.*?__/, ''); out.mcpCalls.push(short); if (WF.test(c.name)) out.workflowCalls.push({ tool: short, input: JSON.stringify(inp).slice(0, 600) }); label = 'mcp:' + short; }
      else if (c.name === 'Agent' || c.name === 'Task') { out.agentCalls.push({ subagent_type: inp.subagent_type, description: inp.description }); label += `(${inp.subagent_type || ''})`; }
      else if (c.name === 'Read' && /claude-plugin|agent-governance/.test(inp.file_path || '')) { out.pluginDocReads.push(inp.file_path); label += `(plugin:${path.basename(inp.file_path)})`; }
      else if (c.name === 'Bash') label += `(${String(inp.command || '').slice(0, 80)})`;
      else if (c.name === 'ToolSearch') label += `(${String(inp.query || '').slice(0, 80)})`;
      else if (inp.file_path) label += `(${path.basename(inp.file_path)})`;
      out.toolOrder.push(label);
    }
  } else if (e.type === 'user') {
    const cont = e.message?.content;
    const texts = typeof cont === 'string' ? [cont] : (cont || []).filter(c => c.type === 'text').map(c => c.text);
    for (const t of texts) { const m = t.match(/<command-name>\/?([^<]+)<\/command-name>/); if (m) out.slashCommandSkills.push(m[1]); }
    for (const c of Array.isArray(cont) ? cont : []) if (c.type === 'tool_result' && c.is_error) out.toolErrors.push(String(typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 400));
  } else if (e.type === 'result') {
    out.result = { subtype: e.subtype, num_turns: e.num_turns, is_error: e.is_error, stop_reason: e.stop_reason, terminal_reason: e.terminal_reason, duration_ms: e.duration_ms, total_cost_usd: e.total_cost_usd, text: (e.result || '').slice(0, 3000) };
    out.permissionDenials = e.permission_denials;
  }
}
const tp = path.join(dir, 'transcript.jsonl');
out.transcriptCollected = fs.existsSync(tp);
if (out.transcriptCollected) for (const l of fs.readFileSync(tp, 'utf8').split('\n')) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  const c = e?.message?.content;
  if (e.type === 'user' && typeof c === 'string') { const m = c.match(/<command-name>\/?([^<]+)<\/command-name>/); if (m && !out.slashCommandSkills.includes(m[1])) out.slashCommandSkills.push(m[1]); }
}
out.sessionIdMatchesRequested = out.init ? out.init.session_id === out.requested_session_id : null;
out.usedAgsSkills = [...new Set(out.skillCalls.map(s => s.skill).filter(Boolean).concat(out.slashCommandSkills))];
console.log(JSON.stringify(out, null, 1));
