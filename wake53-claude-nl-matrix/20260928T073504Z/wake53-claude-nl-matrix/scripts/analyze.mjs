// usage: node analyze.mjs <runs-dir>/<runid>  -> writes analysis.json in that dir, prints summary line
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const meta = fs.readFileSync(path.join(dir, 'meta.txt'), 'utf8');
const m = (k) => (meta.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1] ?? null;
const lines = fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8').split('\n').filter((l) => l.startsWith('{'));
const out = {
  runid: m('runid'), category: m('category'), requestedSessionId: m('session_id'), exit: m('exit') === null ? null : Number(m('exit')),
  init: null, hooks: [], skillTriggerSuggestions: [], skillCalls: [], mcpWorkflowCalls: [], mcpCalls: [], toolOrder: [],
  toolErrors: [], permissionDenials: [], apiErrors: [], result: null, assistantTurns: 0,
};
const WF = /__(plan_workflow|start_workflow|start_guarded_workflow|record_stage_result|finalize_workflow|abort_workflow|claim_workflow_attempt|get_workflow_status|validate_collaboration_decision|open_convergence_root|resolve_convergence_gate|get_convergence_status)$/;
for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  if (e.type === 'system' && e.subtype === 'init') {
    out.init = { session_id: e.session_id, model: e.model, permissionMode: e.permissionMode, cwd: e.cwd,
      plugins: (e.plugins || []).map((p) => `${p.source}${p.version ? '@' + p.version : ''}`),
      mcp_servers: e.mcp_servers, toolCount: (e.tools || []).length,
      agsSkillCount: (e.skills || []).filter((s) => s.startsWith('agent-governance-suite:')).length, skillCount: (e.skills || []).length };
  } else if (e.type === 'system' && /hook/.test(e.subtype || '')) {
    if (e.subtype === 'hook_started') continue;
    const so = String(e.stdout ?? e.output ?? '');
    const h = { subtype: e.subtype, hook_name: e.hook_name, hook_event: e.hook_event, exit_code: e.exit_code, outcome: e.outcome, stdout: so.slice(0, 600), stderr: String(e.stderr || '').slice(0, 300) };
    try {
      const j = JSON.parse(so); const hs = j.hookSpecificOutput || {};
      if (hs.additionalContext) h.additionalContext = hs.additionalContext;
      if (hs.permissionDecision) h.permissionDecision = hs.permissionDecision;
      if (hs.permissionDecisionReason) h.permissionDecisionReason = String(hs.permissionDecisionReason).slice(0, 300);
      if (j.decision) h.decision = j.decision;
      if (j.reason) h.reason = String(j.reason).slice(0, 300);
      if (e.hook_event === 'UserPromptSubmit' && hs.additionalContext) {
        const sk = [...hs.additionalContext.matchAll(/\/agent-governance-suite:([a-z0-9-]+)/g)].map((x) => x[1]);
        out.skillTriggerSuggestions.push(...sk);
      }
    } catch { /* non-json stdout */ }
    out.hooks.push(h);
  } else if (e.type === 'assistant') {
    out.assistantTurns++;
    if (e.error || e.message?.stop_reason === 'error') out.apiErrors.push(String(e.error || '').slice(0, 300));
    for (const c of e.message?.content || []) {
      if (c.type !== 'tool_use') continue;
      const inp = JSON.stringify(c.input);
      out.toolOrder.push(c.name === 'Skill' ? `Skill(${c.input?.skill})` : c.name.replace(/^mcp__plugin_agent-governance-suite_agent-governance-suite__/, 'ags:'));
      if (c.name === 'Skill') out.skillCalls.push({ skill: c.input?.skill, args: String(c.input?.args ?? '').slice(0, 300) });
      if (c.name.startsWith('mcp__plugin_agent-governance-suite')) {
        out.mcpCalls.push({ name: c.name.split('__').pop(), input: inp.slice(0, 300) });
        if (WF.test(c.name)) out.mcpWorkflowCalls.push({ name: c.name.split('__').pop(), input: inp.slice(0, 400) });
      }
      if (c.name === 'Bash') out.toolOrder[out.toolOrder.length - 1] += `[${String(c.input?.command).slice(0, 80)}]`;
    }
  } else if (e.type === 'user') {
    for (const c of e.message?.content || []) if (c.type === 'tool_result' && c.is_error) out.toolErrors.push(String(typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 300));
  } else if (e.type === 'system' && /api_retry|error/.test(e.subtype || '')) {
    out.apiErrors.push(JSON.stringify(e).slice(0, 300));
  } else if (e.type === 'result') {
    out.result = { subtype: e.subtype, num_turns: e.num_turns, is_error: e.is_error, stop_reason: e.stop_reason, terminal_reason: e.terminal_reason, duration_ms: e.duration_ms, total_cost_usd: e.total_cost_usd, text: String(e.result || '').slice(0, 1500) };
    out.permissionDenials = (e.permission_denials || []).map((d) => ({ tool: d.tool_name, input: JSON.stringify(d.tool_input).slice(0, 200) }));
  }
}
out.skillTriggerSuggestions = [...new Set(out.skillTriggerSuggestions)];
out.sessionIdMatches = out.init ? out.init.session_id === out.requestedSessionId : null;
fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ runid: out.runid, exit: out.exit, sidOk: out.sessionIdMatches, model: out.init?.model, perm: out.init?.permissionMode,
  hookSuggest: out.skillTriggerSuggestions, skills: out.skillCalls.map((s) => s.skill), wf: out.mcpWorkflowCalls.map((w) => w.name),
  turns: out.result?.num_turns, end: out.result?.subtype, stop: out.result?.stop_reason, term: out.result?.terminal_reason, denials: out.permissionDenials.length, apiErr: out.apiErrors.length }));
