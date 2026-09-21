import { assert, identifier, text, validateSelection } from '../model-routing-core.mjs';
export const GROK_ADAPTER=Object.freeze({host:'grok-build',adapterVersion:'2.5.0',status:'experimental',defaultEnabled:false,
 protocol:'grok-acp-jsonrpc-2026-06',supportedHostVersions:[],liveVerified:false,source:'https://docs.x.ai/build/cli/headless-scripting'});
export function grokArguments(selection,prompt,{sessionId=null,resume=false}={}){
  validateSelection(selection);text(prompt,'prompt',65536);
  assert(selection.runtimeMode==='standard'&&selection.nativeReasoning.kind==='not-exposed','GROK_NATIVE_CONTROL_NOT_DOCUMENTED');
  const args=['--no-auto-update',`--model=${selection.model}`,'--output-format=streaming-json',`--single=${prompt}`];
  if(sessionId!==null){identifier(sessionId,'sessionId');args.push(`${resume?'--resume':'--session-id'}=${sessionId}`);}
  // No --always-approve, no implicit API path, no custom-model-origin assumption.
  return args;
}
/** Grok's generic streaming-json event schema is not invented from Gemini's. */
export function parseUnverifiedGrokStream(events,{exitCode=0}={}){
  assert(Array.isArray(events),'INVALID_INPUT');
  return {host:'grok-build',terminalOutcome:'unknown',reason:'UNREVIEWED_STREAM_EVENT_CONTRACT',exitCode,eventCount:events.length,observedModels:[],nativeReasoning:null,runtimeMode:null};
}
/** Known public ACP response contract. Callers must bind IDs to actual sent requests. */
export class GrokAcpParser {
  constructor(){this.pending=new Map();this.responses=new Map();this.sessionId=null;this.text='';this.terminal=null;this.errors=0;}
  sent(id,method){assert(Number.isSafeInteger(id)&&id>0&&!this.pending.has(id)&&!this.responses.has(id),'RPC_ID_REUSE');this.pending.set(id,method);}
  accept(message){
    assert(message?.jsonrpc==='2.0','RPC_PROTOCOL_ERROR');
    if(typeof message.method==='string'){
      if(Object.hasOwn(message,'id'))return {denyRequest:{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Client-side tools and automatic approvals are not provided by this adapter'}}};
      if(message.method==='session/update'){
        assert(!this.sessionId||message.params?.sessionId===this.sessionId,'RPC_SESSION_MISMATCH');
        const u=message.params?.update;
        if(u?.sessionUpdate==='agent_message_chunk'&&typeof u.content?.text==='string')this.text+=u.content.text;
      }
      assert(Buffer.byteLength(this.text,'utf8')<=4*1024*1024,'OUTPUT_LIMIT');return {notification:true};
    }
    assert(this.pending.has(message.id),'RPC_UNSOLICITED_RESPONSE');const method=this.pending.get(message.id);this.pending.delete(message.id);
    assert((Object.hasOwn(message,'result')?1:0)+(Object.hasOwn(message,'error')?1:0)===1,'RPC_PROTOCOL_ERROR');
    this.responses.set(message.id,message);
    if(message.error){this.errors++;return {error:true,id:message.id};}
    if(method==='session/new'){identifier(message.result.sessionId,'sessionId');this.sessionId=message.result.sessionId;}
    if(method==='session/prompt'){
      assert(this.sessionId&&!this.terminal,'RPC_TERMINAL_CONFLICT');
      assert(typeof message.result.stopReason==='string','RPC_TERMINAL_MISSING');this.terminal=message.result.stopReason;
    }
    return {id:message.id,result:message.result};
  }
  finish({exitCode=0,aborted=false,transportClosedByClient=false}={}){
    const success=this.terminal==='end_turn'&&this.errors===0&&this.pending.size===0&&(exitCode===0||transportClosedByClient)&&!aborted;
    return {host:'grok-build',protocol:GROK_ADAPTER.protocol,terminalOutcome:success?'succeeded':!this.terminal||aborted?'unknown':'failed',
      sessionId:this.sessionId,stopReason:this.terminal,resultText:this.text,observedModels:[],nativeReasoning:null,runtimeMode:null,
      modelVerification:'unverified',pendingRequests:this.pending.size,errorCount:this.errors};
  }
}
