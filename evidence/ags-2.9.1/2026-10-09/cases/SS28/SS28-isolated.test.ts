import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {beforeAll, describe, expect, it, vi} from 'vitest';
import {loadSkillInventory} from '../mcp-server/src/skill-classification/inventory.js';
import {createClassificationRequest, projectClassificationRequest, digestClassificationValue} from '../mcp-server/src/skill-classification/request.js';
import {ApprovedRouteClassificationProvider, buildVendorMessages, jevNoulWireAdapter, unknownUsage} from '../mcp-server/src/skill-classification/providers.js';
import {validateClassificationResponse} from '../mcp-server/src/skill-classification/validation.js';
import {InMemoryClassificationBudget, SkillClassificationService} from '../mcp-server/src/skill-classification/service.js';
import {digestProviderProfileConfiguration} from '../mcp-server/src/skill-classification/profiles.js';
import {oracleDigest, scoreCase, sameSet} from './skill-classification/evaluation.js';
import type {SkillClassificationRequestV1, SkillInventory, ProviderProfile, SkillClassificationResponseV1} from '../mcp-server/src/skill-classification/types.js';

// SS28 only. Public functions + synthetic transport. No host receipt, API or CLI invocation.
const out='./ss28-reproduction-output';
const corpus=JSON.parse(readFileSync('tests/skill-classification/fixtures.json','utf8'));
const row=corpus.cases.find((c:any)=>c.caseId==='SS28');
const hash=(v:string)=>'sha256:'+createHash('sha256').update(v).digest('hex');
const save=(name:string,v:unknown)=>writeFileSync(`${out}/${name}.json`,JSON.stringify(v,null,2)+'\n');
let inventory:SkillInventory, request:SkillClassificationRequestV1;
const make=(prompt:string, inv=inventory, context?:any)=>createClassificationRequest({requestId:'SS28-offline',operationId:'SS28-offline',originalPrompt:prompt,inventory:inv,classificationCriteriaRef:'skills/orchestrator/references/skill-classification.md',...context});
const profile=(req=request):ProviderProfile=>{
 const p:ProviderProfile={profileId:'SS28-synthetic',providerKind:'vendor',vendorId:'synthetic',modelId:'SS28-model',modelRevision:'SS28-model',reasoningEffort:'low',supportedOptions:{reasoningEfforts:['low'],structuredOutput:true},approvedRouteRef:'SS28-mock',qualificationRevision:'synthetic-not-live',qualification:{status:'PASS',inventoryDigest:req.inventoryDigest,taxonomyRevision:req.taxonomyRevision,modelRevision:'SS28-model',promptRevision:'SS28',validUntil:'2099-01-01T00:00:00Z',profileConfigurationDigest:''},adapterRevision:'SS28',promptRevision:'SS28',maximumInputBytes:2000000,maximumOutputTokens:1000,maximumCostUsd:0.4,judgmentPolicy:{neededAt:0.8,notNeededAt:0.2}};
 p.qualification.profileConfigurationDigest=digestProviderProfileConfiguration(p); return p;
};
const fullResponse=():SkillClassificationResponseV1=>({schemaVersion:'1.0.0',requestId:request.requestId,operationId:request.operationId,requestDigest:request.requestDigest,inventoryDigest:request.inventoryDigest,status:'SUCCESS',judgments:request.skills.map(s=>({skillId:s.skillId,judgment:'not-needed',reasonRefs:['synthetic-only-not-semantic-oracle'],uncertaintyReason:null})),unresolvedItems:[],error:null});
const transport=(body:string,p=profile())=>{
 const fetcher=vi.fn(async()=>new Response(body));
 const credential=vi.fn(async()=>'SYNTHETIC-ONLY');
 const route:any={routeRef:'SS28-mock',approvalRef:'test-only',approved:true,kind:'remote',providerKind:p.providerKind,vendorId:p.vendorId,adapterRevision:p.adapterRevision,modelIds:[p.modelId],reasoningEfforts:[p.reasoningEffort],structuredOutput:true,endpoint:'https://ss28.example.invalid/',getCredential:credential,adapter:jevNoulWireAdapter};
 return {provider:new ApprovedRouteClassificationProvider([route],fetcher),fetcher,credential};
};
beforeAll(async()=>{
 expect(hash(readFileSync('tests/skill-classification/fixtures.json','utf8'))).toBe('sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
 expect(oracleDigest(corpus)).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
 expect(row.oracle).toBeNull();
 inventory=await loadSkillInventory({root:process.cwd()});
 expect(inventory.issues).toEqual([]);
 request=make(row.originalPrompt);
 save('SS28.source',row); save('inventory',inventory);
});
describe('SS28 isolated operational variants',()=>{
 it('original: exact embedded prompt, full canonical descriptors and null semantic oracle',()=>{
  expect(request.originalPrompt).toBe('읽기 전용, 수정 금지');
  expect(request.skills).toEqual(inventory.skills);
  expect(request.skills.length).toBe(corpus.inventorySkillIds.length);
  expect(()=>scoreCase(row,undefined,corpus.inventorySkillIds)).toThrow('NO_SEMANTIC_ORACLE:SS28');
  save('original',{input:request,expected:{originalPrompt:row.originalPrompt,candidateIds:corpus.inventorySkillIds,oracle:null},observed:{candidateCount:request.skills.length,requestDigest:request.requestDigest,semanticAccuracy:null}});
 });
 it('compact: paired body/diff/byte measurements preserve every semantic field including duplicates',()=>{
  const noisy=structuredClone(inventory);
  noisy.skills[0].description+='\n'+noisy.skills[0].description;
  noisy.skills[0].sourceMap!.push(...Array.from({length:100},()=>({field:'local-trace',path:'SYNTHETIC_LOG_METADATA_NOT_FOR_PROVIDER'.repeat(40),digest:hash('synthetic-trace')})));
  const original=make(row.originalPrompt,noisy), compact=projectClassificationRequest(original);
  const full=JSON.stringify(original), small=JSON.stringify(compact.payload);
  expect(compact.payload.originalPrompt).toBe(original.originalPrompt);
  for(const [i,s] of original.skills.entries()){
   for(const [k,v] of Object.entries(s)) if(!['sourceRefs','sourceMap'].includes(k)) expect((compact.payload.skills[i] as any)[k]).toEqual(v);
   expect(Object.keys(compact.payload.skills[i])).toEqual(Object.keys(s).filter(k=>!['sourceRefs','sourceMap'].includes(k)));
  }
  expect(compact.payloadBytes).toBeLessThan(Buffer.byteLength(full));
  save('compact',{input:original,observed:compact,bodyDigests:{original:hash(full),compact:hash(small)},bytes:{original:Buffer.byteLength(full),compact:Buffer.byteLength(small)},fieldDiff:compact.omittedFields,candidateCounts:[original.skills.length,compact.payload.skills.length],measurements:{actualInputTokens:null,providerUsage:null,providerCacheBilling:null,localCacheHit:null,latencyMs:null},semanticPairedComparison:'NOTRUN',hostPairedComparison:'NOTRUN'});
 });
 it('negation-at-tail: long Unicode input retains final prohibition in both wire formats',()=>{
  const long=make('참조 텍스트 🧪 e\u0301 '.repeat(8000)+'\n'+row.originalPrompt);
  const projected=projectClassificationRequest(long), vendor=JSON.parse(buildVendorMessages(long)[1].content), jev:any=jevNoulWireAdapter.encode(long,profile(long));
  for(const actual of [projected.payload.originalPrompt,vendor.originalPrompt,jev.state.originalPrompt]) expect(actual).toBe(long.originalPrompt);
  save('negation-at-tail',{input:long,expectedTail:row.originalPrompt,observed:{projectionExact:true,vendorExact:true,jevExact:true,originalDigest:hash(long.originalPrompt),wireDigests:{vendor:hash(JSON.stringify(buildVendorMessages(long))),jev:hash(JSON.stringify(jev))},selected:null}});
 });
 it('required-at-tail: inventory reordered with canonical cs-engineering last loses no candidates or dependencies',()=>{
  const tail=structuredClone(inventory); const cs=tail.skills.find(s=>s.skillId==='cs-engineering')!;
  expect(cs).toBeDefined(); tail.skills=[...tail.skills.filter(s=>s.skillId!==cs.skillId),cs];
  tail.inventoryDigest=digestClassificationValue(tail.skills);
  const original=make(row.originalPrompt,tail), compact=projectClassificationRequest(original), vendor=JSON.parse(buildVendorMessages(original)[1].content), jev:any=jevNoulWireAdapter.encode(original,profile(original));
  expect(compact.payload.skills.at(-1)!.skillId).toBe('cs-engineering');
  expect(vendor.skills.at(-1).skillId).toBe('cs-engineering');
  expect(Object.keys(jev.questions).at(-1)).toBe('cs-engineering');
  expect(compact.payload.skills.map(s=>s.skillId).sort()).toEqual(inventory.skills.map(s=>s.skillId).sort());
  save('required-at-tail',{input:original,expected:{lastId:'cs-engineering',ruleRequiredSkillIds:['cs-engineering'],note:'synthetic mechanical placement; not a semantic oracle for the original read-only prompt'},observed:{candidateCount:compact.payload.skills.length,lastProjected:compact.payload.skills.at(-1),lastVendor:vendor.skills.at(-1).skillId,lastJev:Object.keys(jev.questions).at(-1),selected:null}});
 });
 it('truncated-json: mid-object response becomes invalid and never a no-skill set',async()=>{
  const full=JSON.stringify({model:profile().modelRevision,answers:Object.fromEntries(request.skills.map(s=>[s.skillId,{type:'noul',noul:0.1}])),usage:{input_tokens:100,output_tokens:10}}), body=full.slice(0,Math.floor(full.length/2));
  const f=transport(body); const error=await f.provider.classify(request,profile(),new AbortController().signal).catch(e=>e);
  save('truncated-json',{input:{responseBody:body,responseBodyDigest:hash(body)},expected:{code:'INVALID_PROVIDER_RESPONSE',selected:null},observed:{error:{code:error.code,dispatchState:error.dispatchState,invalid:error.invalid},mockFetchCalls:f.fetcher.mock.calls.length,selected:null}});
  expect(error).toMatchObject({code:'INVALID_PROVIDER_RESPONSE',dispatchState:'started',invalid:true}); expect(f.fetcher).toHaveBeenCalledTimes(1);
 });
 it('truncated-question-results: parseable JSON missing trailing candidate is rejected for every success-like status',async()=>{
  const answers=Object.fromEntries(request.skills.slice(0,-1).map(s=>[s.skillId,{type:'noul',noul:0.1}]));
  const body=JSON.stringify({model:profile().modelRevision,answers,usage:{input_tokens:100,output_tokens:10}});
  const f=transport(body), error=await f.provider.classify(request,profile(),new AbortController().signal).catch(e=>e);
  expect(error).toMatchObject({code:'INVALID_PROVIDER_RESPONSE',invalid:true});
  const checks=Object.fromEntries(['SUCCESS','PARTIAL','UNCERTAIN'].map(status=>[status,validateClassificationResponse(request,{...fullResponse(),status:status as any,judgments:fullResponse().judgments.slice(0,-1)})]));
  Object.values(checks).forEach(v=>expect(v).toContain('MISSING_CANDIDATE_JUDGMENT'));
  save('truncated-question-results',{input:{body,omittedId:request.skills.at(-1)!.skillId},expected:'INVALID_PROVIDER_RESPONSE / MISSING_CANDIDATE_JUDGMENT; never []',observed:{error:{code:error.code,dispatchState:error.dispatchState},checks,selected:null}});
 });
 it('too-long: UTF-8 exact input ceiling passes; minus one rejects without fetch or silent trimming',async()=>{
  const long=make('🧪한글'.repeat(2000)+row.originalPrompt), projection=projectClassificationRequest(long);
  expect(projectClassificationRequest(long,projection.payloadBytes).payload.originalPrompt).toBe(long.originalPrompt);
  let projectionError:any; try {projectClassificationRequest(long,projection.payloadBytes-1);}catch(e){projectionError=e;}
  expect(projectionError).toMatchObject({message:'INPUT_TOO_LONG',omittedRanges:[]});
  const p=profile(long), body=JSON.stringify(jevNoulWireAdapter.encode(long,p)); p.maximumInputBytes=Buffer.byteLength(body)-1;
  const f=transport('{}',p), error=await f.provider.classify(long,p,new AbortController().signal).catch(e=>e);
  expect(error).toMatchObject({code:'INPUT_TOO_LONG',dispatchState:'not-started'}); expect(f.fetcher).not.toHaveBeenCalled();
  save('too-long',{input:{prompt:long.originalPrompt,projectionBytes:projection.payloadBytes,wireBytes:Buffer.byteLength(body),limit:p.maximumInputBytes},expected:{code:'INPUT_TOO_LONG',omittedRanges:[],mockFetchCalls:0},observed:{error:{code:error.code,dispatchState:error.dispatchState},projectionOmittedRanges:projectionError.omittedRanges,mockFetchCalls:f.fetcher.mock.calls.length,selected:null}});
 });
 it('unknown-not-empty: unknown null survives packing separately from sourced empty arrays',()=>{
  const unknown=projectClassificationRequest(request).payload;
  const empty=make(row.originalPrompt,inventory,{confirmedContext:{actions:[],targets:[],prohibitedActions:[]},contextSources:['actions','targets','prohibitedActions'].map(field=>({field,reference:'SS28:synthetic-confirmed-empty'}))});
  const compact=projectClassificationRequest(empty).payload;
  expect(unknown.confirmedContext.actions).toBeNull(); expect(compact.confirmedContext.actions).toEqual([]);
  expect(unknown.confirmedContext.prohibitedActions).toBeNull(); expect(compact.confirmedContext.prohibitedActions).toEqual([]);
  expect(sameSet(null,[])).toBe(false);
  expect(()=>make(row.originalPrompt,inventory,{confirmedContext:{actions:[]}})).toThrow('CONTEXT_SOURCE_MISSING');
  save('unknown-not-empty',{input:{unknown:request,confirmedEmpty:empty},observed:{unknownContext:unknown.confirmedContext,emptyContext:compact.confirmedContext,sameSetNullEmpty:false,selected:null},expected:'null unknown differs from confirmed []; absent AGENT observation selected stays null'});
 });
 it('unneeded-log-omitted: wire excludes local trace metadata and rejects injected top-level secrets',()=>{
  const inv=structuredClone(inventory); inv.skills[0].sourceRefs.push({path:'SS28_PRIVATE_LOG_AND_SECRET_SENTINEL',digest:hash('trace')});
  const original=make(row.originalPrompt,inv), vendor=buildVendorMessages(original), jev=jevNoulWireAdapter.encode(original,profile(original));
  for(const body of [JSON.stringify(vendor),JSON.stringify(jev)]){
   expect(body).not.toContain('SS28_PRIVATE_LOG_AND_SECRET_SENTINEL'); expect(body).not.toContain('sourceRefs'); expect(body).not.toContain('sourceMap');
  }
  expect(()=>createClassificationRequest({requestId:'SS28',operationId:'SS28',originalPrompt:row.originalPrompt,inventory:inv,classificationCriteriaRef:'criteria',logs:['secret']} as any)).toThrow();
  save('unneeded-log-omitted',{input:original,observed:{vendor,jev,syntheticLocalLogTransmitted:false,unknownTopLevelLogRejected:true},expected:'omit only local trace/binding fields; preserve description, applicability, exclusions and dependencies'});
 });
 it('truncated-question-results known-cost boundary: invalid RESP must retain independently valid observed usage',async()=>{
  const p=profile(), bad={...fullResponse(),judgments:fullResponse().judgments.slice(0,-1)};
  const evaluation={response:bad,usage:{inputTokens:100,outputTokens:10,cachedInputTokens:0,actualCostUsd:0.1},dispatchState:'started' as const,diagnostics:null};
  const vendor={availability:vi.fn(async()=>({available:true,approved:true,routeKind:'remote' as const,reasonCode:null})),classify:vi.fn(async()=>evaluation)};
  const budget=new InMemoryClassificationBudget({jev:{limitUsd:5,spentUsd:0},vendors:{synthetic:{limitUsd:2,spentUsd:0}}});
  const service=new SkillClassificationService({providers:{vendor},budget});
  const result=await service.classify({request,config:{jevEnabled:false,mode:'select',providerProfileRegistryRef:'SS28-synthetic',externalClassificationAllowed:true,configRevision:'SS28',timeoutMs:1000},registry:{schemaVersion:'1.0.0',profileRevision:'SS28',profiles:[p]},currentVendorId:'synthetic'});
  save('known-cost-invalid-response',{input:evaluation,observed:{result,budget:budget.snapshot()},expected:{status:'INVALID',actualCostUsd:0.1,spentUsd:0.1},knownFinding:'valid-cost-lost-with-invalid-RESP; same root cause, do not count as a new defect'});
  expect(result.response.status).toBe('INVALID'); expect(result.attempts[0].usage.actualCostUsd).toBe(0.1); expect(budget.snapshot().limits['vendor:synthetic'].spentUsd).toBe(0.1);
 });
});
