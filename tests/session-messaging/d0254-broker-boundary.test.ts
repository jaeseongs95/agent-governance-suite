import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import tls from "node:tls";
import { afterEach, expect, it } from "vitest";
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady, SESSION_MESSAGE_PROTOCOL } from "../../mcp-server/src/session-message-client.js";
import { processStartToken } from "../../mcp-server/src/process-identity.js";
import { failureContext } from "../../mcp-server/src/failure-diagnostics.js";
const resources: Array<{root: string;child: ChildProcess}> = [];
afterEach(async () => {
  for(const {root,child} of resources.splice(0)) {
    writeFileSync(path.join(root,"release-query"),"1");
    if(child.exitCode===null&&child.signalCode===null) {const closed=once(child,"close");child.kill();await closed;}
    const nativePidPath=path.join(root,"native-query-pid");
    if(existsSync(nativePidPath)) {
      const nativePid=Number(readFileSync(nativePidPath,"utf8")),until=performance.now()+3000;
      while(alive(nativePid)&&performance.now()<until)await delay(10);
      // Preserve this owned fixture's release flag if the child did not finish.
      expect(alive(nativePid)).toBe(false);
    }
    rmSync(root,{recursive:true,force:true});
  }
});
function alive(pid:number) {try {process.kill(pid,0);return true;}catch{return false;}}
function start(extraArgs: string[]=[],bootDelay=0,lateQuery=0,nativeQuery=false) {
  const root=mkdtempSync(path.join(tmpdir(),"ags-d254-broker-")),state=path.join(root,"state");
  const events: Array<{phase:string;atNs:string;code?:number|null;signal?:NodeJS.Signals|null}>=[];
  const stamp=(phase:string,code?:number|null,signal?:NodeJS.Signals|null)=>events.push({phase,atNs:String(process.hrtime.bigint()),code,signal});
  stamp("spawn-requested");
  const fixture=new URL("./fixtures/d0254-query-gate.mjs",import.meta.url).href;
  const broker=fileURLToPath(new URL("../../mcp-server/src/session-message-broker.ts",import.meta.url));
  const child=spawn(process.execPath,["--import","tsx","--import",fixture,broker,"--state-directory",state,...extraArgs],{
    windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,AGENT_GOVERNANCE_D254_FIXTURE_DIR:root,AGENT_GOVERNANCE_D254_BOOT_DELAY_MS:String(bootDelay),AGENT_GOVERNANCE_D254_LATE_QUERY_MS:String(lateQuery),AGENT_GOVERNANCE_D254_NATIVE_QUERY:nativeQuery?"1":"0"},
  });
  child.once("spawn",()=>stamp("child-spawned"));
  let spawnFailure: ReturnType<typeof failureContext>|undefined;
  child.once("error",error=>{stamp("child-error");spawnFailure=failureContext(error);});
  child.once("exit",(code,signal)=>stamp("child-exit",code,signal));
  child.once("close",(code,signal)=>stamp("child-close",code,signal));
  let stderr="";child.stderr!.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-4096);});child.stdout!.resume();
  const ready=async()=>{
    try {await waitForSessionMessageBrokerReady(state,child,5000);}
    catch(cause){
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
      throw new Error(`D0350 broker fixture readiness failed: ${JSON.stringify({events,phases,endpoint,phaseRecordingFailed:stderr.includes("D0350_PHASE_RECORDING_FAILED"),
        artifacts:Object.fromEntries(["broker.lock","broker-cert.pem","broker.token","session-messages.sqlite3"].map(name=>[name,existsSync(path.join(state,name))])),
        exitCode:child.exitCode,signalCode:child.signalCode,spawnFailure,failure:failureContext(cause)})}`,{cause});
    }
  };
  resources.push({root,child});return {root,state,child,ready,stderr:()=>stderr};
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
  expect(BigInt(diagnostic.phases[0].atNs)).toBeGreaterThanOrEqual(BigInt(diagnostic.events[0].atNs));
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
  const {root,state,child,ready}=start([],0,600);
  await ready();
  const target={host:"portable",sessionId:"d254-late-query"},parentPid=424242,parentStartToken="fixture-parent-birth";
  const grant=await requestSessionMessageOnce<{relayId:string;instanceId:string}>("ensure-relay",{
    target,transport:"portable",parentPid,parentStartToken,identityTimeoutMs:2000,
    wakeVisibility:"user-message",idleWake:"user-message",canWakeSilently:false,supportedInjection:["peer-wake"],
  },state);
  rmSync(path.join(root,"query-started"));rmSync(path.join(root,"query-finished"));
  const endpoint=JSON.parse(readFileSync(path.join(state,"endpoint.json"),"utf8")) as {port:number};
  // Authenticated own loopback fixture. Never log the frame, key, token, or native stderr.
  const token=readFileSync(path.join(state,"broker.token"),"utf8").trim();
  const identityDeadlineNs=String(process.hrtime.bigint()+300_000_000n);
  const reply=await new Promise<Record<string,unknown>>((resolve,reject)=>{
    const socket=tls.connect({host:"127.0.0.1",port:endpoint.port,servername:"localhost",ca:readFileSync(path.join(state,"broker-cert.pem")),rejectUnauthorized:true});
    let data="";const done=(error?:Error,value?:Record<string,unknown>)=>{socket.destroy();if(error)reject(error);else resolve(value!);};
    socket.setTimeout(2500,()=>done(new Error("Owned fixture response deadline expired.")));
    socket.on("error",error=>done(error));
    socket.once("secureConnect",()=>socket.write(JSON.stringify({protocolVersion:SESSION_MESSAGE_PROTOCOL,token,operation:"acquire-relay",identityDeadlineNs,
      payload:{target,transport:"portable",relayId:grant.relayId,instanceId:grant.instanceId,parentPid,parentStartToken,pid:child.pid}})+"\n"));
    socket.on("data",chunk=>{data+=String(chunk);if(data.length>8192)return done(new Error("Owned fixture response exceeded its bound."));if(data.includes("\n"))done(undefined,JSON.parse(data.split("\n")[0]!) as Record<string,unknown>);});
  });
  expect(existsSync(path.join(root,"query-started"))).toBe(true);
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
  const {root,state,ready}=start();
  await ready();
  const target={host:"portable",sessionId:"d254-owned-request"};
  const parentStartToken="fixture-parent-birth",parentPid=424242;
  const instanceId="host-process-v1:"+createHash("sha256").update(JSON.stringify([target.host,target.sessionId,parentPid,parentStartToken])).digest("hex");
  const acquired=requestSessionMessageOnce("acquire-relay",{target,transport:"portable",relayId:"verified-relay-v1:d254-fixture",instanceId,parentPid,parentStartToken,pid:process.pid},state).catch(error=>error);
  try {
    const until=performance.now()+2000;
    while(!existsSync(path.join(root,"query-started"))&&performance.now()<until)await delay(10);
    expect(existsSync(path.join(root,"query-started"))).toBe(true);
    await expect(requestSessionMessageOnce("ping",{},state)).resolves.toHaveProperty("protocolVersion");
    // An ordering oracle, not a timing threshold: the query remains held until this assertion finishes.
    expect(existsSync(path.join(root,"query-finished"))).toBe(false);
  } finally {writeFileSync(path.join(root,"release-query"),"1");await acquired;}
});

it.runIf(process.platform==="win32")("an actual failed OS query remains denied and returns only bounded native diagnostics",async()=>{
  const {state,ready}=start();
  await ready();
  const target={host:"portable",sessionId:"d254-native-failure"},parentPid=2147483647,parentStartToken="synthetic-not-an-OS-birth";
  const instanceId="host-process-v1:"+createHash("sha256").update(JSON.stringify([target.host,target.sessionId,parentPid,parentStartToken])).digest("hex");
  const result=await requestSessionMessageOnce("acquire-relay",{target,transport:"portable",relayId:"verified-relay-v1:d254-native",instanceId,parentPid,parentStartToken,pid:process.pid},state);
  expect(result).toMatchObject({acquired:false,diagnostic:{stage:"windows-query",status:1,signal:null,stderrIndication:"unclassified"}});
  expect(JSON.stringify(result)).not.toMatch(/synthetic-not-an-OS-birth|2147483647|GetProcessById|StartTime|\\\\Users\\\\|stderr"/u);
});

it.runIf(process.platform==="win32")("graceful broker cleanup cancels its own in-flight native identity child",async()=>{
  const {root,state,child,ready}=start([],0,0,true);
  await ready();
  const target={host:"portable",sessionId:"d254-native-cancel"},parentPid=424242,parentStartToken="fixture-parent-birth";
  const instanceId="host-process-v1:"+createHash("sha256").update(JSON.stringify([target.host,target.sessionId,parentPid,parentStartToken])).digest("hex");
  const acquired=requestSessionMessageOnce("acquire-relay",{target,transport:"portable",relayId:"verified-relay-v1:d254-cancel",instanceId,parentPid,parentStartToken,pid:process.pid},state).catch(error=>error);
  const pidPath=path.join(root,"native-query-pid"),startedUntil=performance.now()+2000;
  while(!existsSync(pidPath)&&performance.now()<startedUntil)await delay(10);
  expect(existsSync(pidPath)).toBe(true);
  const nativePid=Number(readFileSync(pidPath,"utf8"));
  expect(Number.isSafeInteger(nativePid)&&nativePid>0).toBe(true);
  expect(alive(nativePid)).toBe(true);
  writeFileSync(path.join(root,"graceful-stop"),"1");
  // The ordinary request bound stays 2500 ms. The native query remains held.
  const stoppedUntil=performance.now()+2500;
  while(child.exitCode===null&&child.signalCode===null&&performance.now()<stoppedUntil)await delay(10);
  expect(child.exitCode).toBe(0);
  while(alive(nativePid)&&performance.now()<stoppedUntil)await delay(10);
  expect(alive(nativePid)).toBe(false);
  expect(existsSync(path.join(root,"release-query"))).toBe(false);
  expect(existsSync(path.join(state,"endpoint.json"))).toBe(false);
  await acquired;
});
