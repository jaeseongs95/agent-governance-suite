// Clean-room (git archive, no node_modules) MCP initialize/tools/list + execute every hook entry once.
// usage: node cleanroom.mjs <codexRoot> <claudeRoot> <scratch>
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [codexRoot, claudeRoot, scratch] = process.argv.slice(2);
const out = { mcp: {}, hooks: [] };

function sampleFromRegex(re) {
  let s = re.replace(/^\^/, '').replace(/\$$/, '').replace(/\[-_\]/g, '_');
  // replace innermost groups with their first alternative repeatedly
  while (/\(([^()]*)\)/.test(s)) s = s.replace(/\(([^()]*)\)/, (_, g) => g.split('|')[0]);
  return s.replace(/\\/g, '');
}

async function mcp(label, root, env) {
  const child = spawn(process.execPath, [join(root, 'mcp-server/dist/server.mjs')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', err = ''; const waiters = new Map();
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } catch {} } });
  child.stderr.on('data', (d) => { err += d; });
  const req = (id, method, params) => new Promise((res, rej) => { waiters.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => rej(new Error(`timeout ${method}`)), 20000); });
  const r = { label };
  try {
    const init = await req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cleanroom', version: '0' } });
    r.initialize = { ok: !!init.result, serverInfo: init.result?.serverInfo, protocolVersion: init.result?.protocolVersion, error: init.error };
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await req(2, 'tools/list', {});
    const tools = list.result?.tools ?? [];
    r.toolsList = { ok: !!list.result, count: tools.length, names: tools.map((t) => t.name).sort(), refCount: JSON.stringify(tools).split('"$ref"').length - 1, error: list.error };
  } catch (e) { r.error = String(e); }
  child.kill(); r.stderrHead = err.slice(0, 2000);
  return r;
}

function runHook({ host, event, matcher, command, args, shell, env, timeoutSec, cwd }) {
  const tool = matcher && ['PreToolUse', 'PostToolUse'].includes(event) ? sampleFromRegex(matcher) : undefined;
  const payload = { session_id: `cr-${host}-session`, hook_event_name: event, cwd, transcript_path: join(scratch, `${host}-transcript.jsonl`) };
  if (event === 'SessionStart') payload.source = matcher ? sampleFromRegex(matcher) : 'startup';
  if (event === 'SessionEnd') payload.reason = 'exit';
  if (event === 'UserPromptSubmit') payload.prompt = 'clean-room hello';
  if (event === 'PreCompact' || event === 'PostCompact') payload.trigger = 'manual';
  if (event === 'PostModelSwitch') payload.model = 'claude-opus-5-5';
  if (event === 'Stop') payload.stop_hook_active = false;
  if (tool) { payload.tool_name = tool; payload.tool_input = {}; payload.tool_use_id = 'toolu_cleanroom'; if (event === 'PostToolUse') payload.tool_response = {}; }
  if (host === 'codex') { payload.turn_id = 'turn-cr'; payload.model = 'gpt-5-codex'; }
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = shell ? spawn('sh', ['-c', command], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let so = '', se = ''; child.stdout.on('data', (d) => { so += d; }); child.stderr.on('data', (d) => { se += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), (timeoutSec ?? 60) * 1000 + 2000);
    child.on('close', (code, signal) => { clearTimeout(timer);
      let json = null; try { json = so.trim() ? JSON.parse(so) : null; } catch { json = 'UNPARSEABLE'; }
      resolve({ host, event, matcher: matcher ?? null, tool: tool ?? null, command: shell ? command : [command, ...args].join(' '),
        exit: code, signal, ms: Date.now() - t0, timeoutSec: timeoutSec ?? null, withinTimeout: timeoutSec ? (Date.now() - t0) <= timeoutSec * 1000 : null,
        stdoutJson: json === 'UNPARSEABLE' ? 'UNPARSEABLE' : json !== null, stdoutHead: so.slice(0, 600), stderrHead: se.slice(0, 600) }); });
    child.stdin.end(JSON.stringify(payload));
  });
}

const baseEnv = (h) => { const home = join(scratch, `home-${h}`); mkdirSync(home, { recursive: true });
  const e = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(home, '.local/state'), TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'C.UTF-8' }; return e; };
const workspace = join(scratch, 'workspace'); mkdirSync(workspace, { recursive: true });
for (const h of ['codex', 'claude']) writeFileSync(join(scratch, `${h}-transcript.jsonl`), '');

// Codex root
{
  const mcpCfg = JSON.parse(readFileSync(join(codexRoot, '.mcp.json'), 'utf8')).mcpServers['agent-governance-suite'];
  const env = { ...baseEnv('codex'), ...mcpCfg.env };
  out.mcp.codex = await mcp('codex', codexRoot, env);
  const hooks = JSON.parse(readFileSync(join(codexRoot, 'hooks/hooks.json'), 'utf8')).hooks;
  for (const [event, entries] of Object.entries(hooks)) for (const entry of entries) for (const hk of entry.hooks) {
    out.hooks.push(await runHook({ host: 'codex', event, matcher: entry.matcher, command: hk.command, shell: true,
      env: { ...baseEnv('codex'), PLUGIN_ROOT: codexRoot }, timeoutSec: hk.timeout, cwd: workspace }));
  }
}
// Claude root (standalone copy of claude-plugin/)
{
  const manifest = JSON.parse(readFileSync(join(claudeRoot, '.claude-plugin/plugin.json'), 'utf8'));
  const data = join(scratch, 'claude-plugin-data'); mkdirSync(data, { recursive: true });
  const expand = (s) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', claudeRoot).replaceAll('${CLAUDE_PLUGIN_DATA}', data);
  const cfg = manifest.mcpServers['agent-governance-suite'];
  const env = { ...baseEnv('claude'), CLAUDE_PLUGIN_ROOT: claudeRoot, CLAUDE_PLUGIN_DATA: data, ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, expand(v)])) };
  out.mcp.claude = await mcp('claude', claudeRoot, env);
  const hooks = JSON.parse(readFileSync(join(claudeRoot, 'hooks/hooks.json'), 'utf8')).hooks;
  for (const [event, entries] of Object.entries(hooks)) for (const entry of entries) for (const hk of entry.hooks) {
    out.hooks.push(await runHook({ host: 'claude', event, matcher: entry.matcher, command: hk.command, args: (hk.args ?? []).map(expand), shell: false,
      env: { ...baseEnv('claude'), CLAUDE_PLUGIN_ROOT: claudeRoot, CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: workspace }, timeoutSec: hk.timeout, cwd: workspace }));
  }
}
out.summary = { hooks: out.hooks.length, nonZero: out.hooks.filter((h) => h.exit !== 0).length, overTimeout: out.hooks.filter((h) => h.withinTimeout === false).length,
  unparseable: out.hooks.filter((h) => h.stdoutJson === 'UNPARSEABLE').length };
console.log(JSON.stringify(out, null, 2));
