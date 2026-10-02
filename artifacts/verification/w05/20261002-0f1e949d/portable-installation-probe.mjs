// Disposable diagnostic only: no repository tests or product implementation are changed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '<candidate>/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '<candidate>/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from '<candidate>/mcp-server/src/session-message-client.ts';
import { SqliteWorkflowStore } from '<candidate>/mcp-server/src/sqlite-workflow-store.ts';
import { DatabaseSync } from 'node:sqlite';

const root = '<candidate>';
const evidence = '<evidence>';
const shipment = JSON.parse(readFileSync(join(evidence,'shipment-tree-files.json')));
const shipmentFiles = new Map(shipment.files.map(f=>[f.path,f]));
const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
const emit = value => console.log(JSON.stringify(value));
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
function files(dir, prefix = '') {
  return readdirSync(join(dir, prefix), {withFileTypes:true}).flatMap(e =>
    e.isDirectory() ? files(dir, join(prefix,e.name)) : [join(prefix,e.name)]).sort();
}
for (const host of ['codex', 'claude-code']) {
  const directory = mkdtempSync('/tmp/ags-w05-public-');
  const install = join(directory, 'installed'), state = join(directory, 'synthetic-state');
  const source = host === 'codex' ? root : join(root,'claude-plugin');
  mkdirSync(install); mkdirSync(state);
  let broker, client, transport, brokerStderr = '', serverStderr = '';
  const home = join(directory,'home');
  const env = {PATH:process.env.PATH, HOME:home, USERPROFILE:home,
    NODE_PATH:'', NODE_OPTIONS:'', XDG_STATE_HOME:join(directory,'xdg'), LOCALAPPDATA:join(directory,'local'),
    AGENT_GOVERNANCE_DB_PATH:join(state,'workflows.sqlite3'),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH:join(state,'continuity.sqlite3'),
    AGENT_GOVERNANCE_TRUST_DB_PATH:join(state,'trust.sqlite3'),
    AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH:join(state,'board.sqlite3'),
    AGENT_GOVERNANCE_SHARED_STATE_DIR:join(state,'shared'),
    AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR:join(state,'messages'),
    AGENT_GOVERNANCE_HOST_ATTESTATION:host,
    ...(host === 'claude-code' ? {CLAUDE_PLUGIN_DATA:state,AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE:'anthropic'} : {})};
  try {
    for (const name of ['contracts','skills','runtime','mcp-server/dist']) cpSync(join(source,name),join(install,name),{recursive:true});
    const hashes = files(install).map(p => ({path:p,sha256:sha(join(install,p)),matchesSource:sha(join(install,p))===sha(join(source,p))}));
    assert(hashes.every(f=>f.matchesSource)); assert(!existsSync(join(install,'node_modules')));
    for(const f of hashes) { const p=host==='codex'?f.path:join('claude-plugin',f.path); assert.equal(f.sha256,shipmentFiles.get(p)?.sha256,p); }
    writeFileSync(join(evidence,host+'-copied-installation.json'),JSON.stringify({host,shipmentTree:shipment.tree,nodeModules:false,files:hashes},null,2)+'\n');
    emit({host,kind:'installed-bytes',copiedFileCount:hashes.length,allMatch:true,nodeModules:false,
      selectedHashes:hashes.filter(f=>['mcp-server/dist/server.mjs','mcp-server/dist/session-message-broker.mjs','mcp-server/dist/session-message-cli.mjs'].includes(f.path)),
      aggregateSha256:createHash('sha256').update(JSON.stringify(hashes)).digest('hex')});
    // Only disposable fixture DB. Prevent the public MCP surface's automatic update lookup.
    const seed = new SqliteWorkflowStore(env.AGENT_GOVERNANCE_DB_PATH);
    seed.putPluginUpdateState({targetId:'agent-governance-suite',currentVersion:version,latestVersion:version,
      latestTag:`v${version}`,latestCommit:'0f1e949d4ca57fe3cc9aac98767d5c0dade79c61',etag:'synthetic-offline',
      comparison:'up-to-date',lastAttemptAt:new Date().toISOString(),lastSuccessfulCheckAt:new Date().toISOString(),
      nextCheckAt:'2099-01-01T00:00:00.000Z',lastNotifiedVersion:null,lastNotifiedAt:null,lastErrorCode:null});
    seed.close();
    broker = spawn(process.execPath,[join(install,'mcp-server/dist/session-message-broker.mjs'),'--state-directory',env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR],{cwd:install,env,stdio:['ignore','pipe','pipe']});
    broker.stderr.on('data',x=>brokerStderr+=x);
    await waitForSessionMessageBrokerReady(env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR,broker,5000);
    const request = (op,payload) => requestSessionMessageOnce(op,payload,env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR);
    const target = {host:'synthetic',sessionId:'target'}, sender = {host:'synthetic',sessionId:'sender'};
    const actor = {...target,instanceId:'fixture-instance'};
    await request('presence-start',{target,instanceId:actor.instanceId,transport:'portable-fixture',wakeVisibility:'none',canWakeSilently:false});
    const unknown = await request('session-activity',{target});
    assert.equal(unknown.activity.activity,'unknown'); emit({host,operation:'TLS session-activity',result:unknown});
    const event = {schemaVersion:'1.0.0',kind:'activity-observation',actor,revision:1,activity:'busy',source:'host-observed',observedAt:new Date().toISOString(),authorityEffect:'none'};
    const outcome = {schemaVersion:'1.0.0',kind:'terminal-outcome',taskId:'synthetic-task',actor,revision:1,result:'COMPLETED',evidenceRefs:['fixture:synthetic'],reportedAt:new Date().toISOString(),authorityEffect:'none'};
    for (const [op,payload,expected] of [
      ['record-session-activity',{event,turnId:'fixture-turn',reporterProof:'synthetic-nonauthority'},'Current activity reporter is unavailable.'],
      ['record-task-outcome',{outcome,reporterProof:'synthetic-nonauthority'},'Current task binding is unavailable.']]) {
      let error; try { await request(op,payload); } catch(e) { error=e.message; }
      assert.equal(error,expected); emit({host,operation:`TLS ${op}`,expectedRejection:true,error});
    }
    transport = new StdioClientTransport({command:process.execPath,args:[join(install,'mcp-server/dist/server.mjs')],cwd:install,env,stderr:'pipe'});
    transport.stderr?.on('data',x=>serverStderr+=x);
    client = new Client({name:'synthetic-public-boundary-probe',version:'1.0.0'});
    await client.connect(transport);
    const call = async (name,args) => {
      const began=performance.now();
      const result=await client.callTool({name,arguments:args});
      const parsed=JSON.parse(result.content.find(x=>x.type==='text').text);
      emit({host,operation:`MCP ${name}`,durationMs:Math.round(performance.now()-began),result:parsed});
      return parsed;
    };
    const args={schemaVersion:'1.0.0',targetHost:target.host,targetSessionId:target.sessionId,_sessionBinding:sender};
    const contactState=await call('get_session_contact_state',args);
    assert.equal(contactState.data.presence.state,'online');assert.equal(contactState.data.activity.activity,'unknown');
    const contact=await call('contact_session',{...args,body:'Synthetic contact only'});
    assert.deepEqual(contact.data,{state:'held',reason:'activity-unknown',messageId:null});
    const rejected=await call('record_session_task_outcome',{schemaVersion:'1.0.0',outcome,reporterProof:'synthetic-nonauthority',_sessionBinding:target});
    assert.equal(rejected.error.code,'MCP_UNAVAILABLE');assert.equal(rejected.error.message,'Current task binding is unavailable.');
    const unbound=await call('record_session_task_outcome',{schemaVersion:'1.0.0',outcome,reporterProof:'synthetic-nonauthority'});
    assert.equal(unbound.error.code,'BINDING_REQUIRED');
    const cliArgs=[join(install,'mcp-server/dist/session-message-cli.mjs')];
    const started=performance.now();
    const cli=spawnSync(process.execPath,cliArgs,{cwd:install,env,encoding:'utf8',timeout:5000,input:JSON.stringify({operation:'record-task-outcome',payload:{outcome,reporterProof:'synthetic-nonauthority'}})});
    assert.equal(cli.status,1);assert.match(cli.stdout,/Unsupported session message operation/);
    emit({host,operation:'public CLI record-task-outcome',command:[process.execPath,...cliArgs],cwd:install,exit:cli.status,durationMs:Math.round(performance.now()-started),stdout:cli.stdout,stderr:cli.stderr});
    const db=new DatabaseSync(join(env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR,'session-messages.sqlite3'),{readOnly:true});
    const counts=Object.fromEntries(['messages','task_outcomes','task_requests','wake_nonces'].map(t=>[t,db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
    db.close();assert(Object.values(counts).every(n=>n===0));emit({host,kind:'disposable-spool-counts',counts});
    const portableCli=(operation,payload)=>{
      const response=spawnSync(process.execPath,cliArgs,{cwd:install,env,encoding:'utf8',timeout:5000,input:JSON.stringify({operation,payload})});
      assert.equal(response.status,0,response.stderr);const result=JSON.parse(response.stdout);assert.equal(result.ok,true);return result.data;
    };
    const unicodeSender={host:'portable-fixture',sessionId:'unicode-sender'},unicodeTarget={host:'portable-fixture',sessionId:'unicode-target'};
    const unicodeBody='한😀'.repeat(580),unicodeIds=[];
    for(let i=0;i<5;i++){
      const {messageId}=portableCli('prepare',{sender:unicodeSender,target:unicodeTarget,body:unicodeBody});unicodeIds.push(messageId);
      portableCli('send',{sender:unicodeSender,messageId});assert.equal(portableCli('send',{sender:unicodeSender,messageId}).duplicate,true);
    }
    const unicodeClaim=portableCli('claim',{target:unicodeTarget});assert.equal(unicodeClaim.messages.length,5);
    for(const m of unicodeClaim.messages)assert.deepEqual(Buffer.from(m.body),Buffer.from(unicodeBody));
    assert.equal(portableCli('acknowledge',{target:unicodeTarget,messageIds:unicodeIds}).acknowledged,5);
    assert.equal(portableCli('pending',{target:unicodeTarget}).count,0);
    emit({host,kind:'portable-cli-unicode',messageCount:5,bodyBytes:Buffer.byteLength(unicodeBody),duplicateReceipts:true,bodyBytesPreserved:true,acknowledged:5,pending:0,nodeModules:false,shipmentTree:shipment.tree});
    assert(hashes.every(f=>sha(join(install,f.path))===f.sha256));emit({host,kind:'installed-bytes-after',unchanged:true});
  } finally {
    if(client)await client.close();if(transport)await transport.close();
    if(broker && broker.exitCode===null && broker.signalCode===null){const stopped=once(broker,'exit');broker.kill('SIGTERM');await stopped;}
    emit({host,kind:'process-stderr',brokerStderr,serverStderr});
    rmSync(directory,{recursive:true,force:true});emit({host,kind:'cleanup',fixtureRemoved:!existsSync(directory)});
  }
}
emit({result:'PASS',scope:'independent executor public-boundary probe; synthetic portable fixture only; no native-host or release qualification'});
