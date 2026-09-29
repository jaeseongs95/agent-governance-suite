// usage: node mcp-probe.mjs <server.mjs> [cwd]
import { spawn } from 'node:child_process';
const [server, cwd] = process.argv.slice(2);
const p = spawn(process.execPath, [server], { cwd: cwd || process.cwd(), env: { ...process.env, AGENT_GOVERNANCE_HOST_ATTESTATION: process.env.AGENT_GOVERNANCE_HOST_ATTESTATION || 'codex' }, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const got = new Map(); let stderr = '';
p.stderr.on('data', d => { stderr += d; });
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; try { const m = JSON.parse(line); if (m.id !== undefined) got.set(m.id, m); } catch { console.log('NONJSON:', line); } } });
const send = m => p.stdin.write(JSON.stringify(m) + '\n');
const wait = (id, ms = 20000) => new Promise((res, rej) => { const t0 = Date.now(); const iv = setInterval(() => { if (got.has(id)) { clearInterval(iv); res(got.get(id)); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout id=' + id)); } }, 20); });
let ok = false;
try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
  const init = await wait(1);
  console.log('INIT', JSON.stringify({ protocolVersion: init.result?.protocolVersion, serverInfo: init.result?.serverInfo, error: init.error }));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tl = await wait(2);
  const names = (tl.result?.tools || []).map(t => t.name).sort();
  console.log('TOOLS_COUNT', names.length);
  console.log('TOOLS', names.join(','));
  if (tl.error) console.log('TOOLS_ERROR', JSON.stringify(tl.error));
  ok = !!init.result && names.length > 0 && !tl.error;
} catch (e) { console.log('PROBE_ERROR', e.message); }
p.stdin.end(); setTimeout(() => p.kill(), 500);
p.on('exit', (c, s) => { console.log('SERVER_EXIT', c, s); if (stderr) console.log('SERVER_STDERR<<\n' + stderr + '\n>>'); console.log('PROBE_RESULT', ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1); });
