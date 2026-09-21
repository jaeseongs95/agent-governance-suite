import { assert, text, validateSelection, digest } from '../model-routing-core.mjs';

export const GEMINI_ADAPTER = Object.freeze({host:'gemini-cli',adapterVersion:'2.5.0',status:'experimental',defaultEnabled:false,
 protocol:'gemini-stream-json-2026-03',liveVerified:false,supportedHostVersions:[],resumeSupported:false,
 source:'https://geminicli.com/docs/cli/headless/'});
export function geminiArguments(selection,prompt) {
  validateSelection(selection);text(prompt,'prompt',65536);
  assert(selection.runtimeMode==='standard','UNSUPPORTED_RUNTIME_MODE');
  // No CLI flag is invented from Gemini API thinkingBudget/thinkingLevel.
  assert(selection.nativeReasoning.kind==='not-exposed','CLI_REASONING_OVERRIDE_NOT_DOCUMENTED');
  return [`--model=${selection.model}`,'--output-format=stream-json',`--prompt=${prompt}`];
}
/** Strict terminal accounting. Text/model-authored JSON is never parsed as a host event. */
export class GeminiStreamParser {
  constructor(){this.init=null;this.terminal=null;this.errors=[];this.unknown=[];this.text='';this.finalModels=[];this.events=0;}
  accept(event){
    assert(event&&typeof event==='object'&&!Array.isArray(event)&&typeof event.type==='string','STREAM_PROTOCOL_ERROR');
    assert(!this.terminal,'EVENT_AFTER_TERMINAL');this.events++;
    assert(this.events<=100000,'EVENT_LIMIT');
    switch(event.type){
      case 'init':
        assert(!this.init&&typeof event.session_id==='string'&&typeof event.model==='string','INVALID_INIT');
        this.init={sessionId:event.session_id,initialModel:event.model};break;
      case 'message':
        assert(this.init,'MISSING_INIT');
        if(event.role==='assistant'&&typeof event.content==='string')this.text+=event.content;
        break;
      case 'tool_use': case 'tool_result': assert(this.init,'MISSING_INIT'); break;
      case 'error': this.errors.push({kind:'host-error',code:typeof event.code==='string'?event.code:null}); break;
      case 'result': {
        assert(this.init&&['success','error'].includes(event.status),'INVALID_TERMINAL');
        this.terminal={status:event.status};
        // Only a terminal host statistics map confirms the complete model set.
        const perModel=event.stats?.models;
        if(perModel&&typeof perModel==='object'&&!Array.isArray(perModel)){
          this.finalModels=Object.keys(perModel).filter(k=>k.length>0&&k.length<=200).sort();
        }
        break;
      }
      default: this.unknown.push(event.type); // unknown future events fail closed, rather than hiding model switches.
    }
    assert(Buffer.byteLength(this.text,'utf8')<=4*1024*1024,'OUTPUT_LIMIT');
  }
  finish({exitCode=0,aborted=false}={}){
    const succeeded=!!this.terminal&&this.terminal.status==='success'&&this.errors.length===0&&this.unknown.length===0&&exitCode===0&&!aborted;
    return {host:'gemini-cli',protocol:GEMINI_ADAPTER.protocol,terminalOutcome:succeeded?'succeeded':aborted||!this.terminal?'unknown':'failed',
      sessionId:this.init?.sessionId??null,initialModel:this.init?.initialModel??null,observedModels:this.finalModels,
      modelVerification:this.finalModels.length?'host-terminal-usage':'unverified',nativeReasoning:null,runtimeMode:null,
      errorCount:this.errors.length,unknownEventTypes:[...new Set(this.unknown)],resultText:this.text,eventCount:this.events,
      terminalDigest:this.terminal?digest(this.terminal):null};
  }
}
