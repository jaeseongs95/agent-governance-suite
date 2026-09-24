import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import { describe, expect, it } from 'vitest';
import { SqliteWorkflowStore } from '../../mcp-server/src/sqlite-workflow-store.js';
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from '../../mcp-server/src/session-message-client.js';
import { publishSharedModelCapability } from '../../mcp-server/src/model-capability-client.js';
import { createPeerWorkflow } from './peer-handoff-fixtures.mjs';
import { digest } from '../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { loadCatalog } from '../../skills/coordinate-subagents/scripts/model-catalog.mjs';

const root=resolve(import.meta.dirname,'../..');
const source={host:'claude-code',sessionId:'peer-source',instanceId:'source-instance'};
const target={host:'claude-code',sessionId:'peer-target',instanceId:'target-instance'};
async function exec(file,args,input,env,cwd){
  const child=spawn(process.execPath,[file,...args],{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',part=>{stdout+=part;});child.stderr.on('data',part=>{stderr+=part;});
  child.stdin.on('error',()=>{});child.stdin.end(typeof input==='string'?input:JSON.stringify(input));
  const timeout=setTimeout(()=>child.kill('SIGKILL'),12000);
  try{const [code]=await once(child,'close');return{code,stdout,stderr};}finally{clearTimeout(timeout);}
}
async function stop(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  const closed=once(child,'close');child.kill('SIGTERM');
  await Promise.race([closed,delay(2000).then(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');})]);
}
async function withInstall(work){
  const dir=mkdtempSync(join(tmpdir(),'AGS peer 설치 ')),install=join(dir,'plugin files'),state=join(dir,'broker'),data=join(dir,'plugin data');
  let broker=null,h=null;let brokerLog='';
  try{
    mkdirSync(install,{recursive:true});
    for(const folder of ['contracts','skills','runtime','mcp-server/dist','hooks'])cpSync(join(root,'claude-plugin',folder),join(install,folder),{recursive:true});
    expect(existsSync(join(install,'node_modules'))).toBe(false);
    const home=join(dir,'home');
    const env={...process.env,NODE_PATH:'',NODE_OPTIONS:'',HOME:home,USERPROFILE:home,
      LOCALAPPDATA:join(dir,'local'),XDG_STATE_HOME:join(dir,'xdg'),AGENT_GOVERNANCE_SHARED_STATE_DIR:join(dir,'shared'),
      CLAUDE_PLUGIN_DATA:data,AGENT_GOVERNANCE_PEER_ROUTING:'1',
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR:state,AGENT_GOVERNANCE_DB_PATH:join(dir,'must-not-open-foreign.sqlite3'),
      AGENT_GOVERNANCE_TRUST_DB_PATH:join(dir,'trust.sqlite3')};
    broker=spawn(process.execPath,[join(install,'mcp-server/dist/session-message-broker.mjs'),'--state-directory',state],{env,stdio:['ignore','ignore','pipe'],windowsHide:true});
    broker.stderr.on('data',chunk=>{brokerLog+=chunk;});await waitForSessionMessageBrokerReady(state,broker,6000);
    const request=(operation,payload)=>requestSessionMessageOnce(operation,payload,state,2500);
    for(const id of [source,target])await request('presence-start',{target:{host:id.host,sessionId:id.sessionId},instanceId:id.instanceId,transport:'fixture',wakeVisibility:'none',canWakeSilently:false,supportedInjection:['turn-end','tool-boundary'],idleWake:'none'});
    h=createPeerWorkflow(data,{target,now:Date.now(),catalog:loadCatalog({directory:join(install,'skills','coordinate-subagents','references','model-catalog')})});
    expect(await publishSharedModelCapability(h.cap,target,state,{timeoutMs:2500})).toBe('published');
    const cli=(id,operation,payload,extra={})=>exec(join(install,'mcp-server/dist/model-routing-peer-cli.mjs'),['--host',id.host],{operation,nativeContext:{session_id:id.sessionId,instance_id:id.instanceId},payload},{...env,...extra},install);
    const hook=(id,extra={})=>exec(join(install,'hooks/session-message-hook.mjs'),[],{hook_event_name:'Stop',session_id:id.sessionId,stop_hook_active:false},{...env,...extra},install);
    await work({dir,install,state,data,env,h,request,cli,hook});
    expect(existsSync(env.AGENT_GOVERNANCE_DB_PATH)).toBe(false);
  }catch(error){error.message+=`\nBroker: ${brokerLog}`;throw error;}
  finally{h?.close();if(broker)await stop(broker);rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
}

describe('installed opt-in peer handoff over the original TLS spool',()=>{
  it('sends from the CLI, admits in the actual receiving hook and consumes the signed receipt in the sender hook',async()=>{
    await withInstall(async({h,cli,hook,request})=>{
      const before=h.workflow.getRun(h.run.runId);
      const sent=await cli(source,'send',{decisionDigest:h.decision.decisionDigest,delta:'정정: 승인된 파일만 다룬다.',inputReferences:[]});
      expect(sent.code,sent.stderr).toBe(0);const result=JSON.parse(sent.stdout);expect(result.ok).toBe(true);expect(result.data.accepted).toBe(false);
      const packetId=result.data.packetId;
      const received=await hook(target);expect(received.code,received.stderr).toBe(0);
      const context=JSON.parse(received.stdout).hookSpecificOutput.additionalContext;
      expect(context).toContain('untrusted peer context');expect(context).toContain('"handoffState":"accepted"');
      expect(context).toContain('not execution permission');
      expect(h.routing.dispatch(digest({binding:h.req.binding}))).toMatchObject({state:'accepted',dispatched_at:null});
      expect(h.workflow.getRun(h.run.runId)).toEqual(before);
      const acknowledgement=await hook(source);expect(acknowledgement.code,acknowledgement.stderr).toBe(0);
      expect(JSON.parse(acknowledgement.stdout).hookSpecificOutput.additionalContext).toContain('"handoffState":"accepted"');
      const status=JSON.parse((await cli(source,'status',{packetId})).stdout);
      expect(status.data).toMatchObject({accepted:true,executionStarted:false,completed:false,executionAuthorized:false});
      const delivery=await request('status',{sender:source,messageId:packetId});expect(delivery.status.state).toBe('delivered');
      await request('acknowledge',{target,messageIds:[packetId]});
      expect((await request('status',{sender:source,messageId:packetId})).status.state).toBe('acknowledged');
      await request('send',{sender:source,target,body:'ordinary peer message after handoff'});
      expect(JSON.parse((await hook(target)).stdout).hookSpecificOutput.additionalContext).toContain('ordinary peer message after handoff');
    });
  },30000);
  it('checks accepted work from the installed receiver CLI without issuing execution permission',async()=>{
    await withInstall(async({h,cli,hook})=>{
      const sent=await cli(source,'send',{decisionDigest:h.decision.decisionDigest,delta:'실행 전 검사',inputReferences:[]});
      expect(sent.code,sent.stderr).toBe(0);const packetId=JSON.parse(sent.stdout).data.packetId;
      expect((await hook(target)).code).toBe(0);
      const key=digest({binding:h.req.binding}),before=h.routing.dispatch(key),run=h.workflow.getRun(h.run.runId);
      const checked=await cli(target,'preflight',{packetId});expect(checked.code,checked.stderr).toBe(0);
      expect(JSON.parse(checked.stdout)).toMatchObject({ok:true,data:{preflightPassed:true,requiresAtomicStart:true,
        dispatchRevision:1,executionAuthorized:false,executionStarted:false,trustedGateSatisfied:false,completed:false}});
      expect(h.routing.dispatch(key)).toEqual(before);expect(h.workflow.getRun(h.run.runId)).toEqual(run);
      expect((await cli(source,'preflight',{packetId})).code).toBe(1);
      expect((await cli(target,'preflight',{packetId},{AGENT_GOVERNANCE_PEER_ROUTING:'0'})).code).toBe(1);
      const forged=await cli(target,'preflight',{packetId,executionAuthorized:true,token:'never-copy-this'});
      expect(forged.code).toBe(1);expect(forged.stdout).not.toContain('never-copy-this');
      h.routing.transition(key,1,'unknown');
      const blocked=await cli(target,'preflight',{packetId});expect(blocked.code).toBe(1);
      expect(JSON.parse(blocked.stdout)).toMatchObject({ok:false,error:'PEER_HANDOFF_UNAVAILABLE',executionStarted:false});
      expect(h.routing.dispatch(key)).toMatchObject({state:'unknown',revision:2,dispatched_at:null});
    });
  },30000);
  it('grants exactly one installed CLI process the start claim after both read-only preflights pass',async()=>{
    await withInstall(async({h,cli,hook,request})=>{
      const sent=await cli(source,'send',{decisionDigest:h.decision.decisionDigest,delta:'원자적 시작권 검사',inputReferences:[]});
      expect(sent.code,sent.stderr).toBe(0);const packetId=JSON.parse(sent.stdout).data.packetId;
      expect((await hook(target)).code).toBe(0);
      const key=digest({binding:h.req.binding}),run=h.workflow.getRun(h.run.runId),guarded=h.workflow.getGuardedRunBinding(h.run.runId);
      const checks=await Promise.all([cli(target,'preflight',{packetId}),cli(target,'preflight',{packetId})]);
      for(const result of checks)expect(JSON.parse(result.stdout)).toMatchObject({ok:true,data:{preflightPassed:true,dispatchRevision:1}});
      const results=await Promise.all([cli(target,'start',{packetId,expectedRevision:1}),cli(target,'start',{packetId,expectedRevision:1})]);
      expect(results.map(result=>result.code).sort()).toEqual([0,1]);
      const winner=JSON.parse(results.find(result=>result.code===0).stdout);
      expect(winner).toMatchObject({ok:true,data:{startClaimAcquired:true,dispatchState:'running',dispatchRevision:2,
        requiresNativeExecutor:true,executionStarted:false,executionAuthorized:false,trustedGateSatisfied:false,completed:false}});
      expect(h.routing.dispatch(key)).toMatchObject({state:'running',revision:2,dispatched_at:winner.data.dispatchedAt});
      expect(h.workflow.getRun(h.run.runId)).toEqual(run);expect(h.workflow.getGuardedRunBinding(h.run.runId)).toEqual(guarded);
      const before=h.routing.dispatch(key);
      expect((await cli(target,'start',{packetId,expectedRevision:2})).code).toBe(1);
      expect(h.routing.dispatch(key)).toEqual(before);
      expect(h.database.prepare('SELECT COUNT(*) AS n FROM ags_model_applications_v2').get().n).toBe(0);
      await request('send',{sender:source,target,body:'ordinary message after start claim'});
      expect(JSON.parse((await hook(target)).stdout).hookSpecificOutput.additionalContext).toContain('ordinary message after start claim');
    });
  },30000);
  it('rejects caller authority, stale revisions and unknown work on the installed start surface',async()=>{
    await withInstall(async({h,cli,hook,dir})=>{
      const sent=await cli(source,'send',{decisionDigest:h.decision.decisionDigest,delta:'시작권 경계 검사',inputReferences:[]});
      expect(sent.code,sent.stderr).toBe(0);const packetId=JSON.parse(sent.stdout).data.packetId;
      expect((await hook(target)).code).toBe(0);
      const key=digest({binding:h.req.binding}),before=h.routing.dispatch(key);
      for(const payload of [{packetId},{packetId,expectedRevision:'1'},{packetId,expectedRevision:2},
        {packetId,expectedRevision:1,executionAuthorized:true,token:'do-not-copy-start-secret'},
        {packetId,expectedRevision:1,program:'touch',command:join(dir,'must-not-execute')},
        {packetId,expectedRevision:1,approval:true},{packetId,expectedRevision:1,request:h.req}]){
        const result=await cli(target,'start',payload);expect(result.code).toBe(1);
        expect(result.stdout).not.toContain('do-not-copy-start-secret');expect(h.routing.dispatch(key)).toEqual(before);
      }
      expect((await cli(source,'start',{packetId,expectedRevision:1})).code).toBe(1);
      expect((await cli(target,'start',{packetId,expectedRevision:1},{AGENT_GOVERNANCE_PEER_ROUTING:'0'})).code).toBe(1);
      h.routing.transition(key,1,'unknown');
      expect((await cli(target,'start',{packetId,expectedRevision:2})).code).toBe(1);
      expect(h.routing.dispatch(key)).toMatchObject({state:'unknown',revision:2,dispatched_at:null});
      expect(existsSync(join(dir,'must-not-execute'))).toBe(false);
    });
  },30000);
  it('keeps opted-out native sessions on the original untrusted message path',async()=>{
    await withInstall(async({h,cli,hook})=>{
      const sent=await cli(source,'send',{decisionDigest:h.decision.decisionDigest,delta:'조회 참고',inputReferences:[]});expect(JSON.parse(sent.stdout).ok).toBe(true);
      const output=await hook(target,{AGENT_GOVERNANCE_PEER_ROUTING:'0'});expect(output.code).toBe(0);
      const context=JSON.parse(output.stdout).hookSpecificOutput.additionalContext;
      expect(context).toContain('untrusted peer context');expect(context).not.toContain('Native handoff diagnostic');
      expect(h.routing.dispatch(digest({binding:h.req.binding}))).toBeNull();
      expect(h.database.prepare("SELECT COUNT(*) AS n FROM ags_model_peer_transfers_v1 WHERE direction='inbound'").get().n).toBe(0);
    });
  },30000);
  it('rejects an unprepared isolated receiver DB without opening or importing the sender DB',async()=>{
    await withInstall(async({dir,h,cli,hook})=>{
      const isolated=join(dir,'isolated receiver');mkdirSync(isolated);
      const local=new SqliteWorkflowStore(join(isolated,'workflows.sqlite3'));
      try{
        expect(JSON.parse((await cli(source,'send',{decisionDigest:h.decision.decisionDigest,delta:'정정',inputReferences:[]})).stdout).ok).toBe(true);
        const received=await hook(target,{CLAUDE_PLUGIN_DATA:isolated});expect(received.code).toBe(0);
        expect(JSON.parse(received.stdout).hookSpecificOutput.additionalContext).toContain('"handoffState":"rejected"');
        expect(local.getRun(h.run.runId)).toBeNull();expect(h.routing.dispatch(digest({binding:h.req.binding}))).toBeNull();
        const sender=await hook(source);expect(JSON.parse(sender.stdout).hookSpecificOutput.additionalContext).toContain('"handoffState":"rejected"');
      }finally{local.close();}
    });
  },30000);
  it('fails closed without opt-in and never accepts shell commands or body-supplied credentials',async()=>{
    await withInstall(async({dir,install,h,env,cli})=>{
      const disabled=await cli(source,'send',{decisionDigest:h.decision.decisionDigest,delta:'',inputReferences:[]},{AGENT_GOVERNANCE_PEER_ROUTING:'0'});
      expect(disabled.code).toBe(1);expect(JSON.parse(disabled.stdout).error).toBe('PEER_HANDOFF_UNAVAILABLE');
      const malformed=await exec(join(install,'mcp-server/dist/model-routing-peer-cli.mjs'),['--host','claude-code'],
        {operation:'execute',nativeContext:{session_id:source.sessionId},payload:{command:'touch secret',token:'do-not-echo-this'}},env,install);
      expect(malformed.code).toBe(1);expect(malformed.stdout).not.toContain('do-not-echo-this');expect(existsSync(join(dir,'secret'))).toBe(false);
      const config=readFileSync(join(install,'hooks/session-message-hook.mjs'),'utf8');expect(config).toContain('runSessionMessageHook');
    });
  },30000);
});
