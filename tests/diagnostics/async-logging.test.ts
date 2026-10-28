import {beforeAll, expect, it} from "vitest";
import {mkdtemp, cp, readdir, readFile, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
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
const log=await createDiagnostics(readDiagnosticConfig(JSON.stringify({level:'INFO',destination:'file',file:'sustained-case',rotationBytes:1024,retainedFiles:100,bufferBytes:16384})),new Set(['get_skill_inventory']));
await readyAtMost(log);
for(let i=0;i<120;i++){for(let j=0;j<100;j++)log.event('request','INFO','request_start',{method:'get_skill_inventory'});await new Promise(r=>setTimeout(r,10));}
await log.close();console.log(JSON.stringify(log.loss));
`);
  expect(result.code).toBe(0);
  const files=(await readdir(root)).filter(name=>name.startsWith('sustained-case-')&&name.endsWith('.log'));
  const sizes=await Promise.all(files.map(file=>stat(path.join(root,file)).then(value=>value.size)));
  const observation={fixture:root,scenario:'sustained-file-cap',sizes,loss:JSON.parse(result.out)};
  if(process.env.AGENT_GOVERNANCE_LOG_TEST_EVIDENCE) await writeFile(path.join(process.env.AGENT_GOVERNANCE_LOG_TEST_EVIDENCE,'sustained-result.json'),JSON.stringify(observation,null,2),'utf8');
  expect(sizes.filter(size=>size>0).length).toBeGreaterThan(1);expect(sizes.every(size=>size<=1024)).toBe(true);expect(observation.loss.droppedRecords).toBeGreaterThan(0);
});


it("fails closed when the library cannot open the next rotated file",async()=>{
  const result=await execute(`
import {createDiagnostics,readDiagnosticConfig} from './diagnostics.mjs';
import {readdir,mkdir} from 'node:fs/promises';
const log=await createDiagnostics(readDiagnosticConfig(JSON.stringify({level:'INFO',destination:'file',file:'rotation-failure-case',rotationIntervalMs:1000,rotationBytes:2048})),new Set(['get_skill_inventory']));
await readyAtMost(log);
const active=(await readdir('.')).find(name=>name.startsWith('rotation-failure-case-')&&name.endsWith('.log'));
if(!active)throw new Error('ROTATION_FIXTURE_ACTIVE_FILE_MISSING');
await mkdir(active.replace(/[.]([0-9]+)[.]log$/,(_,number)=>'.'+(Number(number)+1)+'.log'));
for(let i=0;i<150&&log.loss.sinkErrors===0;i++){log.event('request','INFO','request_start',{method:'get_skill_inventory'});await new Promise(r=>setTimeout(r,10));}
for(let i=0;i<20;i++)log.event('request','INFO','request_start',{method:'get_skill_inventory'});
await log.close();console.log(JSON.stringify({applicationResult:'unchanged',loss:log.loss}));
`);
  expect(result.code,result.err).toBe(0);const observed=JSON.parse(result.out);
  expect(observed.applicationResult).toBe('unchanged');expect(observed.loss.sinkErrors).toBeGreaterThan(0);expect(observed.loss.droppedRecords).toBeGreaterThan(0);
});
