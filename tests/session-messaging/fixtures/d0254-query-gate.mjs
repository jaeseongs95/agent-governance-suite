import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { setInterval, clearInterval } from 'node:timers';
const root=process.env.AGENT_GOVERNANCE_D254_FIXTURE_DIR;
if(!root)throw new Error('Owned fixture directory required.');
// Phase stamps keep the real monotonic clock even when a late query advances the broker's clock below.
const realHrtime=process.hrtime.bigint.bind(process.hrtime);
let phaseCount=0;
let phaseRecordingFailed=false;
const phase=(name)=>{
  if(phaseRecordingFailed)return;
  const index=phaseCount++;
  try {
    if(process.argv.includes('--d0350-fail-phase-write'))throw new Error('Controlled phase writer failure.');
    if(index<=32)fs.appendFileSync(path.join(root,'startup-phases.jsonl'),JSON.stringify({phase:index===32?'trace-truncated':name,atNs:String(realHrtime())})+'\n');
  }catch{
    phaseRecordingFailed=true;
    // Diagnostic I/O must never change the observed operation or replace its error.
    try {fs.writeSync(2,'D0350_PHASE_RECORDING_FAILED\n');}catch{/* No functioning diagnostic sink remains. */}
  }
};
phase('fixture-enter');
if(process.argv.includes('--d0350-fail-preload'))throw new Error('D0350-private-preload-detail');
await delay(Number(process.env.AGENT_GOVERNANCE_D254_BOOT_DELAY_MS??0));
phase('boot-delay-complete');
const started=()=>{phase('controlled-query-begin');writeFileSync(path.join(root,'query-started'),'1');};
const finished=()=>{phase('controlled-query-settled');writeFileSync(path.join(root,'query-finished'),'1');};
const released=()=>existsSync(path.join(root,'release-query'));
const target=(exe,args)=>exe==='powershell.exe'&&args.some(value=>typeof value==='string'&&(value.includes('GetProcessById(424242)')||value.includes('Get-Process -Id 424242')));
// Late mode: queries answer at once until the test arms one; the armed query is held until release and then
// succeeds only after the broker's monotonic clock has passed any finite caller deadline. Lateness is therefore
// produced by construction, not by how fast the runner reaches the broker.
const late=process.env.AGENT_GOVERNANCE_D254_LATE_QUERY==='1';
const armed=()=>existsSync(path.join(root,'late-query-armed'));
let lateOffsetNs=0n;
if(late)Object.defineProperty(process.hrtime,'bigint',{value:()=>realHrtime()+lateOffsetNs,configurable:true,writable:true});
const answerAfterDeadline=()=>{lateOffsetNs+=3_600_000_000_000n;phase('late-clock-advanced');};
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
    if(late){
      const held=armed();
      while(held&&!released())Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      if(held)answerAfterDeadline();
      return 'fixture-parent-birth\n';
    }
    while(!released()){
      if(performance.now()>=end)throw timedOut();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    }
    return 'fixture-parent-birth\n';
  } finally {finished();}
};
// The actual native child is held by its script until release or until the broker aborts it. The broker's own
// native timeout is not forwarded, so the child cannot end by runner-speed expiry before the test stops the broker.
function nativeQuery(exe,options,callback){
  phase('native-query-spawn-requested');
  const held={...options};delete held.timeout;
  options?.signal?.addEventListener('abort',()=>{
    try {writeFileSync(path.join(root,'native-abort-requested'),'1');}catch{/* Observation cannot change the abort. */}
  },{once:true});
  const sub=async.call(this,exe,nativeArgs,held,(error,stdout,stderr)=>{
    // Records an end that was not the broker's abort, so a waiting test observes it as its own phase.
    try {writeFileSync(path.join(root,'native-query-settled'),JSON.stringify({aborted:options?.signal?.aborted===true,code:error?.code??null,killed:error?.killed??null}));}
    catch{/* Observation cannot change the query result. */}
    callback(error,stdout,stderr);
  });
  sub.once('spawn',()=>phase('native-query-spawned'));
  return sub;
}
childProcess.execFile=function(exe,args,options,callback){
  if(!target(exe,args))return async.call(this,exe,args,options,callback);
  if(native)return nativeQuery.call(this,exe,options,callback);
  started();
  // A held query ends only when the test releases it; its broker timeout is not what these cases observe.
  const immediate=late&&!armed();
  const poll=setInterval(()=>{
    if(!immediate&&!released())return;
    clearInterval(poll);
    if(late&&!immediate)answerAfterDeadline();
    finished();callback(null,'fixture-parent-birth\n','');
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
