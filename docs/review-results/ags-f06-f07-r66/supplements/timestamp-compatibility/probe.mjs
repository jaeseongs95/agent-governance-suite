import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalJson, convergenceDigest } from '../test-tree/mcp-server/src/convergence-logic.ts';
import { FlowmarshalCurrentInvocation } from '../test-tree/mcp-server/src/host-integration/flowmarshal-current-invocation.ts';
import { VmCurrentInvocation } from '../test-tree/mcp-server/src/host-integration/vm-current-invocation.ts';
import { verifyFlowmarshalReceipt, registerVmObservationReader } from '../test-tree/mcp-server/src/host-integration/observation-challenge.ts';
import { InMemoryWorkflowStore } from '../test-tree/mcp-server/src/workflow-store.ts';
import { WorkflowService } from '../test-tree/mcp-server/src/workflow-service.ts';

// Fresh synthetic material only. No historical receipt or operating profile is consumed.
const key=generateKeyPairSync('ed25519');
const directory=mkdtempSync(path.join(tmpdir(),'ags-time-probe-'));
const base=Date.parse('2026-10-02T00:00:00.000Z');
let clock=base+1001;
const profile={profileId:'flowmarshal-same-user-v1',assuranceTier:'same-user',
  freezeIdentity:`sha256:${'a'.repeat(64)}`,
  pins:[{keyId:'synthetic-time-key',status:'active',publicKeySpki:key.publicKey.export({format:'der',type:'spki'}).toString('base64')}],
  resources:{state:{namespace:'flowmarshal-same-user-v1',location:path.join(directory,'state.sqlite3')}}};
const sha=(v)=>`sha256:${createHash('sha256').update(v).digest('hex')}`;
const signed=(body)=>{const bytes=Buffer.from(canonicalJson(body));return {body:bytes.toString('base64url'),
  signature:sign(null,bytes,key.privateKey).toString('base64url'),keyId:'synthetic-time-key'};};
const verifyEnvelope=(envelope)=>{const bytes=Buffer.from(envelope.body,'base64url');
  assert.equal(verify(null,bytes,key.publicKey,Buffer.from(envelope.signature,'base64url')),true);
  const body=JSON.parse(bytes.toString('utf8'));assert.equal(canonicalJson(body),bytes.toString('utf8'));
  return {body,bytes,keyId:envelope.keyId,pin:{installationId:'synthetic-time-installation',hostId:'flowmarshal-engine'}};};
const store=new InMemoryWorkflowStore();
const fm=new FlowmarshalCurrentInvocation(profile,store,()=>clock);
const vm=new VmCurrentInvocation(store,()=>clock,{verifyEnvelope});
const input={synthetic:'clock-input'};
function registration(observedAt,issued,nonce,host='flowmarshal'){
  return {version:1,domain:host==='flowmarshal'?'ags-fm-same-user-dispatch-registration-v1':'ags-vm-dispatch-registration-v1',
    ...(host==='flowmarshal'?{profileBinding:{profileId:profile.profileId,freezeIdentity:profile.freezeIdentity},
      assertions:{modelClass:'deep',actorId:'synthetic-time-actor'}}:{}),serverEpoch:host==='flowmarshal'?fm.serverEpoch:vm.serverEpoch,
    nonce,issuedAt:new Date(issued).toISOString(),expiresAt:new Date(issued+60_000).toISOString(),
    producer:{installationId:'synthetic-time-installation',keyId:'synthetic-time-key',hostId:host,instanceId:'synthetic-time-instance'},
    binding:{turnId:'synthetic-time-turn',taskId:'synthetic-time-task',runId:null,attemptId:null,hostId:host,sessionId:'synthetic-time-session',instanceId:'synthetic-time-instance'},
    terminal:{eventId:'synthetic-time-event',callId:'synthetic-time-provider-call',threadId:'synthetic-time-thread',turnId:'synthetic-time-turn',
      status:'succeeded',observedAt,model:'synthetic-time-model',effort:'high',provenance:'provider_raw_response',digest:`sha256:${'b'.repeat(64)}`},
    core:{goalRevision:1,taskRevision:1,attemptOrdinal:null,gateOperationKey:'synthetic-time-operation',stage:'bootstrap'},
    invocation:{tool:'plan_workflow',inputDigest:convergenceDigest(input),observedAt:new Date(issued).toISOString()}};
}
function receipt(reg,host='flowmarshal'){
  const fmMode=host==='flowmarshal';
  return {version:fmMode?2:1,domain:fmMode?'fm-same-user-provider-terminal-to-governance-v1':'vm-provider-terminal-to-governance',
    ...(fmMode?{profileBinding:reg.profileBinding,assertions:reg.assertions}:{}),producer:reg.producer,
    binding:{invocationId:'synthetic-time-call',...reg.binding},terminal:reg.terminal,core:reg.core,invocation:reg.invocation,
    nonce:`receipt-${reg.nonce}`,issuedAt:reg.issuedAt,expiresAt:reg.expiresAt,
    ...(fmMode?{transport:{serverEpoch:reg.serverEpoch,registrationDigest:sha(Buffer.from(canonicalJson(reg)))}}:{})};
}
function attempt(run){try{run();return 'ACCEPT';}catch(error){return `REJECT: ${error.message}`;}}
function fmReceipt(reg){const body=receipt(reg),envelope=signed(body);
  return verifyFlowmarshalReceipt({envelope,profile,registration:reg,registrationDigest:body.transport.registrationDigest,
    callId:'synthetic-time-call',serverEpoch:fm.serverEpoch,tool:'plan_workflow',
    arguments:{...input,_hostAttestation:envelope},now:clock,verifyEnvelope});}
function vmReceipt(reg){const body=receipt(reg,'flowmarshal-engine'),envelope=signed(body);
  const reader=registerVmObservationReader({verifySignedEnvelope:verifyEnvelope,
    readCurrentInvocation:()=>({receipt:envelope,tool:'plan_workflow',arguments:{...input,_hostAttestation:envelope},binding:body.binding})});
  return reader.readCurrentInvocation();}
function freshness(observedAt,expiresAt){const original=Date.now;Date.now=()=>clock;
  try{return attempt(()=>WorkflowService.prototype.assertTrustedExecutionFreshness.call({}, {observedAt,expiresAt},'synthetic-time-context'));}
  finally{Date.now=original;}}
try{
  for(const [i,value] of ['2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000500Z','2026-10-02T00:00:00.000500+00:00'].entries()){
    const reg=registration(value,base+1000,`forms-${i}`),vmReg=registration(value,base+1000,`vm-forms-${i}`,'flowmarshal-engine');
    const row={probe:'forms',terminal:value,fmDispatch:attempt(()=>fm.reserve(signed(reg))),fmPureReceipt:attempt(()=>fmReceipt(reg)),
      vmDispatch:attempt(()=>vm.reserve(signed(vmReg))),vmPureReceiptReader:attempt(()=>vmReceipt(vmReg))};
    assert.equal(row.fmPureReceipt,'ACCEPT');assert.equal(row.vmDispatch,'ACCEPT');assert.equal(row.vmPureReceiptReader,'ACCEPT');
    assert.equal(row.fmDispatch==='ACCEPT',i===0);console.log(JSON.stringify(row));
  }
  let comparisons=0;
  for(const micros of [0,500,999])for(const ms of [299999,300000,300001]){
    const terminal=`2026-10-02T00:00:00.${String(micros).padStart(6,'0')}Z`;
    const exactAge=BigInt(ms)*1000n-BigInt(micros);
    const parsedAge=base+ms-Date.parse(terminal);
    assert.equal(parsedAge>300000,exactAge>300000000n);comparisons++;
  }
  console.log(JSON.stringify({probe:'five-minute-age-predicate',comparisons,decisionDifferences:0,
    qualification:'Whole-millisecond verification clock and positive UTC synthetic epochs only.'}));
  for(const [label,terminal,issuedOffset,nowOffset] of [
    ['last-unexpired-millisecond','2026-10-02T00:00:00.000500+00:00',240000,299999],
    ['expiry-tick','2026-10-02T00:00:00.000500+00:00',240000,300000],
    ['post-five-minute-age','2026-10-02T00:00:00.000500+00:00',240000,300001],
    ['recent-receipt-old-terminal','2026-10-02T00:00:00.000Z',300000,300001]]){
    clock=base+nowOffset;const reg=registration(terminal,base+issuedOffset,`boundary-${label}`);
    const observed={probe:'boundary',label,terminal,issuedAt:reg.issuedAt,expiresAt:reg.expiresAt,now:new Date(clock).toISOString(),
      fmPureReceipt:attempt(()=>fmReceipt(reg)),strictFreshnessHelper:freshness(terminal,reg.expiresAt)};
    if(label==='last-unexpired-millisecond')assert.equal(observed.strictFreshnessHelper,'ACCEPT');
    if(label==='recent-receipt-old-terminal'){
      assert.equal(observed.fmPureReceipt,'ACCEPT');assert.match(observed.strictFreshnessHelper,/REJECT/);
    }
    console.log(JSON.stringify(observed));
  }
}finally{fm.close();rmSync(directory,{recursive:true,force:true});}
