import childProcess from 'node:child_process';
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
// 대상은 잠금 게시 경계다. 자기 시작 시각 조회가 runner의 PowerShell 기동 시간(5000ms 상한)에 묶이지 않게
// 이 프로세스 조회만 고정 토큰으로 격리한다. 다른 PID 조회는 실제 OS 조회 그대로다.
const D254_OWNER_TOKEN = 'd0254-fixture-owner-birth';
const execFileSync = childProcess.execFileSync;
// 조회 대상 인자 위치만 본다. 명령 형식이 바뀌면 격리가 빠지고 부모 시험의 marker hash 단언이 실패한다.
const queriesSelf = (file, args) => Array.isArray(args) && (file === 'ps' ? args[1] === String(process.pid)
  : String(args.at(-1)).includes(`GetProcessById(${process.pid})`));
childProcess.execFileSync = function (file, args, options) {
  if (queriesSelf(file, args)) return D254_OWNER_TOKEN;
  return execFileSync.call(this, file, args, options);
};
syncBuiltinESMExports();
const { acquireBrokerProcessLock } = await import('../../../mcp-server/src/broker-process-lock.ts');
try { acquireBrokerProcessLock(path.join(directory, 'broker.lock')); }
catch (error) {
  if (mode === 'publish-failure' && error === failure && fs.readdirSync(directory).length === 0) process.exit(45);
  throw error;
}
throw new Error('Expected crash boundary was not reached.');
