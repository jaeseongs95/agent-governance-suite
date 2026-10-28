import childProcess from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.env.AGENT_GOVERNANCE_D254_IDLE_FIXTURE;
if (!root) throw new Error('Owned idle fixture directory required.');
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

const sendEvent = (message) => {
  if (typeof process.send === 'function' && process.connected) {
    try { process.send(message); } catch { /* Parent already disconnected. */ }
  }
};

let idleTick;
const originalInterval = globalThis.setInterval;
globalThis.setInterval = (callback, milliseconds, ...args) => {
  if (milliseconds === 5000) {
    if (idleTick) throw new Error('Unexpected second idle interval.');
    idleTick = callback;
    writeFileSync(path.join(root, 'idle-interval'), String(milliseconds));
    sendEvent({ type: 'idle-interval', milliseconds });
  }
  return originalInterval(callback, milliseconds, ...args);
};

const execFile = childProcess.execFile;
const activeQueries = new Map();
const activeChildCloses = new Set();

const holdChildSource = `
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const dir = process.argv[1];
writeFileSync(path.join(dir, 'native-query-pid'), String(process.pid));
process.stderr.write('READY\\n');
process.stdin.once('data', () => {
  process.stdout.write('fixture-parent-birth\\n');
  process.exit(0);
});
process.stdin.resume();
`;

childProcess.execFile = function (executable, args, options, callback) {
  const pid = executable === 'powershell.exe'
    ? [424242, 424243].find(value => args.some(arg => typeof arg === 'string' && arg.includes(`GetProcessById(${value})`))) : undefined;
  if (!pid) return execFile.call(this, executable, args, options, callback);
  const directory = path.join(root, String(pid));
  mkdirSync(directory, { recursive: true });
  const sub = execFile.call(
    this,
    process.execPath,
    ['-e', holdChildSource, directory],
    { ...options, stdio: ['pipe', 'pipe', 'pipe'] },
    (error, stdout, stderr) => {
      activeQueries.delete(pid);
      const status = error ? 'error' : 'success';
      writeFileSync(path.join(directory, 'finished'), status);
      sendEvent({ type: 'query-finished', pid, status });
      callback(error, stdout, stderr);
    },
  );
  activeQueries.set(pid, sub);
  const closed = once(sub, 'close').catch(() => {}).finally(() => activeChildCloses.delete(closed));
  activeChildCloses.add(closed);
  sub.stderr?.once('data', () => {
    sendEvent({ type: 'query-started', pid, nativePid: sub.pid });
  });
  return sub;
};
syncBuiltinESMExports();

const realExit = process.exit.bind(process);
process.exit = (code = 0) => {
  if (activeChildCloses.size === 0) return realExit(code);
  void Promise.allSettled([...activeChildCloses]).then(() => realExit(code));
};

process.on('message', (command) => {
  if (!command || typeof command !== 'object') return;
  if (command.type === 'release') {
    const pid = command.pid;
    const directory = path.join(root, String(pid));
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'release-query'), '1');
    const sub = activeQueries.get(pid);
    try { sub?.stdin?.end('1\n'); } catch { /* Child already closed. */ }
    return;
  }
  if (command.type === 'control') {
    if (command.advanceMs) offset += command.advanceMs;
    if (command.tick) idleTick();
    writeFileSync(path.join(root, 'command-ack'), String(command.id));
    sendEvent({ type: 'control-ack', id: command.id });
    if (command.signal) process.emit('SIGTERM');
  }
});
