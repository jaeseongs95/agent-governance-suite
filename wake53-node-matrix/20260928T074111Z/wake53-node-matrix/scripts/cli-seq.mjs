// full packaged CLI sequence; run with target node; args: <worktree>
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
const wt = process.argv[2];
const dir = mkdtempSync('/tmp/brkseq-');
const b = spawn(process.execPath, [path.join(wt, 'mcp-server/dist/session-message-broker.mjs'), '--state-directory', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
let berr = ''; b.stderr.on('data', d => berr += d);
await new Promise(r => setTimeout(r, 2000));
const req = (operation, payload) => { const r = spawnSync(process.execPath, [path.join(wt, 'mcp-server/dist/session-message-cli.mjs')], { input: JSON.stringify({ operation, payload }), encoding: 'utf8', timeout: 5000, env: { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: dir } }); console.log(`[${operation}] status=${r.status} stdout=${r.stdout.trim()} stderr=${r.stderr.trim()}`); try { return JSON.parse(r.stdout).data; } catch { return {}; } };
const sender = { host: 'test-sender', sessionId: 'sender' }, target = { host: 'test-target', sessionId: 'target' };
const { messageId } = req('prepare', { sender, target, body: 'Synthetic lifecycle check' });
req('send', { sender, messageId }); req('claim', { target }); req('acknowledge', { target, messageIds: [messageId] }); req('status', { sender, messageId });
b.kill(); await new Promise(r => b.on('exit', r)); console.log('BROKER_STDERR<<' + berr + '>>'); rmSync(dir, { recursive: true, force: true });
