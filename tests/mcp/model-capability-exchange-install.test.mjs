import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { ModelRoutingStore } from '../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from '../../mcp-server/src/session-message-client.js';
import { readSharedModelCapabilities, publishSharedModelCapability } from '../../mcp-server/src/model-capability-client.js';
import { capabilitySigner, MODEL_CAPABILITY_FEATURE } from '../../mcp-server/src/session-model-capabilities.js';
import { openModelRoutingService } from '../../mcp-server/src/model-routing-service.js';
import { SqliteWorkflowStore } from '../../mcp-server/src/sqlite-workflow-store.js';
import { WorkflowService } from '../../mcp-server/src/workflow-service.js';
import { InMemoryWorkflowStore } from '../../mcp-server/src/workflow-store.js';
import { FileSkillRegistry } from '../../mcp-server/src/registry.js';
import { ContractValidator } from '../../mcp-server/src/schema-validator.js';
import { createMcpServer } from '../../mcp-server/src/server.js';
import { PluginUpdateService } from '../../mcp-server/src/plugin-update-service.js';
import { InMemoryPluginUpdateStore } from '../../mcp-server/src/plugin-update-store.js';
import { capability, request } from '../coordinate-subagents/model-routing-v2/fixtures.mjs';
const root=resolve(import.meta.dirname,'../..');
const BASE='cef975cbf32fc72496daee037b10a424ccaad4b6';

async function withBroker(run,{legacy=false}={}){
  const directory=mkdtempSync(join(tmpdir(),'AGS 공유 capability ')),state=join(directory,'messaging');
  let file=join(root,'mcp-server/dist/session-message-broker.mjs');
  if(legacy){file=join(directory,'legacy-broker.mjs');writeFileSync(file,execFileSync('git',['show',`${BASE}:mcp-server/dist/session-message-broker.mjs`],{cwd:root,maxBuffer:10*1024*1024}));}
  const env={...process.env,NODE_OPTIONS:'',NODE_PATH:'',AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR:state};
  const child=spawn(process.execPath,[file,'--state-directory',state],{env,stdio:['ignore','ignore','pipe'],windowsHide:true});
  let error='';child.stderr.on('data',chunk=>{error+=chunk;});
  try{await waitForSessionMessageBrokerReady(state,child,6000);return await run({directory,state,env,child});}
  catch(e){e.message+=`\nBroker ${child.exitCode}: ${error}`;throw e;}
  finally{
    if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'close'),timer=setTimeout(()=>child.kill('SIGKILL'),2000);child.kill('SIGTERM');await ended;clearTimeout(timer);}
    rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:50});
  }
}
async function execute(file,args,input,env,cwd){
  const child=spawn(process.execPath,[file,...args],{env,cwd,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let out='',error='';child.stdout.on('data',s=>{out+=s;});child.stderr.on('data',s=>{error+=s;});
  child.stdin.end(JSON.stringify(input));const timer=setTimeout(()=>child.kill(),10000);
  try{const [code]=await once(child,'close');expect(code,error).toBe(0);expect(error).not.toContain('unavailable');return out;}finally{clearTimeout(timer);}
}
async function start(state,identity){return requestSessionMessageOnce('presence-start',{target:identity,instanceId:identity.instanceId,transport:'explicit-fixture',wakeVisibility:'none',canWakeSilently:false},state);}
async function mcp(gateway){
  const validator=new ContractValidator(),workflow=new WorkflowService(new FileSkillRegistry(join(root,'skills/registry.json'),validator),validator,new InMemoryWorkflowStore());
  const server=createMcpServer(workflow,new PluginUpdateService(new InMemoryPluginUpdateStore()),undefined,undefined,undefined,validator,undefined,undefined,undefined,undefined,undefined,gateway);
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();await server.connect(serverTransport);
  const client=new Client({name:'capability-integration',version:'1.0.0'});await client.connect(clientTransport);
  return{client,call:async(input)=>{const response=await client.callTool({name:'resolve_model_assignment',arguments:input});return JSON.parse(response.content[0].text);}};
}

describe('P5 actual TLS capability exchange and MCP resolver',()=>{
  it('connects two installed native publishers with isolated DBs to a third MCP resolver',()=>withBroker(async({directory,state,env})=>{
    const installed=join(directory,'설치 tree');mkdirSync(installed);
    for(const folder of ['contracts','skills','runtime','mcp-server/dist'])cpSync(join(root,folder),join(installed,folder),{recursive:true});
    cpSync(join(root,'claude-overlay/hooks/model-routing-host-hook.mjs'),join(installed,'hooks/model-routing-host-hook.mjs'),{recursive:true});
    expect(existsSync(join(installed,'node_modules'))).toBe(false);
    const identities=[];
    for(const host of ['codex','claude-code']){
      const identity={host,sessionId:`session-${host}`,instanceId:'instance-1'};identities.push(identity);await start(state,identity);
      const data=join(directory,host);mkdirSync(join(data,'model-routing-native'),{recursive:true});
      const routingHost=host==='codex'?'openai-codex':'anthropic-claude-code',model=host==='codex'?'gpt-5.6-terra':'claude-opus-5',origin=host==='codex'?'openai':'anthropic';
      const snapshot=capability({host:routingHost},{model,resolvedModel:model,modelOrigin:origin,servingProvider:origin,invocationSurface:'peer-session'});
      const contract={schemaVersion:'1.0.0',host:routingHost,hostVersion:'fixture-1',supportedBindings:snapshot.supportedBindings,executionCapabilities:snapshot.executionCapabilities,sourceReference:'fixture:operator-not-live'};
      writeFileSync(join(data,'model-routing-native',routingHost+'.json'),JSON.stringify(contract));
      const transcript=join(data,'transcript.jsonl');writeFileSync(transcript,JSON.stringify({type:'assistant',sessionId:identity.sessionId,effort:'high',message:{model,content:[{type:'tool_use',id:'call-fixture'}]}})+'\n');
      const tool=host==='codex'?'mcp__agent_governance_suite__resolve_model_assignment':'mcp__plugin_agent-governance-suite_agent-governance-suite__resolve_model_assignment';
      const input={hook_event_name:'PreToolUse',session_id:identity.sessionId,tool_use_id:'call-fixture',tool_name:tool,model,transcript_path:transcript,effort:{level:'high'},tool_input:{}};
      const executable=join(installed,host==='codex'?'mcp-server/dist/model-routing-host-hook.mjs':'hooks/model-routing-host-hook.mjs');
      expect(await execute(executable,host==='codex'?['--host','codex']:[],input,{...env,AGENT_GOVERNANCE_DB_PATH:join(data,'workflows.sqlite3'),CLAUDE_PLUGIN_DATA:data},installed)).toBe('');
    }
    const shared=await readSharedModelCapabilities(state);expect(shared.status).toBe('available');expect(shared.entries).toHaveLength(2);
    expect(shared.entries.every(e=>e.snapshot.source==='configuration')).toBe(true);
    const consumer=join(directory,'consumer.sqlite3'),workflow=new SqliteWorkflowStore(consumer),opened=openModelRoutingService(consumer,undefined,()=>readSharedModelCapabilities(state));
    const connected=await mcp(opened.service),db=new DatabaseSync(consumer),store=new ModelRoutingStore(db);
    try{
      const input=request({user:{strength:'required',host:'anthropic-claude-code'}}),selected=await connected.call(input);
      expect(selected.error).toBeNull();expect(selected.data).toMatchObject({status:'selected',target:{host:'anthropic-claude-code',sessionId:'session-claude-code'},executionAuthorized:false,trustedGateSatisfied:false});
      expect(store.capabilities()).toEqual([]);expect(store.decision(selected.data.decisionDigest).environment.capabilities).toHaveLength(2);
      expect(db.prepare('SELECT COUNT(*) AS n FROM ags_model_dispatches_v2').get().n).toBe(0);
      expect((await connected.call({...input,capabilities:[capability()]})).ok).toBe(false);
      expect((await connected.call({...input,highRisk:true})).data.status).toBe('blocked');
      await requestSessionMessageOnce('presence-end',{target:identities[1],instanceId:'instance-1',reason:'test'},state);
      expect((await connected.call(input)).data.status).toBe('blocked');
      expect((await connected.call(request())).data.target.host).toBe('openai-codex');
      await start(state,{...identities[0],instanceId:'new-instance'});
      expect((await connected.call(request())).data.status).toBe('blocked');
      const message=await requestSessionMessageOnce('send',{sender:identities[0],target:identities[1],body:'ordinary delta'},state);
      const claims=await requestSessionMessageOnce('claim',{target:identities[1]},state);expect(claims.messages[0].messageId).toBe(message.messageId);
      expect((await requestSessionMessageOnce('acknowledge',{target:identities[1],messageIds:[message.messageId]},state)).acknowledged).toBe(1);
    }finally{await connected.client.close();db.close();opened.close();workflow.close();}
  }));
  it('keeps an actual old broker working with no new command or schema writes',()=>withBroker(async({state})=>{
    expect((await requestSessionMessageOnce('ping',{},state)).capabilities).not.toContain(MODEL_CAPABILITY_FEATURE);
    expect(await readSharedModelCapabilities(state)).toEqual({status:'unsupported',entries:[]});
    const identity={host:'old',sessionId:'old',instanceId:'old'};await start(state,identity);
    expect(await publishSharedModelCapability(capability(),identity,state)).toBe('unsupported');
    const sent=await requestSessionMessageOnce('send',{sender:identity,target:identity,body:'old message'},state);
    expect((await requestSessionMessageOnce('claim',{target:identity},state)).messages[0].messageId).toBe(sent.messageId);
    const db=new DatabaseSync(join(state,'session-messages.sqlite3'),{readOnly:true});
    try{expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'ags_session_model_%'").all()).toEqual([]);}finally{db.close();}
  },{legacy:true}));
  it('rejects unsigned and forged live publications while message delivery stays available',()=>withBroker(async({state})=>{
    const identity={host:'native',sessionId:'s',instanceId:'i'};await start(state,identity);
    const now=new Date().toISOString(),expiresAt=new Date(Date.now()+60000).toISOString(),snapshot=capability({sessionId:'s',instanceId:'i',observedAt:now,expiresAt});
    const signer=capabilitySigner('Z'.repeat(43)),receipt=signer.issue('capability',{schemaVersion:'1.0.0',identity,snapshot},{issuedAt:now,expiresAt});
    await expect(requestSessionMessageOnce('publish-model-capability',{receipt},state)).rejects.toThrow();
    expect((await readSharedModelCapabilities(state)).entries).toEqual([]);
    expect((await requestSessionMessageOnce('send',{sender:identity,target:identity,body:'unchanged'},state)).messageId).toBeTruthy();
  }));
  it('serializes concurrent retries and a capability revocation uses current presence',()=>withBroker(async({state})=>{
    const identity={host:'native',sessionId:'parallel',instanceId:'i'};await start(state,identity);
    const now=new Date().toISOString(),expiresAt=new Date(Date.now()+60000).toISOString(),snapshot=capability({sessionId:identity.sessionId,instanceId:'i',observedAt:now,expiresAt});
    const signer=capabilitySigner(readFileSync(join(state,'broker.token'),'utf8').trim()),receipt=signer.issue('capability',{schemaVersion:'1.0.0',identity,snapshot},{issuedAt:now,expiresAt});
    const results=await Promise.all(Array.from({length:8},()=>requestSessionMessageOnce('publish-model-capability',{receipt},state)));
    expect(results.filter(r=>!r.duplicate)).toHaveLength(1);expect(new Set(results.map(r=>r.revision)).size).toBe(1);
    await requestSessionMessageOnce('presence-end',{target:identity,instanceId:'i',reason:'closed'},state);
    expect((await readSharedModelCapabilities(state)).entries).toEqual([]);
  }));
  it('does not let simultaneous resolver calls share mutable capability input',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'ags-resolve-context-')),path=join(directory,'workflows.sqlite3'),workflow=new SqliteWorkflowStore(path);
    const current=new Date().toISOString(),expires=new Date(Date.now()+60000).toISOString();
    const a=capability({sessionId:'first',observedAt:current,expiresAt:expires}),b=capability({sessionId:'second',observedAt:current,expiresAt:expires});
    let resolveA;const first=new Promise(resolve=>{resolveA=resolve;});let calls=0;
    const opened=openModelRoutingService(path,undefined,()=>++calls===1?first:Promise.resolve({status:'available',entries:[{snapshot:b}]}));
    try{const one=opened.service.resolveFromBroker(request());const two=await opened.service.resolveFromBroker(request());resolveA({status:'available',entries:[{snapshot:a}]});
      expect(two.data.target.sessionId).toBe('second');expect((await one).data.target.sessionId).toBe('first');
    }finally{opened.close();workflow.close();rmSync(directory,{recursive:true,force:true});}
  });
});
