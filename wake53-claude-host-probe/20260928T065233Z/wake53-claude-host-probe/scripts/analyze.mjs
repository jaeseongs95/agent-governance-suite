import fs from 'node:fs';
const f = process.argv[2];
const lines = fs.readFileSync(f,'utf8').split('\n').filter(l=>l.startsWith('{'));
const out = {file:f, init:null, hooks:[], toolUses:[], denials:null, result:null, errors:[]};
for (const l of lines) { let e; try { e = JSON.parse(l);} catch { continue; }
  if (e.type==='system' && e.subtype==='init') {
    out.init = {model:e.model, permissionMode:e.permissionMode, cwd:e.cwd,
      plugins:e.plugins, mcp_servers:e.mcp_servers,
      tools:(e.tools||[]).filter(t=>/agent-governance|Skill/.test(t)), toolCount:(e.tools||[]).length,
      skills:e.skills, slash_commands_count:(e.slash_commands||[]).length, agents:e.agents};
  } else if (e.type==='system' && /hook/.test(e.subtype||'')) {
    out.hooks.push({subtype:e.subtype, hook_name:e.hook_name, hook_event:e.hook_event, exit_code:e.exit_code, outcome:e.outcome, stdout:(e.stdout||'').slice(0,300), stderr:(e.stderr||'').slice(0,300)});
  } else if (e.type==='assistant') {
    for (const c of e.message?.content||[]) if (c.type==='tool_use') out.toolUses.push({name:c.name, input:JSON.stringify(c.input).slice(0,250)});
  } else if (e.type==='user') {
    for (const c of e.message?.content||[]) if (c.type==='tool_result' && c.is_error) out.errors.push(String(typeof c.content==='string'?c.content:JSON.stringify(c.content)).slice(0,300));
  } else if (e.type==='result') {
    out.result = {subtype:e.subtype, num_turns:e.num_turns, is_error:e.is_error, terminal_reason:e.terminal_reason, text:(e.result||'').slice(0,800)}; out.denials = e.permission_denials;
  }
}
console.log(JSON.stringify(out,null,1));
