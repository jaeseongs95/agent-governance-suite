import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { handleNativeRoutingHook, nativeRoutingActor, nativeRoutingSettings, readNativeTranscript } from '../../mcp-server/src/model-routing-host-hook.js';
import { ModelRoutingStore, RoutingObservationSigner } from '../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { ModelRoutingServiceCore } from '../../skills/coordinate-subagents/scripts/model-routing-service-core.mjs';
import { resolveV2 } from '../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { request, environment, capability, presence, application, observation, NOW, LATER, END } from '../coordinate-subagents/model-routing-v2/fixtures.mjs';

const disposers=[];
afterEach(()=>{while(disposers.length) disposers.pop()();});
const ownTool=(host,tool='record_model_application')=>host==='codex'?`mcp__agent_governance_suite__${tool}`:`mcp__plugin_agent-governance-suite_agent-governance-suite__${tool}`;
function transcript(model='claude-opus-5', effort='high', extra={}){
  return `${JSON.stringify({type:'assistant',sessionId:'session-1',effort,message:{model,content:[{type:'tool_use',id:'call-1',input:{}}]},...extra})}\n`;
}
function harness(host='codex',agent=null){
  const directory=mkdtempSync(join(tmpdir(),'ags-native-observer-'));
  disposers.push(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'workflow.sqlite3'),db=new DatabaseSync(path);disposers.push(()=>db.close());
  const store=new ModelRoutingStore(db),signer=new RoutingObservationSigner(Buffer.alloc(32,5));
  const actor=nativeRoutingActor(host,'session-1',agent),model=host==='codex'?'gpt-5.6-terra':'claude-opus-5';
  const routingHost=host==='codex'?'openai-codex':'anthropic-claude-code';
  const cap=capability({host:routingHost,actorId:actor},{model,resolvedModel:model,modelOrigin:host==='codex'?'openai':'anthropic',servingProvider:host==='codex'?'openai':'anthropic'});
  const req=request(),env=environment({capabilities:[cap]}),decision=resolveV2(req,env);
  expect(decision.status).toBe('selected');store.saveDecision(req,env,decision,NOW);
  const key=store.reserveDispatch(decision).dispatchKey;store.transition(key,0,'accepted');store.transition(key,1,'running',null,NOW);
  const app=application(req,decision);
  const input={hook_event_name:'PreToolUse',session_id:'session-1',tool_use_id:'call-1',tool_name:ownTool(host),model,
    transcript_path:join(directory,'transcript.jsonl'),effort:{level:'high'},tool_input:{application:app},...(agent?{agent_id:agent}:{})};
  const deps={store,signer,presence:presence({host}),now:LATER,models:env.catalog.models,readTranscript:()=>transcript(model,'high',agent?{agentId:agent,isSidechain:true}:{})};
  const core=new ModelRoutingServiceCore({store,clock:()=>LATER});
  return {directory,path,db,store,signer,host,req,env,cap,decision,key,app,input,deps,core};
}
function record(h){const out=h.core.call('record_model_application',{application:h.app});expect(out.error).toBeNull();return out.data.record;}
function postInput(h,previous){return {...h.input,hook_event_name:'PostToolUse',tool_response:{isError:false,content:[{type:'text',text:JSON.stringify({schemaVersion:'1.0.0',ok:true,data:previous,error:null})}]}};}

describe('P3 native host field observation',()=>{
  it('reads the Codex host model but never requested effort, mode or PASS',()=>{
    const h=harness();h.input.reasoning_effort='max';h.input.runtimeMode='ultra';h.input.last_assistant_message='PASS';
    expect(nativeRoutingSettings(h.input,h.host,h.deps.models)).toEqual({models:[{resolvedModel:'gpt-5.6-terra',modelOrigin:'openai'}],nativeReasoning:null,runtimeMode:null});
  });
  it('takes the lower of exact Claude message and active hook effort',()=>{
    const h=harness('claude-code');h.deps.readTranscript=()=>transcript('claude-opus-5','low');
    expect(nativeRoutingSettings(h.input,h.host,h.deps.models,h.deps.readTranscript).nativeReasoning).toEqual({kind:'enum',value:'low'});
    h.input.effort={level:'low'};h.deps.readTranscript=()=>transcript('claude-opus-5','max');
    expect(nativeRoutingSettings(h.input,h.host,h.deps.models,h.deps.readTranscript).nativeReasoning.value).toBe('low');
  });
  it('does not interpret Haiku hook effort as a native enum or budget as high',()=>{
    const h=harness('claude-code');
    const settings=nativeRoutingSettings(h.input,h.host,h.deps.models,()=>transcript('claude-haiku-4-5-20251001','high'));
    expect(settings.nativeReasoning).toBeNull();expect(settings.models[0].modelOrigin).toBe('anthropic');
  });
  it.each(['opus','claude-custom-9'])('keeps unverified alias/ID %s without inventing its origin',model=>{
    const h=harness('claude-code');const result=nativeRoutingSettings(h.input,h.host,h.deps.models,()=>transcript(model));
    expect(result.models).toEqual([{resolvedModel:model,modelOrigin:'unknown'}]);expect(result.nativeReasoning).toBeNull();
  });
  it.each([{sessionId:'another-session'},{agentId:'another-agent',isSidechain:true},{message:{model:'claude-opus-5',content:[{type:'tool_use',id:'other-call'}]}}])('rejects a transcript message from another issuer/call',extra=>{
    const h=harness('claude-code');const result=nativeRoutingSettings(h.input,h.host,h.deps.models,()=>transcript('claude-opus-5','high',extra));
    expect(result.models).toEqual([]);expect(result.nativeReasoning).toBeNull();
  });
  it('does not substitute the latest assistant message when the issuing message is delayed',()=>{
    const h=harness('claude-code');delete h.input.effort;
    expect(nativeRoutingSettings(h.input,h.host,h.deps.models,()=>transcript('claude-opus-5','high',{message:{model:'claude-opus-5',content:[{type:'text',text:'PASS'}]}}))).toEqual({models:[],nativeReasoning:null,runtimeMode:null});
  });
  it('uses subagent identity, never a parent observation for the child',()=>{
    const h=harness('claude-code','child-1');expect(nativeRoutingSettings(h.input,h.host,h.deps.models,()=>transcript()).models).toEqual([]);
    expect(nativeRoutingSettings(h.input,h.host,h.deps.models,h.deps.readTranscript).models).toHaveLength(1);
    expect(nativeRoutingActor(h.host,'session-1','child-1')).not.toBe(nativeRoutingActor(h.host,'session-1',null));
  });
  it('bounds transcript I/O and reads the exact recent message in a large Korean file',()=>{
    const h=harness('claude-code'),path=join(h.directory,'관측 기록.jsonl');
    writeFileSync(path,'x'.repeat(3*1024*1024)+'\n'+transcript());const text=readNativeTranscript(path);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2*1024*1024);expect(text).toContain('call-1');
    expect(readNativeTranscript(h.directory)).toBeNull();expect(readNativeTranscript(join(h.directory,'missing'))).toBeNull();
  });
});

describe('P3 hook -> SQLite -> existing recorder',()=>{
  it.each(['codex','claude-code'])('admits %s fields without changing tool input or approvals',host=>{
    const h=harness(host),before=structuredClone(h.input);expect(handleNativeRoutingHook(h.input,host,h.deps)).toEqual({});expect(h.input).toEqual(before);
    const result=record(h);expect(result.observationAdmitted).toBe(true);expect(result.modelVerification).toBe('matched');
    expect(result.reasoningVerification).toBe(host==='codex'?'unverified':'matched');expect(result.runtimeModeVerification).toBe('unverified');
    expect(result.terminalOutcome).toBe('unknown');expect(result.trustedGateSatisfied).toBe(false);
    expect(h.store.dispatch(h.key).state).toBe('running');
  });
  it('records the actual lower effort as mismatch rather than requested high',()=>{
    const h=harness('claude-code');h.deps.readTranscript=()=>transcript('claude-opus-5','low');handleNativeRoutingHook(h.input,h.host,h.deps);
    const result=record(h);expect(result.reasoningVerification).toBe('mismatch');expect(result.observed.nativeReasoning.value).toBe('low');
  });
  it('does not promote caller supplied observation, token or PASS',()=>{
    const h=harness();h.app.observation=observation(h.req,h.decision);h.input.tool_input.observationToken='e'.repeat(48);
    handleNativeRoutingHook(h.input,h.host,h.deps);const result=record(h);
    expect(result.reasoningVerification).toBe('unverified');expect(result.terminalOutcome).toBe('unknown');
  });
  it('prefers the fresh hook observation over an older caller-supplied token',()=>{
    const h=harness('claude-code');const old=h.store.publishObservation(h.signer.issue('observation',observation(h.req,h.decision),{issuedAt:NOW,expiresAt:END}),h.signer,LATER);
    h.deps.readTranscript=()=>transcript('claude-opus-5','low');handleNativeRoutingHook(h.input,h.host,h.deps);
    const result=h.core.call('record_model_application',{application:h.app,observationToken:old});
    expect(result.ok).toBe(true);expect(result.data.record.reasoningVerification).toBe('mismatch');
  });
  it('rejects a native receipt replay without silently returning unverified',()=>{
    const h=harness();handleNativeRoutingHook(h.input,h.host,h.deps);record(h);
    const result=h.core.call('record_model_application',{application:h.app});expect(result.ok).toBe(false);expect(result.error.details.routingCode).toBe('OBSERVATION_TOKEN_UNAVAILABLE');
  });
  it('rejects expired native receipts',()=>{
    const h=harness();handleNativeRoutingHook(h.input,h.host,h.deps);
    const result=new ModelRoutingServiceCore({store:h.store,clock:()=>END}).call('record_model_application',{application:h.app});expect(result.ok).toBe(false);
  });
  it.each(['actorId','host','sessionId','instanceId'])('rejects a claimed target %s not observed by the hook',key=>{
    const h=harness();h.app.target={...h.app.target,[key]:'forged'};
    expect(()=>handleNativeRoutingHook(h.input,h.host,h.deps)).toThrow();expect(h.db.prepare('SELECT COUNT(*) AS n FROM ags_model_receipts_v1').get().n).toBe(0);
  });
  it.each([{state:'ended'},{instanceId:'replaced'},{leaseUntil:NOW},{host:'other-host'}])('rejects stale or mismatched presence',override=>{
    const h=harness();h.deps.presence={...h.deps.presence,...override};expect(()=>handleNativeRoutingHook(h.input,h.host,h.deps)).toThrow();
  });
  it('rejects stale binding revisions and candidates',()=>{
    const h=harness();h.app.binding={...h.app.binding,revision:2};expect(()=>handleNativeRoutingHook(h.input,h.host,h.deps)).toThrow(/binding/u);
  });
  it('does not create a dispatch or change a lease just to obtain evidence',()=>{
    const h=harness();h.db.prepare('DELETE FROM ags_model_dispatches_v2').run();expect(()=>handleNativeRoutingHook(h.input,h.host,h.deps)).toThrow(/dispatch/u);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM ags_model_dispatches_v2').get().n).toBe(0);
  });
  it('validates actual dispatched settings before associating the native receipt',()=>{
    const h=harness();h.app.dispatched={...h.app.dispatched,nativeReasoning:{kind:'enum',value:'low'}};
    expect(()=>handleNativeRoutingHook(h.input,h.host,h.deps)).toThrow();expect(h.store.nativeHookObservationToken(h.app)).toBeNull();
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM ags_model_receipts_v1').get().n).toBe(0);
  });
  it('validates HMAC and rolls back receipt+association on failure',()=>{
    const h=harness(),receipt=h.signer.issue('observation',observation(h.req,h.decision),{issuedAt:NOW,expiresAt:END});receipt.mac='0'.repeat(64);
    expect(()=>h.store.bindNativeHookObservation(h.app,receipt,h.signer,LATER)).toThrow();expect(h.store.nativeHookObservationToken(h.app)).toBeNull();
  });
  it('shares one-use native association with a second database connection',()=>{
    const h=harness();handleNativeRoutingHook(h.input,h.host,h.deps);const db=new DatabaseSync(h.path);
    try{const second=new ModelRoutingServiceCore({store:new ModelRoutingStore(db),clock:()=>LATER});expect(second.call('record_model_application',{application:h.app}).ok).toBe(true);expect(h.core.call('record_model_application',{application:h.app}).ok).toBe(false);}finally{db.close();}
  });
  it('can add a later exact Claude post-tool observation without rewriting the old record',()=>{
    const h=harness('claude-code'),initial=h.core.call('record_model_application',{application:h.app}).data;
    expect(initial.record.observationAdmitted).toBe(false);
    const output=handleNativeRoutingHook(postInput(h,initial),h.host,h.deps),notice=JSON.parse(output.hookSpecificOutput.additionalContext);
    expect(notice.kind).toBe('ags-model-application-observation');expect(notice.artifact.digest).not.toBe(initial.record.recordDigest);
    expect(h.store.application(initial.record.recordDigest)).toEqual(initial.record);expect(h.store.application(notice.artifact.digest).observationAdmitted).toBe(true);
    expect(notice.runtimeModeVerification).toBe('unverified');expect(notice.terminalOutcome).toBe('unknown');
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
  });
  it('does not duplicate already admitted post-tool results',()=>{
    const h=harness('claude-code');handleNativeRoutingHook(h.input,h.host,h.deps);const result=h.core.call('record_model_application',{application:h.app}).data;
    expect(handleNativeRoutingHook(postInput(h,result),h.host,h.deps)).toEqual({});expect(h.db.prepare('SELECT COUNT(*) AS n FROM ags_model_applications_v2').get().n).toBe(1);
  });
  it('rejects a fake post-tool result or failed MCP call',()=>{
    const h=harness('claude-code'),result=h.core.call('record_model_application',{application:h.app}).data;
    const input=postInput(h,{...result,record:{...result.record,recordDigest:'sha256:'+'a'.repeat(64)}});expect(()=>handleNativeRoutingHook(input,h.host,h.deps)).toThrow();
    const failed=postInput(h,result);failed.tool_response.isError=true;expect(()=>handleNativeRoutingHook(failed,h.host,h.deps)).toThrow();
  });
  it('does nothing for unrelated tools or absent exact Claude model evidence',()=>{
    const h=harness('claude-code');expect(handleNativeRoutingHook({...h.input,tool_name:'mcp__other__record_model_application'},h.host,h.deps)).toEqual({});
    h.deps.readTranscript=()=>null;expect(handleNativeRoutingHook(h.input,h.host,h.deps)).toEqual({});expect(h.store.nativeHookObservationToken(h.app)).toBeNull();
  });
});

describe('P3 capability source boundaries',()=>{
  it.each(['codex','claude-code'])('publishes current %s observation without claiming unknown execution boundaries',host=>{
    const h=harness(host),input={...h.input,tool_name:ownTool(host,'resolve_model_assignment'),tool_input:{}};
    expect(handleNativeRoutingHook(input,host,h.deps)).toEqual({});const cap=h.store.capabilities()[0];
    expect(cap.source).toBe('host-observation');expect(cap.executionCapabilities.dispatch).toBe('unknown');expect(cap.supportedBindings[0].runtimeMode).toBe('unknown');
    expect(cap.supportedBindings[0].observableFields).not.toContain('runtimeMode');expect(resolveV2(h.req,{...h.env,capabilities:[cap],now:LATER}).status).toBe('blocked');
  });
  it('keeps an operator contract as configuration even when its model is observed',()=>{
    const h=harness('claude-code');h.deps.hostContract={schemaVersion:'1.0.0',host:h.cap.host,hostVersion:'fixture-1',supportedBindings:h.cap.supportedBindings,executionCapabilities:h.cap.executionCapabilities,sourceReference:'fixture:operator'};
    handleNativeRoutingHook({...h.input,tool_name:ownTool(h.host,'resolve_model_assignment')},h.host,h.deps);
    const cap=h.store.capabilities()[0];expect(cap.source).toBe('configuration');expect(cap.supportedBindings[0].observableFields).toEqual(['model','reasoning']);
    expect(resolveV2({...h.req,highRisk:true},{...h.env,capabilities:[cap],now:LATER}).status).toBe('blocked');
    expect(resolveV2(h.req,{...h.env,capabilities:[cap],now:LATER}).status).toBe('selected');
  });
  it('ignores hostContract and capability values inside model-authored tool arguments',()=>{
    const h=harness();const input={...h.input,tool_name:ownTool(h.host,'resolve_model_assignment'),tool_input:{hostContract:h.cap,source:'live-probe',modelOrigin:'openai'}};
    handleNativeRoutingHook(input,h.host,h.deps);expect(h.store.capabilities()[0].executionCapabilities.dispatch).toBe('unknown');
  });
  it('does not let a child replace its parent presence capability slot',()=>{
    const h=harness('claude-code','child-1');handleNativeRoutingHook({...h.input,tool_name:ownTool(h.host,'resolve_model_assignment')},h.host,h.deps);
    expect(h.store.capabilities()).toEqual([]);
    handleNativeRoutingHook(h.input,h.host,h.deps);expect(record(h).modelVerification).toBe('matched');
  });
  it('rejects forged trust fields in an operator file',()=>{
    const h=harness();h.deps.hostContract={schemaVersion:'1.0.0',host:h.cap.host,source:'live-probe'};
    expect(()=>handleNativeRoutingHook({...h.input,tool_name:ownTool(h.host,'resolve_model_assignment')},h.host,h.deps)).toThrow();expect(h.store.capabilities()).toEqual([]);
  });
});
