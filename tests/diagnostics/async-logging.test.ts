import {beforeAll, expect, it} from "vitest";
import {mkdtemp, cp, readdir, readFile, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import {build} from "esbuild";
import {readDiagnosticConfig} from "../../mcp-server/src/diagnostics.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ags-diagnostics-test-"));
  await build({entryPoints: [path.join(repository,"mcp-server/src/diagnostics.ts")], outfile: path.join(root,"diagnostics.mjs"), bundle:true, platform:"node", format:"esm", target:"node24"});
  await cp(process.env.AGENT_GOVERNANCE_LOG_TEST_WORKER ?? path.join(repository,"mcp-server/dist/diagnostics-worker.mjs"),path.join(root,"diagnostics-worker.mjs"));
});

it("rejects malformed config/category/stdout destinations instead of accepting arbitrary options", () => {
  for (const raw of ["[]", "null", "true", "42", JSON.stringify("invalid")]) expect(() => readDiagnosticConfig(raw)).toThrow();
  for (const config of [{destination:"stdout"},{categories:[]},{categories:{request:"VERBOSE"}},{format:"text"},{unknown:"secret"}]) {
    expect(() => readDiagnosticConfig(JSON.stringify(config))).toThrow();
  }
});

async function execute(source:string, consume=true) {
  const script=path.join(root,`case-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(script, `async function readyAtMost(log) {return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("LOGGER_READY_TIMEOUT")),2000);log.ready.then(value=>{clearTimeout(timer);resolve(value);});});}\n${source}`,"utf8");
  return await new Promise<{code:number|null;out:string;err:string;elapsed:number}>((resolve,reject)=>{
    const start=Date.now(), child=spawn(process.execPath,[script],{cwd:root,stdio:["ignore","pipe","pipe"],windowsHide:true});
    let out="",err="";
    child.stdout.on("data",data=>{out+=data;}); if(consume) child.stderr.on("data",data=>{err+=data;});
    const watchdog=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("DIAGNOSTIC_CHILD_EXCEEDED_3000MS"));},3000);
    child.on("error",reject);child.on("exit",code=>{clearTimeout(watchdog);resolve({code,out,err,elapsed:Date.now()-start});});
  });
}

it("library sink logs only registered safe fields and category threshold drops request DEBUG",async()=>{
  const result=await execute(`
import {createDiagnostics,readDiagnosticConfig} from './diagnostics.mjs';
const log=await createDiagnostics(readDiagnosticConfig(JSON.stringify({level:'TRACE',categories:{request:'ERROR'}})),new Set(['get_skill_inventory']));
await readyAtMost(log);
log.event('request','INFO','request_start',{method:'get_skill_inventory',body:'SECRET_BODY'});
log.event('binding','TRACE','binding_check',{method:'get_skill_inventory',proofPresent:true,bindingPresent:false,proof:'SECRET_PROOF',reasonCode:'SECRET_CODE'});
log.event('lifecycle','FATAL','startup_failed',{error:new Error('SECRET_ERROR')});
await new Promise(r=>setTimeout(r,350)); await log.close(); console.log(JSON.stringify(log.loss));
`);
  expect(result.code).toBe(0);
  expect(result.err).toContain('binding_check');expect(result.err).toContain('startup_failed');
  expect(result.err).not.toContain('request_start');expect(result.err).not.toContain('SECRET');
  const events=result.err.trim().split(/\r?\n/).map(line=>JSON.parse(line));
  expect(events.every(event=>event.hookDelivery==='UNKNOWN'&&event.updatedInputApplied==='UNKNOWN')).toBe(true);
});

it("bounded IPC drops under saturation and unread Windows stderr cannot block parent shutdown",async()=>{
  const result=await execute(`
import {createDiagnostics,readDiagnosticConfig} from './diagnostics.mjs';
const log=await createDiagnostics(readDiagnosticConfig(JSON.stringify({level:'TRACE',bufferBytes:16384,flushDeadlineMs:100})),new Set(['get_skill_inventory']));
await readyAtMost(log);
for(let i=0;i<20;i++){for(let j=0;j<1000;j++)log.event('request','INFO','request_start',{method:'get_skill_inventory'});await new Promise(r=>setTimeout(r,10));}
await log.close(); console.log(JSON.stringify(log.loss));
`,false);
  expect(result.code).toBe(0);expect(result.elapsed).toBeLessThan(2000);
  expect(JSON.parse(result.out).droppedRecords).toBeGreaterThan(0);
});

it("file-open failure is isolated from work and stdout remains an application-only channel",async()=>{
  const result=await execute(`
import {createDiagnostics,readDiagnosticConfig} from './diagnostics.mjs';
const log=await createDiagnostics(readDiagnosticConfig(JSON.stringify({level:'INFO',destination:'file',file:'absent/directory/diagnostic'})),new Set(['get_skill_inventory']));
await readyAtMost(log);log.event('request','INFO','request_start',{method:'get_skill_inventory'});await log.close();console.log(JSON.stringify({result:'unchanged',loss:log.loss}));
`);
  expect(result.code).toBe(0);const data=JSON.parse(result.out);expect(data.result).toBe('unchanged');expect(data.loss.sinkErrors).toBeGreaterThan(0);
});


function rotationEvents(contents: string[]): Array<{event: string}> {
  const events = contents.flatMap(data => data.split(/\r?\n/).filter(line => line.trim().length > 0).map(line => JSON.parse(line) as {event: string}));
  expect(events.length).toBeGreaterThan(0);
  return events;
}

it("requires an actual JSON event while permitting empty rotated files", () => {
  expect(() => rotationEvents([" \n", "\t\n"])).toThrow();
  expect(rotationEvents(["", '{"event":"request_start"}\n'])).toEqual([{event: "request_start"}]);
});

it("uses the library rotation and retention for a completed bounded batch",async()=>{
  const result=await execute(`
import {createDiagnostics,readDiagnosticConfig} from './diagnostics.mjs';
const log=await createDiagnostics(readDiagnosticConfig(JSON.stringify({level:'INFO',destination:'file',file:'rotation-case',rotationBytes:2048,rotationIntervalMs:100,retainedFiles:2})),new Set(['get_skill_inventory']));
await readyAtMost(log);
for(let i=0;i<15;i++){for(let j=0;j<30;j++)log.event('request','INFO','request_start',{method:'get_skill_inventory'});await new Promise(r=>setTimeout(r,15));}
await new Promise(r=>setTimeout(r,100));await log.close();console.log(JSON.stringify(log.loss));
`);
  expect(result.code).toBe(0);
  const entries=await readdir(root);
  const files=entries.filter(name=>name.startsWith('rotation-case-')&&name.endsWith('.log'));
  // Distinguish sink/close loss, rotation and filename filtering without changing the original oracle.
  let loss:unknown={state:'invalid-json',bytes:Buffer.byteLength(result.out)};
  try {loss=JSON.parse(result.out);}catch{/* Diagnostic state above preserves a missing/partial child report. */}
  const observation=JSON.stringify({elapsedMs:result.elapsed,loss,files:await Promise.all(entries.map(async name=>({name,bytes:(await stat(path.join(root,name))).size})))});
  expect(files.length,observation).toBeGreaterThan(1);expect(files.length,observation).toBeLessThanOrEqual(3);
  const bytes=await Promise.all(files.map(file=>readFile(path.join(root,file),'utf8')));
  expect(rotationEvents(bytes).every(row=>row.event==='request_start'||row.event==='shutdown_start')).toBe(true);
});


it("keeps each active file within the byte limit under sustained producer traffic",async()=>{
  const result=await execute(`
import {createDiagnostics,readDiagnosticConfig} from './diagnostics.mjs';
const started=performance.now(),timeline=[];
const mark=event=>timeline.push({event,tMs:performance.now()-started});
mark('create-start');
const log=await createDiagnostics(readDiagnosticConfig(JSON.stringify({level:'INFO',destination:'file',file:'sustained-case',rotationBytes:1024,retainedFiles:100,bufferBytes:16384})),new Set(['get_skill_inventory']));
mark('ready-start');
await readyAtMost(log);
mark('ready-complete');
for(let i=0;i<120;i++){for(let j=0;j<100;j++)log.event('request','INFO','request_start',{method:'get_skill_inventory'});await new Promise(r=>setTimeout(r,10));}
mark('producer-complete');mark('close-start');
await log.close();mark('close-complete');console.log(JSON.stringify({loss:log.loss,timeline}));
`);
  const entries=(await readdir(root)).filter(name=>name.startsWith('sustained-case-'));
  const listing=await Promise.all(entries.map(async name=>{
    const metadata=await stat(path.join(root,name));
    const raw=metadata.isFile()?await readFile(path.join(root,name)):null;
    return {name,bytes:metadata.size,mtimeMs:metadata.mtimeMs,type:metadata.isFile()?'file':'other',
      rawBase64:raw?.toString('base64'),lineBytes:raw?.toString('utf8').match(/[^\n]*\n|[^\n]+$/g)?.map(line=>Buffer.byteLength(line))??[]};
  }));
  const files=listing.filter(file=>file.name.endsWith('.log'));
  const sizes=files.map(file=>file.bytes);
  // 파일별 실제 바이트를 보존한다. 준비·생산·종료 시각은 내부 회전 시각의 증거가 아니다.
  const observation={fixture:root,scenario:'sustained-file-cap',sizes,files:listing,child:result};
  const evidence=JSON.stringify(observation);
  if(process.env.AGENT_GOVERNANCE_LOG_TEST_EVIDENCE) await writeFile(path.join(process.env.AGENT_GOVERNANCE_LOG_TEST_EVIDENCE,'sustained-result.json'),JSON.stringify(observation,null,2),'utf8');
  expect(result.code,evidence).toBe(0);
  const observed=JSON.parse(result.out);
  expect(sizes.filter(size=>size>0).length,evidence).toBeGreaterThan(1);expect(sizes.every(size=>size<=1024),evidence).toBe(true);expect(observed.loss.droppedRecords,evidence).toBeGreaterThan(0);
});

it("bounds pending records and accounts for shutdown loss when rotation never becomes ready",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'ags-held-rotation-'));
  await cp(path.join(root,'diagnostics.mjs'),path.join(directory,'diagnostics.mjs'));
  const gate=new URL('./fixtures/rotation-open-gate.mjs',import.meta.url).href;
  const worker=pathToFileURL(path.join(root,'diagnostics-worker.mjs')).href;
  await writeFile(path.join(directory,'diagnostics-worker.mjs'),
    `process.env.AGS_ROTATION_OPEN_GATE=${JSON.stringify(directory)};await import(${JSON.stringify(gate)});await import(${JSON.stringify(worker)});`,'utf8');
  const result=await execute(`
import {createDiagnostics,readDiagnosticConfig} from ${JSON.stringify(pathToFileURL(path.join(directory,'diagnostics.mjs')).href)};
import {readFile} from 'node:fs/promises';
const marker=${JSON.stringify(path.join(directory,'open-held'))};
const log=await createDiagnostics(readDiagnosticConfig(JSON.stringify({level:'INFO',destination:'file',file:${JSON.stringify(path.join(directory,'safe'))},bufferBytes:1024,flushDeadlineMs:1000})),new Set(['get_skill_inventory']));
await readyAtMost(log);
let held;
for(let i=0;i<150;i++){
  try{held=JSON.parse(await readFile(marker,'utf8'));break;}
  catch(error){if(error.code!=='ENOENT')throw error;await new Promise(resolve=>setTimeout(resolve,10));}
}
if(!held)throw new Error('ROTATION_FIXTURE_OPEN_NOT_HELD');
for(let i=0;i<100;i++)log.event('request','INFO','request_start',{method:'get_skill_inventory'});
const closeStarted=performance.now();await log.close();
console.log(JSON.stringify({held,closeElapsedMs:performance.now()-closeStarted,loss:log.loss}));
`);
  const evidence=JSON.stringify({fixture:directory,child:result});
  if(process.env.AGENT_GOVERNANCE_LOG_TEST_EVIDENCE) await writeFile(path.join(process.env.AGENT_GOVERNANCE_LOG_TEST_EVIDENCE,'held-shutdown-result.json'),evidence,'utf8');
  expect(result.code,evidence).toBe(0);
  const observed=JSON.parse(result.out);
  expect(observed.held.error,evidence).toBeNull();
  expect(observed.loss.droppedRecords,evidence).toBeGreaterThan(0);
  expect(observed.loss.unconfirmedRecords,evidence).toBeGreaterThan(0);
  expect(observed.loss.unconfirmedBytes,evidence).toBeGreaterThan(0);
  expect(observed.loss.unconfirmedBytes,evidence).toBeLessThanOrEqual(1024);
  expect(observed.loss.shutdownLossPossible,evidence).toBe(true);
});


it("fails closed when the library cannot open the next rotated file",async()=>{
  const result=await execute(`
import {createDiagnostics,readDiagnosticConfig} from './diagnostics.mjs';
import {readdir,mkdir} from 'node:fs/promises';
const started=performance.now();
const observe=(event,fields={})=>console.error(JSON.stringify({event,tMs:performance.now()-started,...fields}));
const log=await createDiagnostics(readDiagnosticConfig(JSON.stringify({level:'INFO',destination:'file',file:'rotation-failure-case',rotationIntervalMs:1000,rotationBytes:2048})),new Set(['get_skill_inventory']));
observe('ready-start');
await readyAtMost(log);
observe('ready-complete');
const listingStartedMs=performance.now()-started;
const entries=await readdir('.',{withFileTypes:true});
const files=entries.filter(entry=>entry.name.startsWith('rotation-failure-case-')&&entry.name.endsWith('.log'));
observe('listing-complete',{listingStartedMs,files:files.map(entry=>({name:entry.name,type:entry.isFile()?'file':entry.isDirectory()?'directory':'other'}))});
const active=files[0]?.name;
if(!active)throw new Error('ROTATION_FIXTURE_ACTIVE_FILE_MISSING');
const next=active.replace(/[.]([0-9]+)[.]log$/,(_,number)=>'.'+(Number(number)+1)+'.log');
observe('mkdir-start',{active,next});
try {await mkdir(next);observe('mkdir-complete',{next});}
catch(error){observe('mkdir-failed',{next,code:typeof error.code==='string'&&/^E[A-Z0-9_]+$/.test(error.code)?error.code:'UNKNOWN'});throw error;}
for(let i=0;i<150&&log.loss.sinkErrors===0;i++){log.event('request','INFO','request_start',{method:'get_skill_inventory'});await new Promise(r=>setTimeout(r,10));}
for(let i=0;i<20;i++)log.event('request','INFO','request_start',{method:'get_skill_inventory'});
await log.close();console.log(JSON.stringify({applicationResult:'unchanged',loss:log.loss}));
`);
  expect(result.code,result.err).toBe(0);const observed=JSON.parse(result.out);
  expect(observed.applicationResult).toBe('unchanged');expect(observed.loss.sinkErrors).toBeGreaterThan(0);expect(observed.loss.droppedRecords).toBeGreaterThan(0);
});
