import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { waitForSessionMessageBrokerReady } from '../../mcp-server/src/session-message-client.js';
import { producerFailureReason } from '../../mcp-server/src/failure-diagnostics.js';

const dirs: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) { const done = once(c,'close'); c.kill(); await done; }
  for (const d of dirs.splice(0)) await rm(d,{recursive:true,force:true,maxRetries:20,retryDelay:50});
});
async function emptyState(){ const d=await mkdtemp(path.join(os.tmpdir(),'d0298-fd3-')); dirs.push(d); return d; }
function start(code:string) {
  const child=spawn(process.execPath,['-e',code],{windowsHide:true,stdio:['ignore','ignore','ignore','pipe']});
  children.push(child); return child;
}
async function capture(child: ChildProcess, state:string) {
  try { await (waitForSessionMessageBrokerReady as any)(state,child,3000,undefined,child.stdio[3]); throw new Error('unexpected ready'); }
  catch (e) { return e as Error; }
}
it('real broker emits an allowed startup failure and complete fd3 EOF',async()=>{
  const state=await emptyState();
  const broker=fileURLToPath(new URL('../../mcp-server/src/session-message-broker.ts',import.meta.url));
  const child=spawn(process.execPath,['--import','tsx',broker,'--state-directory',state,'--startup-identity-deadline-ns',String(process.hrtime.bigint()+1n),'--startup-diagnostic'],{windowsHide:true,stdio:['ignore','ignore','ignore','pipe']});
  children.push(child);
  const err=await capture(child,state);
  expect(producerFailureReason(err)).toBe('BROKER_EXITED_BEFORE_READY');
  expect(err.message).toContain('startup diagnostic: BROKER_IDENTITY_BUDGET_EXPIRED');
  expect(child.exitCode).toBe(1);
});
it.each([
  ['allowed split',"const f=require('fs');f.writeSync(3,'EAC');f.writeSync(3,'CES\\n');f.closeSync(3);process.exitCode=1;",'EACCES'],
  ['unknown',"const f=require('fs');f.writeSync(3,'PRIVATE_MARKER_TOKEN\\n');f.closeSync(3);process.exitCode=1;",null],
  ['oversize',"const f=require('fs');f.writeSync(3,'X'.repeat(129)+'\\n');f.closeSync(3);process.exitCode=1;",null],
  ['truncated',"const f=require('fs');f.writeSync(3,'EACCES');f.closeSync(3);process.exitCode=1;",null],
  ['multiple',"const f=require('fs');f.writeSync(3,'EACCES\\nEPERM\\n');f.closeSync(3);process.exitCode=1;",null],
])('real child fd3 frame %s is bounded and filtered',async(_name,code,allowed)=>{
  const state=await emptyState(), child=start(code);
  const err=await capture(child,state);
  expect(producerFailureReason(err)).toBe('BROKER_EXITED_BEFORE_READY');
  expect(err.message).toContain('exited before it was ready');
  if (allowed) expect(err.message).toContain('startup diagnostic: '+allowed);
  else expect(err.message).not.toContain('startup diagnostic:');
  expect(err.message).not.toContain('PRIVATE_MARKER_TOKEN');
});
