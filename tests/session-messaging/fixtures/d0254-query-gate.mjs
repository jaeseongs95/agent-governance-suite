import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout, clearTimeout, setInterval, clearInterval } from 'node:timers';
const root=process.env.AGENT_GOVERNANCE_D254_FIXTURE_DIR;
if(!root)throw new Error('Owned fixture directory required.');
let phaseCount=0;
const phase=(name)=>{
  const index=phaseCount++;
  if(index<=32)fs.appendFileSync(path.join(root,'startup-phases.jsonl'),JSON.stringify({phase:index===32?'trace-truncated':name,atNs:String(process.hrtime.bigint())})+'\n');
};
phase('fixture-enter');
if(process.argv.includes('--d0350-fail-preload'))throw new Error('D0350-private-preload-detail');
await delay(Number(process.env.AGENT_GOVERNANCE_D254_BOOT_DELAY_MS??0));
phase('boot-delay-complete');
const started=()=>{phase('controlled-query-begin');writeFileSync(path.join(root,'query-started'),'1');};
const finished=()=>{phase('controlled-query-settled');writeFileSync(path.join(root,'query-finished'),'1');};
const released=()=>existsSync(path.join(root,'release-query'));
const target=(exe,args)=>exe==='powershell.exe'&&args.some(value=>typeof value==='string'&&(value.includes('GetProcessById(424242)')||value.includes('Get-Process -Id 424242')));
const lateMs=Number(process.env.AGENT_GOVERNANCE_D254_LATE_QUERY_MS??0);
const sync=childProcess.execFileSync,async=childProcess.execFile;
const native=process.env.AGENT_GOVERNANCE_D254_NATIVE_QUERY==='1';
const nativeArgs=['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./d0254-native-query.ps1',import.meta.url)),root];
if(native){const stop=setInterval(()=>{if(existsSync(path.join(root,'graceful-stop'))){clearInterval(stop);process.emit('SIGTERM');}},10);stop.unref();}
const timedOut=()=>Object.assign(new Error('Controlled query timed out.'),{code:'ETIMEDOUT',status:null,signal:'SIGTERM'});
childProcess.execFileSync=function(exe,args,options){
  writeFileSync(path.join(root,'os-query-started'),'1');
  if(!target(exe,args))return sync.call(this,exe,args,options);
  if(native)return sync.call(this,exe,nativeArgs,options);
  started();const end=performance.now()+options.timeout;
  try {
    if(lateMs>0){const until=performance.now()+lateMs;while(performance.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);return 'fixture-parent-birth\n';}
    while(!released()){
      if(performance.now()>=end)throw timedOut();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    }
    return 'fixture-parent-birth\n';
  } finally {finished();}
};
childProcess.execFile=function(exe,args,options,callback){
  if(!target(exe,args))return async.call(this,exe,args,options,callback);
  if(native)return async.call(this,exe,nativeArgs,options,callback);
  started();const end=performance.now()+options.timeout;
  if(lateMs>0){const timer=setTimeout(()=>{finished();callback(null,'fixture-parent-birth\n','');},lateMs);return {kill(){clearTimeout(timer);}};}
  const poll=setInterval(()=>{
    if(!released()&&performance.now()<end)return;
    clearInterval(poll);finished();
    if(released())callback(null,'fixture-parent-birth\n','');else callback(timedOut(),'','');
  },10);
  return {kill(){clearInterval(poll);}};
};
const querySync=childProcess.execFileSync;
childProcess.execFileSync=function(...args){
  phase(target(args[0],args[1])?'controlled-sync-begin':'passthrough-sync-begin');
  try {const result=querySync.apply(this,args);phase('sync-returned');return result;}
  catch(error){phase('sync-threw');throw error;}
};
const renameSync=fs.renameSync;
fs.renameSync=function(...args){
  const endpoint=args[1]===path.join(root,'state','endpoint.json');
  if(endpoint)phase('endpoint-publish-begin');
  try {const result=renameSync.apply(this,args);if(endpoint)phase('endpoint-published');return result;}
  catch(error){if(endpoint)phase('endpoint-publish-threw');throw error;}
};
syncBuiltinESMExports();
phase('patches-installed');
