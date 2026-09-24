import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from '../../mcp-server/src/session-message-client.js';
import { ModelRoutingStore } from '../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { ModelRoutingServiceCore } from '../../skills/coordinate-subagents/scripts/model-routing-service-core.mjs';
import { resolveV2 } from '../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { SqliteWorkflowStore } from '../../mcp-server/src/sqlite-workflow-store.js';
import { nativeRoutingActor } from '../../mcp-server/src/model-routing-host-hook.js';
import { request, environment, capability, application } from '../coordinate-subagents/model-routing-v2/fixtures.mjs';

const root=resolve(import.meta.dirname,'../..');
async function stop(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  child.kill('SIGTERM');
  await Promise.race([once(child,'close'),delay(5000).then(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');})]);
}
async function execute(file,args,input,env,cwd){
  const child=spawn(process.execPath,[file,...args],{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',part=>{stdout+=part;});child.stderr.on('data',part=>{stderr+=part;});
  child.stdin.end(JSON.stringify(input));const timeout=setTimeout(()=>child.kill(),8000);
  try{const [code]=await once(child,'close');return{code,stdout,stderr};}finally{clearTimeout(timeout);}
}

describe('installed native routing observer',()=>{
  it.each(['codex','claude-code'])('connects the installed %s hook to the real TLS broker and workflow DB',async host=>{
    const dir=mkdtempSync(join(tmpdir(),'AGS 한글 native '));let broker=null,workflow=null,db=null;let brokerError='';
    try{
      const install=join(dir,'plugin files'),state=join(dir,'messaging'),data=join(dir,'host data');
      mkdirSync(install,{recursive:true});mkdirSync(data,{recursive:true});
      const source=host==='codex'?root:join(root,'claude-plugin');
      for(const folder of ['contracts','skills','runtime','mcp-server/dist'])cpSync(join(source,folder),join(install,folder),{recursive:true});
      if(host==='claude-code')cpSync(join(source,'hooks'),join(install,'hooks'),{recursive:true});
      expect(existsSync(join(install,'node_modules'))).toBe(false);
      const home=join(dir,'home');
      const env={...process.env,NODE_OPTIONS:'',NODE_PATH:'',HOME:home,USERPROFILE:home,
        LOCALAPPDATA:join(dir,'local'),XDG_STATE_HOME:join(dir,'xdg'),AGENT_GOVERNANCE_SHARED_STATE_DIR:join(dir,'shared'),
        AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR:state,AGENT_GOVERNANCE_DB_PATH:join(data,'workflows.sqlite3'),CLAUDE_PLUGIN_DATA:data};
      broker=spawn(process.execPath,[join(install,'mcp-server/dist/session-message-broker.mjs'),'--state-directory',state],{env,stdio:['ignore','ignore','pipe'],windowsHide:true});
      broker.stderr.on('data',chunk=>{brokerError+=chunk;});
      await waitForSessionMessageBrokerReady(state,broker,6000);
      // Regression: a client closing/resetting after a response must not kill the shared broker.
      for(let i=0;i<6;i++)await requestSessionMessageOnce('ping',{},state);
      await requestSessionMessageOnce('presence-start',{target:{host,sessionId:'session-live-fixture'},instanceId:'instance-fixture',transport:'fixture-contract',wakeVisibility:'none',canWakeSilently:false},state);
      const current=await requestSessionMessageOnce('presence',{target:{host,sessionId:'session-live-fixture'}},state);
      const now=new Date().toISOString(),expires=new Date(Date.now()+60000).toISOString();
      workflow=new SqliteWorkflowStore(env.AGENT_GOVERNANCE_DB_PATH);db=new DatabaseSync(env.AGENT_GOVERNANCE_DB_PATH);const store=new ModelRoutingStore(db);
      const model=host==='codex'?'gpt-5.6-terra':'claude-opus-5',origin=host==='codex'?'openai':'anthropic';
      const cap=capability({host:host==='codex'?'openai-codex':'anthropic-claude-code',actorId:nativeRoutingActor(host,'session-live-fixture',null),sessionId:current.presence.sessionId,instanceId:current.presence.instanceId,observedAt:now,expiresAt:expires},{model,resolvedModel:model,modelOrigin:origin,servingProvider:origin});
      const req=request(),environmentValue=environment({capabilities:[cap],now}),decision=resolveV2(req,environmentValue);
      expect(decision.status).toBe('selected');store.saveDecision(req,environmentValue,decision,now);
      const key=store.reserveDispatch(decision).dispatchKey;store.transition(key,0,'accepted');store.transition(key,1,'running',null,now);
      const app=application(req,decision,{dispatchedAt:now}),transcript=join(dir,'관측 transcript.jsonl');
      writeFileSync(transcript,JSON.stringify({type:'assistant',sessionId:'session-live-fixture',effort:'high',message:{model,content:[{type:'tool_use',id:'tool-fixture'}]}})+'\n');
      const tool=host==='codex'?'mcp__agent_governance_suite__record_model_application':'mcp__plugin_agent-governance-suite_agent-governance-suite__record_model_application';
      const input={hook_event_name:'PreToolUse',session_id:'session-live-fixture',tool_use_id:'tool-fixture',tool_name:tool,model,transcript_path:transcript,effort:{level:'high'},tool_input:{application:app}};
      const executable=join(install,host==='codex'?'mcp-server/dist/model-routing-host-hook.mjs':'hooks/model-routing-host-hook.mjs');
      const args=host==='codex'?['--host','codex']:[];
      const observed=await execute(executable,args,input,host==='claude-code'?{...env,AGENT_GOVERNANCE_DB_PATH:join(dir,'must-not-create-codex.sqlite3')}:env,install);
      expect(existsSync(join(dir,'must-not-create-codex.sqlite3'))).toBe(false);
      expect(observed.code).toBe(0);expect(observed.stdout).toBe('');expect(observed.stderr).not.toContain('unavailable');
      const result=new ModelRoutingServiceCore({store}).call('record_model_application',{application:app});
      expect(result.error).toBeNull();expect(result.data.record.observationAdmitted).toBe(true);expect(result.data.record.modelVerification).toBe('matched');
      expect(result.data.record.runtimeModeVerification).toBe('unverified');expect(result.data.record.terminalOutcome).toBe('unknown');
      expect(store.dispatch(key).state).toBe('running');
      // Existing messaging and ACK are unchanged by the observation path.
      const sent=await requestSessionMessageOnce('send',{sender:{host,sessionId:'session-live-fixture'},target:{host,sessionId:'session-live-fixture'},body:'delta after observation'},state);
      const claimed=await requestSessionMessageOnce('claim',{target:{host,sessionId:'session-live-fixture'}},state);expect(claimed.messages[0].messageId).toBe(sent.messageId);
      const ack=await requestSessionMessageOnce('acknowledge',{target:{host,sessionId:'session-live-fixture'},messageIds:[sent.messageId]},state);expect(ack.acknowledged).toBeGreaterThan(0);
    }catch(error){error.message+=`\nBroker: ${brokerError}, exit ${broker?.exitCode}`;throw error;}finally{db?.close();workflow?.close();if(broker)await stop(broker);rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
  it('registers only the two own routing tools and preserves the legacy attestation matcher',()=>{
    for(const [folder,prefix] of [['','mcp__agent_governance_suite__'],['claude-plugin/','mcp__plugin_agent-governance-suite_agent-governance-suite__']]){
      const hooks=JSON.parse(readFileSync(join(root,folder,'hooks/hooks.json'),'utf8')).hooks;
      const routing=hooks.PreToolUse.filter(entry=>JSON.stringify(entry).includes('model-routing-host-hook'));
      expect(routing).toHaveLength(1);const matcher=new RegExp(routing[0].matcher);
      expect(matcher.test(prefix+'resolve_model_assignment')).toBe(true);expect(matcher.test(prefix+'record_model_application')).toBe(true);
      expect(matcher.test(prefix+'record_stage_result')).toBe(false);expect(matcher.test('mcp__other__record_model_application')).toBe(false);
      expect(hooks.PostToolUse.some(entry=>JSON.stringify(entry).includes('model-routing-host-hook'))).toBe(true);
    }
    const claude=JSON.parse(readFileSync(join(root,'claude-plugin/hooks/hooks.json'),'utf8')).hooks;
    expect(claude.PreToolUse.some(entry=>JSON.stringify(entry).includes('host-attestation-hook.mjs')&&new RegExp(entry.matcher).test('mcp__plugin_agent-governance-suite_agent-governance-suite__record_stage_result'))).toBe(true);
  });
  it('does not create a broker, database or key for unrelated events or absent endpoint',()=>{
    const dir=mkdtempSync(join(tmpdir(),'ags-inert-hook-'));
    try{
      const env={...process.env,AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR:join(dir,'messaging'),AGENT_GOVERNANCE_DB_PATH:join(dir,'workflows.sqlite3')};
      const result=spawnSync(process.execPath,[join(root,'mcp-server/dist/model-routing-host-hook.mjs'),'--host','codex'],{env,input:JSON.stringify({hook_event_name:'PreToolUse',tool_name:'mcp__agent_governance_suite__resolve_model_assignment',session_id:'s-1'}),encoding:'utf8',timeout:5000});
      expect(result.status).toBe(0);expect(result.stdout).toBe('');expect(existsSync(env.AGENT_GOVERNANCE_DB_PATH)).toBe(false);expect(existsSync(env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR)).toBe(false);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});
