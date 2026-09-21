import { assert, keys, digest, canonical, instant, verifySeal, recordV2, resolveV2, validateRequest, RoutingError } from './model-routing-core.mjs';
import { defaultCatalogDirectory, loadCatalog, loadPolicy, queryCatalog } from './model-catalog.mjs';

/** Tool calls over the skill-owned engine. The MCP server passes an explicit catalog directory. */
export class ModelRoutingServiceCore {
  constructor({store=null,catalogDirectory=defaultCatalogDirectory,clock=()=>new Date().toISOString(),historyProvider=null}={}){this.store=store;this.catalogDirectory=catalogDirectory;this.clock=clock;this.historyProvider=historyProvider;}
  query(input){return queryCatalog(input,this.catalogDirectory);}
  resolve(input){
    validateRequest(input);
    // Independent role history is read from the caller's existing governance service,
    // not invented from the model family. No history provider => auditor proposal blocked.
    let request=structuredClone(input);
    if(request.role==='independent-audit'){
      assert(this.historyProvider,'AUDIT_HISTORY_PROVIDER_REQUIRED');
      const history=this.historyProvider(request.binding);
      assert(history&&Array.isArray(history.actors)&&Array.isArray(history.sessions),'AUDIT_HISTORY_UNAVAILABLE');
      request.requirements.excludedActors=[...new Set([...request.requirements.excludedActors,...history.actors])].sort();
      request.requirements.excludedSessions=[...new Set([...request.requirements.excludedSessions,...history.sessions])].sort();
    }
    const now=this.clock(),capabilities=this.store?.capabilities()??[];
    const environment={catalog:loadCatalog({directory:this.catalogDirectory}),policy:loadPolicy(this.catalogDirectory),capabilities,now};
    const decision=resolveV2(request,environment);
    if(this.store)this.store.saveDecision(request,environment,decision,now);
    return decision;
  }
  record(input){
    keys(input,['application','observationToken'],['application']);assert(this.store,'ROUTING_STORE_UNAVAILABLE');
    const entry=this.store.decision(input.application?.decisionDigest);assert(entry,'DECISION_UNKNOWN');
    const now=this.clock();instant(now,'now');
    assert(Date.parse(input.application.dispatchedAt)<=Date.parse(now),'DISPATCH_TIME_IN_FUTURE');
    const token=input.observationToken??null;
    if(token!==null){
      assert(typeof token==='string'&&/^[a-f0-9]{48}$/u.test(token),'INVALID_OBSERVATION_TOKEN');
      const dispatch=this.store.dispatch(digest({binding:input.application.binding}));
      assert(dispatch&&dispatch.dispatched_at===input.application.dispatchedAt&&dispatch.decision_digest===input.application.decisionDigest,'DISPATCH_TIME_MISMATCH');
    }
    return this.store.recordApplication(input.application,token,admittedObservation=>recordV2(input.application,{...entry.environment,now:input.application.dispatchedAt,request:entry.request,decision:entry.decision,admittedObservation}),now);
  }
  call(name,input){
    try{
      assert(Buffer.byteLength(canonical(input),'utf8')<=1024*1024,'REQUEST_TOO_LARGE');
      const data=name==='query_model_catalog'?this.query(input):name==='resolve_model_assignment'?this.resolve(input):name==='record_model_application'?this.record(input):(()=>{throw new RoutingError('UNKNOWN_TOOL','Unknown model routing tool');})();
      return {schemaVersion:'1.0.0',ok:true,data,error:null};
    }catch(error){
      // Routing rejections are input problems; anything else (for example a locked database) is an unavailable store.
      const routing=error instanceof RoutingError;
      return {schemaVersion:'1.0.0',ok:false,data:null,error:{code:routing?'INVALID_INPUT':'MCP_UNAVAILABLE',message:error.message,details:{routingCode:routing?error.code:'ROUTING_ERROR'}}};
    }
  }
}
/** Bind before adding the artifact URI to StageResult.v1. Never embeds a v2 record into it. */
export function checkApplicationArtifactBinding(record,{binding,target,requiredFields=[],store=null}){
  verifySeal(record,'recordDigest');
  if(requiredFields.length)assert(store&&canonical(store.application(record.recordDigest))===canonical(record)&&record.observationAdmitted,'PERSISTED_HOST_OBSERVATION_REQUIRED');
  assert(canonical(record.binding)===canonical(binding)&&canonical(record.target)===canonical(target),'STAGE_ARTIFACT_BINDING_MISMATCH');
  const map={model:record.modelVerification,reasoning:record.reasoningVerification,runtimeMode:record.runtimeModeVerification};
  assert(requiredFields.every(k=>Object.hasOwn(map,k)&&map[k]==='matched'),'REQUIRED_OBSERVATION_UNVERIFIED');
  return {diagnosticArtifactAccepted:true,trustedExecutionGateSatisfied:false,uri:`ags-model-record:${record.recordDigest.slice(7)}`,digest:record.recordDigest};
}
