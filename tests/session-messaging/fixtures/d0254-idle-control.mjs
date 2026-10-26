import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setInterval, clearInterval } from 'node:timers';

const root = process.env.AGENT_GOVERNANCE_D254_IDLE_FIXTURE;
if (!root) throw new Error('Owned idle fixture directory required.');
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
let idleTick;
const originalInterval = globalThis.setInterval;
globalThis.setInterval = (callback, milliseconds, ...args) => {
  if (milliseconds === 5000) {
    if (idleTick) throw new Error('Unexpected second idle interval.');
    idleTick = callback;
    writeFileSync(path.join(root, 'idle-interval'), String(milliseconds));
  }
  return originalInterval(callback, milliseconds, ...args);
};
const execFile = childProcess.execFile;
const nativeScript = fileURLToPath(new URL('./d0254-native-query.ps1', import.meta.url));
childProcess.execFile = function (executable, args, options, callback) {
  const pid = executable === 'powershell.exe'
    ? [424242, 424243].find(value => args.some(arg => typeof arg === 'string' && arg.includes(`GetProcessById(${value})`))) : undefined;
  if (!pid) return execFile.call(this, executable, args, options, callback);
  const directory = path.join(root, String(pid));
  mkdirSync(directory, { recursive: true });
  return execFile.call(this, executable, ['-NoProfile', '-NonInteractive', '-File', nativeScript, directory], options,
    (error, stdout, stderr) => {
      writeFileSync(path.join(directory, 'finished'), error ? 'error' : 'success');
      callback(error, stdout, stderr);
    });
};
syncBuiltinESMExports();
let lastCommand = '';
const control = setInterval(() => {
  const commandPath = path.join(root, 'command.json');
  if (!existsSync(commandPath)) return;
  const raw = readFileSync(commandPath, 'utf8');
  if (raw === lastCommand) return;
  let command;
  try { command = JSON.parse(raw); } catch { return; }
  lastCommand = raw;
  if (command.advanceMs) offset += command.advanceMs;
  if (command.signal) process.emit('SIGTERM');
  if (command.tick) idleTick();
  writeFileSync(path.join(root, 'command-ack'), String(command.id));
}, 10);
control.unref();
process.once('exit', () => clearInterval(control));
