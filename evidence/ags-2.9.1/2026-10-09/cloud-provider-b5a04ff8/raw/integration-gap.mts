import {writeFileSync} from 'node:fs';
import {createClassificationRequest} from '/workspace/ags-cloud-provider-fix/mcp-server/src/skill-classification/request.ts';
import {digestProviderProfileConfiguration} from '/workspace/ags-cloud-provider-fix/mcp-server/src/skill-classification/profiles.ts';
import {ApprovedRouteClassificationProvider,jevNoulWireAdapter,ClassificationProviderError} from '/workspace/ags-cloud-provider-fix/mcp-server/src/skill-classification/providers.ts';
import {SkillClassificationService,InMemoryClassificationBudget} from '/workspace/ags-cloud-provider-fix/mcp-server/src/skill-classification/service.ts';
import type {ApprovedClassificationRoute} from '/workspace/ags-cloud-provider-fix/mcp-server/src/skill-classification/providers.ts';
import type {ProviderProfile} from '/workspace/ags-cloud-provider-fix/mcp-server/src/skill-classification/types.ts';
const request=createClassificationRequest({requestId:'synthetic',operationId:'synthetic',originalPrompt:'Read-only synthetic review',inventory:{skills:[{skillId:'review',version:'1',description:'Synthetic review',enabled:true,installed:true,hostSupported:true,capabilities:['review'],actions:['review'],targets:['diff'],constraints:['read-only'],applicability:['review'],exclusions:['implementation'],dependencies:[],phases:[],sourceRefs:[]}],issues:[],inventoryDigest:`sha256:${'a'.repeat(64)}`,taxonomyRevision:'synthetic'},classificationCriteriaRef:'criteria'});
const profile:ProviderProfile={profileId:'jev',providerKind:'jev',vendorId:'typesafe',modelId:'synthetic-fixed',modelRevision:'synthetic-fixed',reasoningEffort:null,supportedOptions:{structuredOutput:true,reasoningEfforts:[null]},approvedRouteRef:'synthetic',qualificationRevision:'synthetic',qualification:{status:'PASS',inventoryDigest:request.inventoryDigest,taxonomyRevision:request.taxonomyRevision,modelRevision:'synthetic-fixed',promptRevision:'p1',validUntil:'2099-01-01T00:00:00Z',profileConfigurationDigest:''},adapterRevision:'a1',promptRevision:'p1',maximumInputBytes:100000,maximumOutputTokens:100,maximumCostUsd:0.4,judgmentPolicy:{neededAt:0.8,notNeededAt:0.2}};
profile.qualification.profileConfigurationDigest=digestProviderProfileConfiguration(profile);
globalThis.fetch=async()=>{throw new Error('REAL_NETWORK_FORBIDDEN');};
async function run(snapshotChange:boolean) {
  let fetchCalls=0,keyLookups=0;let release!: (value:string)=>void,entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const route:ApprovedClassificationRoute={routeRef:'synthetic',approvalRef:'synthetic',approved:true,providerKind:'jev',vendorId:'typesafe',adapterRevision:'a1',modelIds:['synthetic-fixed'],reasoningEfforts:[null],structuredOutput:true,kind:'remote',endpoint:'https://synthetic.example.invalid/',getCredential:async()=>{keyLookups++;if(snapshotChange&&keyLookups===2){entered();return new Promise(resolve=>{release=resolve;});}return 'SYNTHETIC_ONLY';},adapter:jevNoulWireAdapter};
  const provider=new ApprovedRouteClassificationProvider([route],async()=>{fetchCalls++;return new Response('',{status:429,headers:{'retry-after':'15'}});});
  let observation:unknown=null;const actual=provider.classify.bind(provider);
  provider.classify=async(...args)=>{try{return await actual(...args);}catch(error){if(error instanceof ClassificationProviderError)observation=error.rateLimitObservation;throw error;}};
  const budget=new InMemoryClassificationBudget({jev:{limitUsd:5,spentUsd:0},vendors:{}});
  const service=new SkillClassificationService({providers:{jev:provider},budget});
  const snapshot={taskRevision:null,configRevision:'c1',profileRevision:'p1',inventoryDigest:request.inventoryDigest,requestDigest:request.requestDigest,cancelled:false};
  const pending=service.classify({request,registry:{schemaVersion:'1.0.0',profileRevision:'p1',profiles:[profile]},config:{jevEnabled:true,mode:'select',providerProfileRegistryRef:'synthetic',externalClassificationAllowed:true,configRevision:'c1',timeoutMs:1000},currentVendorId:'synthetic-vendor',getCurrentSnapshot:()=>snapshot});
  if(snapshotChange){await waiting;snapshot.configRevision='c2';release('SYNTHETIC_ONLY');}
  const result=await pending;
  return {snapshotChange,fetchCalls,keyLookups,providerObservation:observation,serviceAttemptHasObservation:result.attempts.some(a=>Object.hasOwn(a,'rateLimitObservation')),result,budget:budget.snapshot()};
}
const records=[await run(false),await run(true)];
writeFileSync('/workspace/ags-provider-fix-evidence/integration-gap.json',JSON.stringify({paidApiCalls:0,claudeCalls:0,records},null,2));
console.log(JSON.stringify(records.map(r=>({snapshotChange:r.snapshotChange,fetchCalls:r.fetchCalls,serviceError:r.result.response.error?.code,providerObservation:r.providerObservation,serviceAttemptHasObservation:r.serviceAttemptHasObservation}))));
