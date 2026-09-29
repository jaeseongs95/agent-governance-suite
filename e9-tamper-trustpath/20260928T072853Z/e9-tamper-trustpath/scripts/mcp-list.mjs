import { spawn } from 'node:child_process';
const [server] = process.argv.slice(2);
const c = spawn(process.execPath, [server], { env: { PATH: process.env.PATH, HOME: '/tmp/mcp-home' }, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; c.stdout.on('data', d => { buf += d; for (const line of buf.split('\n').slice(0, -1)) { const m = JSON.parse(line);
  if (m.id === 2) { const names = m.result.tools.map(t => t.name); console.log('tools', names.length, JSON.stringify(names)); console.log('reconcile-like:', names.filter(n => /reconcil|wake|history/i.test(n))); c.kill(); } }
  buf = buf.slice(buf.lastIndexOf('\n') + 1); });
const send = m => c.stdin.write(JSON.stringify(m) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'j2', version: '0' } } });
setTimeout(() => { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); }, 500);
setTimeout(() => { console.log('TIMEOUT'); c.kill(); }, 10000);
