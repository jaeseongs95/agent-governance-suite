import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { requestSessionMessageOnce } from "../../mcp-server/src/session-message-client.js";
import { processStartToken } from "../../mcp-server/src/process-identity.js";
import { failureContext } from "../../mcp-server/src/failure-diagnostics.js";
import { sendOwnedBrokerRequest } from "./fixtures/d0254-owned-request.js";
const resources: Array<{root: string;child: ChildProcess}> = [];
// A hang guard only: it ends a stalled wait and reports the observed phase. No verdict is decided by elapsed time.
const HANG_GUARD_MS=20_000;
const running=(child:ChildProcess)=>child.exitCode===null&&child.signalCode===null;
const exited=(child:ChildProcess)=>running(child)?once(child,"exit").then(()=>undefined):Promise.resolve();
const guardDeadlineNs=()=>String(process.hrtime.bigint()+BigInt(HANG_GUARD_MS)*1_000_000n);
const hangGuardError=(phase:string,observe:()=>unknown)=>new Error(`D0350 hang guard expired in ${phase}: ${JSON.stringify(observe())}`);
async function waitForState(condition:()=>boolean,phase:string,observe:()=>unknown) {
  const guard=performance.now()+HANG_GUARD_MS;
  while(!condition()) {
    if(performance.now()>=guard)throw hangGuardError(phase,observe);
    await delay(10);
  }
}
async function settleUnderGuard<T>(work:Promise<T>,phase:string,observe:()=>unknown):Promise<T> {
  let timer:NodeJS.Timeout|undefined;
  try {
    return await Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(hangGuardError(phase,observe)),HANG_GUARD_MS);})]);
  } finally {clearTimeout(timer);}
}
afterEach(async () => {
  for(const {root,child} of resources.splice(0)) {
    writeFileSync(path.join(root,"release-query"),"1");
    if(running(child)) {const closed=once(child,"close");child.kill();await closed;}
    const nativePidPath=path.join(root,"native-query-pid");
    if(existsSync(nativePidPath)) {
      const nativePid=Number(readFileSync(nativePidPath,"utf8"));
      // Preserve this owned fixture's release flag if the child did not finish.
      await waitForState(()=>!alive(nativePid),"cleanup.native-child-exit",()=>({nativePid}));
      expect(alive(nativePid)).toBe(false);
    }
    rmSync(root,{recursive:true,force:true});
  }
});
function alive(pid:number) {try {process.kill(pid,0);return true;}catch{return false;}}
function start(extraArgs: string[]=[],bootDelay=0,lateQuery=false,nativeQuery=false) {
  const root=mkdtempSync(path.join(tmpdir(),"ags-d254-broker-")),state=path.join(root,"state");
  const events: Array<{phase:string;atNs:string;code:number|null|undefined;signal:NodeJS.Signals|null|undefined}>=[];
  const stamp=(phase:string,code?:number|null,signal?:NodeJS.Signals|null)=>events.push({phase,atNs:String(process.hrtime.bigint()),code,signal});
  stamp("spawn-requested");
  const fixture=new URL("./fixtures/d0254-query-gate.mjs",import.meta.url).href;
  const broker=fileURLToPath(new URL("../../mcp-server/src/session-message-broker.ts",import.meta.url));
  const child=spawn(process.execPath,["--import","tsx","--import",fixture,broker,"--state-directory",state,"--startup-diagnostic",...extraArgs],{
    windowsHide:true,stdio:["ignore","pipe","pipe","pipe"],env:{...process.env,AGENT_GOVERNANCE_D254_FIXTURE_DIR:root,AGENT_GOVERNANCE_D254_BOOT_DELAY_MS:String(bootDelay),AGENT_GOVERNANCE_D254_LATE_QUERY:lateQuery?"1":"0",AGENT_GOVERNANCE_D254_NATIVE_QUERY:nativeQuery?"1":"0"},
  });
  child.once("spawn",()=>stamp("child-spawned"));
  let spawnFailure: ReturnType<typeof failureContext>|undefined;
  child.once("error",error=>{stamp("child-error");spawnFailure=failureContext(error);});
  child.once("exit",(code,signal)=>stamp("child-exit",code,signal));
  child.once("close",(code,signal)=>stamp("child-close",code,signal));
  let stderr="";child.stderr!.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-4096);});child.stdout!.resume();
  // The product's own readiness signal: the broker closes fd 3 once startup resolved, after writing a safe
  // failure code when it failed (session-message-broker.ts entry point, finishDiagnostic).
  const startupDiagnostic=child.stdio[3] as Readable;
  let startupFrame="";
  startupDiagnostic.on("data",chunk=>{startupFrame=(startupFrame+String(chunk)).slice(0,128);});
  const startupSettled=new Promise<void>(resolve=>{
    startupDiagnostic.once("error",()=>stamp("startup-diagnostic-error"));
    startupDiagnostic.once("close",()=>{stamp("startup-diagnostic-closed");resolve();});
    child.once("error",()=>resolve());
  });
  const observe=()=>{
      let phases:unknown={state:"not-observed"},endpoint:unknown={exists:false};
      try {
        const trace=path.join(root,"startup-phases.jsonl");
        if(existsSync(trace)){
          const text=readFileSync(trace,"utf8");
          phases=Buffer.byteLength(text)<=4096?text.trim().split("\n").map(line=>JSON.parse(line)):{state:"overflow"};
        }
      }catch(error){phases={state:"unreadable",failure:failureContext(error)};}
      try {
        const filename=path.join(state,"endpoint.json");
        if(existsSync(filename)){
          endpoint={exists:true,parseable:false};
          const value=JSON.parse(readFileSync(filename,"utf8")) as {pid?:unknown};
          endpoint={exists:true,parseable:true,ownPidMatch:value.pid===child.pid};
        }
      }catch(error){endpoint={exists:true,parseable:false,failure:failureContext(error)};}
    return {clockDomains:{events:"parent",phases:"child"},events:[...events],phases,endpoint,startupFrame:startupFrame.trim(),phaseRecordingFailed:stderr.includes("D0350_PHASE_RECORDING_FAILED"),
      artifacts:Object.fromEntries(["broker.lock","broker-cert.pem","broker.token","session-messages.sqlite3"].map(name=>[name,existsSync(path.join(state,name))])),
      exitCode:child.exitCode,signalCode:child.signalCode,spawnFailure};
  };
  const ownEndpoint=()=>{
    try {return (JSON.parse(readFileSync(path.join(state,"endpoint.json"),"utf8")) as {pid?:unknown}).pid===child.pid;}
    catch {return false;}
  };
  const ready=async()=>{
    try {
      await settleUnderGuard(startupSettled,"startup-diagnostic",observe);
      // An empty closed frame is readiness only with this child's own published endpoint, never a loser or a dying child.
      if(startupFrame===""&&running(child)&&ownEndpoint())return;
      // Not ready: let the child finish so the observation carries its actual exit, not a race with it.
      await settleUnderGuard(exited(child),"startup-failure-exit",observe);
      throw new Error(startupFrame?`The broker reported startup code ${startupFrame.trim()}.`:"The broker closed its startup diagnostic without its own endpoint.");
    }
    catch(cause){
      throw new Error(`D0350 broker fixture readiness failed: ${JSON.stringify({...observe(),failure:failureContext(cause)})}`,{cause});
    }
  };
  resources.push({root,child});return {root,state,child,ready,observe,stderr:()=>stderr};
}
it("an inherited startup deadline includes child initialization and never restarts its budget",async()=>{
  const deadline=String(process.hrtime.bigint()+80_000_000n);
  const {root,state,child,ready,stderr}=start(["--startup-identity-deadline-ns",deadline],200);
  let becameReady=false;
  try {await ready();becameReady=true;} catch {/* Assert the exact producer failure below. */}
  expect(becameReady).toBe(false);
  if(child.exitCode===null)await once(child,"close");
  expect(child.exitCode).toBe(1);
  expect(stderr()).toContain("BROKER_IDENTITY_BUDGET_EXPIRED");
  expect(existsSync(path.join(root,"os-query-started"))).toBe(false);
  expect(existsSync(path.join(state,"endpoint.json"))).toBe(false);
});

it("a failed fixture preload reports bounded startup stages and retains its original readiness failure",async()=>{
  const {root,ready}=start(["--d0350-fail-preload"]);
  let failure:unknown;
  try {await ready();}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(Error);
  const error=failure as Error;
  expect(error.cause).toBeInstanceOf(Error);
  const prefix="D0350 broker fixture readiness failed: ";
  expect(error.message.startsWith(prefix)).toBe(true);
  const diagnostic=JSON.parse(error.message.slice(prefix.length));
  expect(diagnostic).toMatchObject({endpoint:{exists:false},exitCode:1,signalCode:null});
  expect(diagnostic.events).toEqual(expect.arrayContaining([expect.objectContaining({phase:"spawn-requested"}),expect.objectContaining({phase:"child-exit",code:1})]));
  expect(diagnostic.phases).toEqual([{phase:"fixture-enter",atNs:expect.stringMatching(/^\d+$/u)}]);
  // Compare monotonic stamps only within one process; the child has no clock anchor exchange.
  expect(diagnostic.clockDomains).toEqual({events:"parent",phases:"child"});
  for(let index=1;index<diagnostic.events.length;index++){
    expect(BigInt(diagnostic.events[index].atNs)).toBeGreaterThanOrEqual(BigInt(diagnostic.events[index-1].atNs));
  }
  expect(error.message).not.toContain(root);
  expect(error.message).not.toContain("D0350-private-preload-detail");
});

it("a phase writer failure cannot replace the original fixture failure",async()=>{
  const {ready,stderr}=start(["--d0350-fail-phase-write","--d0350-fail-preload"]);
  let failure:unknown;
  try {await ready();}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(Error);
  const error=failure as Error;
  const diagnostic=JSON.parse(error.message.slice("D0350 broker fixture readiness failed: ".length));
  expect(diagnostic).toMatchObject({phaseRecordingFailed:true,phases:{state:"not-observed"},exitCode:1,endpoint:{exists:false}});
  expect(error.cause).toBeInstanceOf(Error);
  expect(stderr()).toContain("D0350-private-preload-detail");
  expect(stderr().split("D0350_PHASE_RECORDING_FAILED")).toHaveLength(2);
  expect(error.message).not.toContain("D0350-private-preload-detail");
});

it.runIf(process.platform==="win32")("a late successful query cannot authorize work after the caller deadline",async()=>{
  const {root,state,child,ready,observe}=start([],0,true);
  await ready();
  const target={host:"portable",sessionId:"d254-late-query"},parentPid=424242,parentStartToken="fixture-parent-birth";
  // The grant's own query is answered at once; only the query armed below is late.
  const grant=await requestSessionMessageOnce<{relayId:string;instanceId:string}>("ensure-relay",{
    target,transport:"portable",parentPid,parentStartToken,identityTimeoutMs:2000,
    wakeVisibility:"user-message",idleWake:"user-message",canWakeSilently:false,supportedInjection:["peer-wake"],
  },state);
  rmSync(path.join(root,"query-started"));rmSync(path.join(root,"query-finished"));
  writeFileSync(path.join(root,"late-query-armed"),"1");
  // This caller deadline only bounds a hung broker. The fixture answers successfully after advancing the broker's
  // monotonic clock past it, so "late" holds by construction rather than by how fast the request travels.
  const request=sendOwnedBrokerRequest(state,"acquire-relay",{target,transport:"portable",relayId:grant.relayId,instanceId:grant.instanceId,parentPid,parentStartToken,pid:child.pid},
    {identityDeadlineNs:guardDeadlineNs()});
  const phase=()=>({...observe(),request:request.state()});
  await waitForState(()=>existsSync(path.join(root,"query-started"))||request.settled(),"late-query.start",phase);
  expect(existsSync(path.join(root,"query-started"))).toBe(true);
  // An ordering oracle: the successful answer has not been produced before the release.
  expect(existsSync(path.join(root,"query-finished"))).toBe(false);
  writeFileSync(path.join(root,"release-query"),"1");
  const reply=await settleUnderGuard(request.response,"late-query.reply",phase);
  expect(existsSync(path.join(root,"query-finished"))).toBe(true);
  expect(reply).toMatchObject({ok:false,error:"The broker identity budget expired."});
});

it("a normal verified relay still requires the exact OS parent generation and accepts its first verified child",async()=>{
  const {state,child,ready}=start();
  await ready();
  const parentStartToken=processStartToken(process.pid);
  expect(typeof parentStartToken).toBe("string");
  const target={host:"portable",sessionId:"d254-normal-verified"};
  const grant=await requestSessionMessageOnce<{spawn:boolean;relayId:string;instanceId:string}>("ensure-relay",{
    target,transport:"portable",parentPid:process.pid,parentStartToken,identityTimeoutMs:2000,
    wakeVisibility:"user-message",idleWake:"user-message",canWakeSilently:false,supportedInjection:["peer-wake"],
  },state);
  expect(grant.spawn).toBe(true);
  const payload={target,transport:"portable",relayId:grant.relayId,instanceId:grant.instanceId,parentPid:process.pid,parentStartToken,pid:child.pid};
  await expect(requestSessionMessageOnce("acquire-relay",payload,state)).resolves.toMatchObject({acquired:true});
  // A budget field never substitutes for the actor's exact observed generation.
  await expect(requestSessionMessageOnce("acquire-relay",{...payload,parentStartToken:"synthetic-different-generation"},state)).resolves.toEqual({acquired:false});
});
it.runIf(process.platform==="win32")("a held OS identity query cannot block another authenticated client ping",async()=>{
  const {root,state,ready,observe}=start();
  await ready();
  const target={host:"portable",sessionId:"d254-owned-request"};
  const parentStartToken="fixture-parent-birth",parentPid=424242;
  const instanceId="host-process-v1:"+createHash("sha256").update(JSON.stringify([target.host,target.sessionId,parentPid,parentStartToken])).digest("hex");
  // The held request carries no 2.5 s client cap; the fixture holds its query until the release below.
  const request=sendOwnedBrokerRequest(state,"acquire-relay",{target,transport:"portable",relayId:"verified-relay-v1:d254-fixture",instanceId,parentPid,parentStartToken,pid:process.pid},
    {identityDeadlineNs:guardDeadlineNs()});
  try {
    await waitForState(()=>existsSync(path.join(root,"query-started"))||request.settled(),"held-query.start",()=>({...observe(),request:request.state()}));
    expect(existsSync(path.join(root,"query-started"))).toBe(true);
    await expect(requestSessionMessageOnce("ping",{},state)).resolves.toHaveProperty("protocolVersion");
    // An ordering oracle, not a timing threshold: the query remains held until this assertion finishes.
    expect(existsSync(path.join(root,"query-finished"))).toBe(false);
  } finally {writeFileSync(path.join(root,"release-query"),"1");await request.response;}
});

it.runIf(process.platform==="win32")("an actual failed OS query remains denied and returns only bounded native diagnostics",async()=>{
  const {state,ready}=start();
  await ready();
  const target={host:"portable",sessionId:"d254-native-failure"},parentPid=2147483647,parentStartToken="synthetic-not-an-OS-birth";
  const instanceId="host-process-v1:"+createHash("sha256").update(JSON.stringify([target.host,target.sessionId,parentPid,parentStartToken])).digest("hex");
  const result=await requestSessionMessageOnce("acquire-relay",{target,transport:"portable",relayId:"verified-relay-v1:d254-native",instanceId,parentPid,parentStartToken,pid:process.pid},state);
  // D0331: the batched query reports this absent PID as its own mapped absence, not a generic query failure.
  expect(result).toMatchObject({acquired:false,diagnostic:{stage:"windows-query",nativeCode:"ESRCH",status:null,signal:null,stderrIndication:null}});
  expect(JSON.stringify(result)).not.toMatch(/synthetic-not-an-OS-birth|2147483647|GetProcessById|StartTime|\\\\Users\\\\|stderr"/u);
});

it.runIf(process.platform==="win32")("graceful broker cleanup cancels its own in-flight native identity child",async()=>{
  const {root,state,child,ready,observe}=start([],0,false,true);
  await ready();
  const target={host:"portable",sessionId:"d254-native-cancel"},parentPid=424242,parentStartToken="fixture-parent-birth";
  const instanceId="host-process-v1:"+createHash("sha256").update(JSON.stringify([target.host,target.sessionId,parentPid,parentStartToken])).digest("hex");
  // No 2.5 s client cap and no runner-speed native timeout: the actual PowerShell child stays in flight until the
  // broker aborts it, so its start-up cost can delay this case but cannot decide it.
  const request=sendOwnedBrokerRequest(state,"acquire-relay",{target,transport:"portable",relayId:"verified-relay-v1:d254-cancel",instanceId,parentPid,parentStartToken,pid:process.pid},
    {identityDeadlineNs:guardDeadlineNs()});
  const pidPath=path.join(root,"native-query-pid"),waitStarted=performance.now();
  const settledPath=path.join(root,"native-query-settled");
  const phase=()=>({...observe(),request:request.state(),nativeAbortRequested:existsSync(path.join(root,"native-abort-requested")),
    nativeQuerySettled:existsSync(settledPath)?readFileSync(settledPath,"utf8"):null});
  // The wait ends on a state: the PID marker, the native query ending without it, or the broker ending. The request
  // socket is not a terminal state here, because the broker keeps its query in flight after a client leaves.
  await waitForState(()=>existsSync(pidPath)||existsSync(settledPath)||!running(child),"native-pid-wait",phase);
  // 진단 I/O 중 늦게 생긴 표식이 원래 단언을 통과시키지 않도록 먼저 판정을 고정한다.
  const pidMarkerPresent=existsSync(pidPath),waitElapsedMs=performance.now()-waitStarted;
  process.stderr.write(`[시험단계] ${JSON.stringify({fixture:"d0254-native-cancel",stage:"native-pid-wait.returned",
    elapsedMs:waitElapsedMs,pidMarkerPresent,request:request.state(),observation:pidMarkerPresent?undefined:phase()})}\n`);
  expect(pidMarkerPresent).toBe(true);
  const nativePid=Number(readFileSync(pidPath,"utf8"));
  expect(Number.isSafeInteger(nativePid)&&nativePid>0).toBe(true);
  expect(alive(nativePid)).toBe(true);
  writeFileSync(path.join(root,"graceful-stop"),"1");
  await settleUnderGuard(exited(child),"graceful-stop.broker-exit",phase);
  expect(child.exitCode).toBe(0);
  await waitForState(()=>!alive(nativePid),"graceful-stop.native-child-exit",()=>({...phase(),nativePid}));
  expect(alive(nativePid)).toBe(false);
  // The broker's own abort reached the in-flight query, and the child did not end by release or by its orphan guard.
  expect(existsSync(path.join(root,"native-abort-requested"))).toBe(true);
  expect(existsSync(path.join(root,"native-guard-expired"))).toBe(false);
  expect(existsSync(settledPath)?JSON.parse(readFileSync(settledPath,"utf8")).aborted:true).toBe(true);
  expect(existsSync(path.join(root,"release-query"))).toBe(false);
  expect(existsSync(path.join(state,"endpoint.json"))).toBe(false);
  await request.response;
});
