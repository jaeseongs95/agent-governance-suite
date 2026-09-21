import { assert, keys, text, validateBinding, validateTarget, digestValue, canonical, verifySeal, validateRequest, digest, revalidateDispatch } from './model-routing-core.mjs';
export const MODEL_ROUTING_PEER_FEATURE='model-routing.v2';
export function encodePeerAssignment(request,decision,{delta='',inputReferences=[]}={}){
  validateRequest(request);verifySeal(decision,'decisionDigest');assert(decision.status==='selected','ASSIGNMENT_BLOCKED');
  assert(digest(request)===decision.requestDigest,'REQUEST_DIGEST_MISMATCH');
  assert(canonical(request.binding)===canonical(decision.binding),'BINDING_MISMATCH');
  assert(typeof delta==='string'&&Buffer.byteLength(delta,'utf8')<=2048,'DELTA_TOO_LARGE');
  assert(Array.isArray(inputReferences)&&inputReferences.length<=8,'REFERENCE_LIMIT');
  for(const r of inputReferences){keys(r,['uri','digest']);text(r.uri,'artifact URI');digestValue(r.digest,'artifact digest');}
  const envelope={schemaVersion:'1.0.0',feature:MODEL_ROUTING_PEER_FEATURE,type:'assignment-proposal',binding:decision.binding,target:decision.target,decisionDigest:decision.decisionDigest,delta,inputReferences};
  const body=canonical(envelope);assert(Buffer.byteLength(body,'utf8')<=4096,'PEER_MESSAGE_TOO_LARGE');return body;
}
export function decodePeerAssignment(body,negotiatedFeatures){
  assert(Array.isArray(negotiatedFeatures)&&negotiatedFeatures.includes(MODEL_ROUTING_PEER_FEATURE),'PEER_FEATURE_UNAVAILABLE');
  assert(typeof body==='string'&&Buffer.byteLength(body,'utf8')<=4096,'PEER_MESSAGE_TOO_LARGE');const v=JSON.parse(body);
  keys(v,['schemaVersion','feature','type','binding','target','decisionDigest','delta','inputReferences']);
  assert(v.schemaVersion==='1.0.0'&&v.feature===MODEL_ROUTING_PEER_FEATURE&&v.type==='assignment-proposal','PEER_PROTOCOL_MISMATCH');
  validateBinding(v.binding);validateTarget(v.target);digestValue(v.decisionDigest,'decisionDigest');
  assert(typeof v.delta==='string'&&Buffer.byteLength(v.delta,'utf8')<=2048,'DELTA_TOO_LARGE');
  assert(Array.isArray(v.inputReferences)&&v.inputReferences.length<=8,'REFERENCE_LIMIT');
  for(const r of v.inputReferences){keys(r,['uri','digest']);text(r.uri,'artifact URI');digestValue(r.digest,'artifact digest');}
  return v;
}
export const preflightPeerAssignment = revalidateDispatch;
/** Receiver integration uses existing presence, contract lookup and one-use workflow authorization. */
export async function acceptPeerAssignment(body,{features,target,loadAssignment,environment,authorizeAndConsume,revalidateAuthorization,store}){
  const envelope=decodePeerAssignment(body,features);assert(canonical(envelope.target)===canonical(target),'PEER_TARGET_MISMATCH');
  assert(typeof loadAssignment==='function'&&typeof authorizeAndConsume==='function'&&typeof environment?.refresh==='function'&&store,'PEER_GOVERNANCE_UNAVAILABLE');
  const {request,decision}=await loadAssignment(envelope.decisionDigest);
  assert(decision.decisionDigest===envelope.decisionDigest&&canonical(decision.binding)===canonical(envelope.binding)&&canonical(decision.target)===canonical(target),'PEER_ASSIGNMENT_MISMATCH');
  revalidateDispatch(request,decision,environment);
  const reservation=store.reserveDispatch(decision,{write:request.requirements.filesystem==='write'});
  if(reservation.duplicate)return {accepted:false,shouldExecute:false,duplicate:true,state:reservation.state,dispatchKey:reservation.dispatchKey};
  let allowed=false;
  try{allowed=await authorizeAndConsume({request,decision,target});}catch{
    store.transition(reservation.dispatchKey,0,'unknown');
    return {accepted:false,shouldExecute:false,reason:'AUTHORIZATION_OUTCOME_UNKNOWN',dispatchKey:reservation.dispatchKey};
  }
  if(allowed!==true){store.transition(reservation.dispatchKey,0,'not-started','existing-workflow:authorization-denied');return {accepted:false,shouldExecute:false,reason:'EXISTING_WORKFLOW_AUTHORIZATION_REQUIRED'};}
  // Time/instance may have changed while the host approval callback awaited. Read current env again.
  try{
    const current=await environment.refresh();
    revalidateDispatch(request,decision,current);
    // The local lease/authority is checked synchronously after the last network await.
    if(revalidateAuthorization)assert(revalidateAuthorization()===true,'EXISTING_WORKFLOW_AUTHORIZATION_REQUIRED');
  }catch(error){store.transition(reservation.dispatchKey,0,'not-started','existing-workflow:revalidation-failed');throw error;}
  store.transition(reservation.dispatchKey,0,'accepted');
  return {accepted:true,shouldExecute:true,dispatchKey:reservation.dispatchKey,revision:1,decisionDigest:decision.decisionDigest,delta:envelope.delta,inputReferences:envelope.inputReferences};
}
