import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
const directory = process.env.AGENT_GOVERNANCE_D254_LOCK_ROOT;
const mode = process.env.AGENT_GOVERNANCE_D254_LOCK_CRASH;
if (!directory || !['before-marker', 'after-marker', 'published', 'publish-failure'].includes(mode)) throw new Error('Owned lock crash fixture required.');
const mkdir = fs.mkdirSync, rename = fs.renameSync;
const failure = Object.freeze(Object.assign(new Error('Controlled publication failure.'), { code: 'EIO' }));
fs.mkdirSync = function (target, options) {
  const marker = path.basename(String(target)).startsWith('owner-');
  if (marker && mode === 'before-marker') process.exit(42);
  const result = mkdir.call(this, target, options);
  if (marker && mode === 'after-marker') process.exit(43);
  return result;
};
fs.renameSync = function (source, target) {
  if (mode === 'publish-failure') throw failure;
  const result = rename.call(this, source, target);
  if (mode === 'published' && path.basename(String(target)) === 'broker.lock') process.exit(44);
  return result;
};
syncBuiltinESMExports();
const { acquireBrokerProcessLock } = await import('../../../mcp-server/src/broker-process-lock.ts');
try { acquireBrokerProcessLock(path.join(directory, 'broker.lock')); }
catch (error) {
  if (mode === 'publish-failure' && error === failure && fs.readdirSync(directory).length === 0) process.exit(45);
  throw error;
}
throw new Error('Expected crash boundary was not reached.');
