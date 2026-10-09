import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createClassificationRequest, digestClassificationValue } from '../../mcp-server/src/skill-classification/request.js';
import { digestProviderProfileConfiguration } from '../../mcp-server/src/skill-classification/profiles.js';
import { validateClassificationResponse, validateDecision } from '../../mcp-server/src/skill-classification/validation.js';
import { InMemoryClassificationBudget, SkillClassificationService } from '../../mcp-server/src/skill-classification/service.js';
import { ApprovedRouteClassificationProvider, jevNoulWireAdapter, unknownUsage } from '../../mcp-server/src/skill-classification/providers.js';
import { RuntimeSkillClassificationGateway } from '../../mcp-server/src/skill-classification/gateway.js';
import { loadSkillInventory } from '../../mcp-server/src/skill-classification/inventory.js';
import type { ClassificationResult, ProviderEvaluation, ProviderProfile, SkillMetadata, SkillSelectionDecisionV1 } from '../../mcp-server/src/skill-classification/types.js';

// SS27 only. All providers/fetch are mocks. No host receipt is created, no CLI host is spawned.
// Non-finite numbers are tagged when serialized so NaN is not silently converted to null.
const encode = (x: unknown) => JSON.stringify(x, (_key, value) => typeof value === 'number' && !Number.isFinite(value) ? {$number: String(value)} : value, 2);
const corpus = JSON.parse(readFileSync('tests/skill-classification/fixtures.json', 'utf8'));
const fixture = corpus.cases.find((x: any) => x.caseId === 'SS27');
const rows: any[] = [], boundaries: any[] = [];
const fixedNow = Date.parse('2026-10-09T00:00:00Z');
function setup(variant: string, cost: number | null = null) {
  const skills: SkillMetadata[] = ['cs-engineering', 'software-security-auditor', 'test-engineering'].map(skillId => ({skillId, version:'synthetic-SS27', description:'SS27 mechanical input only', enabled:true, installed:true, hostSupported:true, capabilities:['mechanical-test'], actions:['mechanical-test'], targets:['provider-output'], constraints:[], applicability:['synthetic mechanical contract'], exclusions:['semantic quality assessment'], dependencies:[], phases:[], sourceRefs:[]}));
  if (variant === 'disabled') skills[1].enabled = false;
  if (variant === 'unsupported') skills[1].hostSupported = false;
  if (variant === 'not-installed') skills[1].installed = false;
  const request = createClassificationRequest({requestId:`SS27-${variant}`, operationId:`SS27-${variant}`, originalPrompt:fixture.sourceSpec.fields['입력'], inventory:{skills, issues:[], inventoryDigest:digestClassificationValue(skills), taxonomyRevision:'SS27-synthetic'}, classificationCriteriaRef:'embedded:SS27/sourceSpec.fields'});
  const response: any = {schemaVersion:'1.0.0', requestId:request.requestId, operationId:request.operationId, requestDigest:request.requestDigest, inventoryDigest:request.inventoryDigest, status:'SUCCESS', judgments:skills.map(s=>({skillId:s.skillId, judgment:s.skillId === 'software-security-auditor' ? 'needed' : 'not-needed', reasonRefs:['embedded:SS27'], uncertaintyReason:null})), unresolvedItems:[], error:null};
  const profile = (kind:'jev'|'vendor'):ProviderProfile => {
    const p:ProviderProfile = {profileId:`mock-${kind}`, providerKind:kind, vendorId:kind === 'jev' ? 'mock-typesafe' : 'mock-vendor', modelId:`mock-${kind}`, modelRevision:`mock-${kind}`, reasoningEffort:null, supportedOptions:{reasoningEfforts:[null],structuredOutput:true}, approvedRouteRef:`mock-${kind}-route`, qualificationRevision:'synthetic-only', qualification:{status:'PASS',inventoryDigest:request.inventoryDigest,taxonomyRevision:request.taxonomyRevision,modelRevision:`mock-${kind}`,promptRevision:'SS27',validUntil:'2099-01-01T00:00:00Z',profileConfigurationDigest:''}, adapterRevision:'mock',promptRevision:'SS27',maximumInputBytes:100000,maximumOutputTokens:1000,maximumCostUsd:0.4,judgmentPolicy:kind==='jev'?{neededAt:0.8,notNeededAt:0.2}:null};
    p.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(p); return p;
  };
  const diagnostics:any = variant === 'nan-score' ? {scoreKind:'noul_probability',scores:[{skillId:'software-security-auditor',value:NaN}]} : null;
  const evaluation:ProviderEvaluation = {response,usage:{...unknownUsage(),actualCostUsd:cost},dispatchState:'started',diagnostics};
  const baseline:any = {...response,judgments:response.judgments.map((j:any)=>({...j,judgment:j.skillId==='test-engineering'?'needed':'not-needed',reasonRefs:['synthetic baseline vendor']}))};
  const port = (reply:ProviderEvaluation) => ({availability:vi.fn(async()=>({available:true,approved:true,routeKind:'remote' as const,reasonCode:null})),classify:vi.fn(async()=>reply)});
  const jev=port(evaluation), vendor=port({...evaluation,response:baseline,diagnostics:null,usage:unknownUsage()});
  const budget = new InMemoryClassificationBudget({jev:{limitUsd:5,spentUsd:0},vendors:{'mock-vendor':{limitUsd:5,spentUsd:0}}});
  const service = new SkillClassificationService({providers:{jev,vendor},budget,now:()=>fixedNow});
  const input = {request,config:{jevEnabled:true,mode:'select' as const,providerProfileRegistryRef:'mock-profile',externalClassificationAllowed:true,configRevision:'SS27',timeoutMs:1000},registry:{schemaVersion:'1.0.0' as const,profileRevision:'SS27',profiles:[profile('jev'),profile('vendor')]},currentVendorId:'mock-vendor'};
  return {skills,request,response,evaluation,baseline,jev,vendor,budget,service,input,profile};
}
function mutate(f:ReturnType<typeof setup>, variant:string) {
  if(variant==='unknown-id') f.response.judgments[0].skillId='unregistered-SS27';
  if(variant==='duplicate-id') f.response.judgments.push({...f.response.judgments[0],judgment:'needed'}); // conflicting CS response
  if(variant==='invalid-judgment') f.response.judgments[0].judgment='yes';
  if(variant==='omitted-id') f.response.judgments.splice(0,1);
  if(variant==='additional-id') f.response.judgments.push({...f.response.judgments[0],skillId:'orchestrator'}); // repo known, absent from this supplied inventory
}
function proposal(result:ClassificationResult, selected:string[]|null, selectionStatus:'SELECTED'|'PARTIAL'|'NEEDS_INPUT'='PARTIAL'):SkillSelectionDecisionV1 {
  return {schemaVersion:'1.0.0',classificationResponseRef:digestClassificationValue(result.response),requestDigest:result.request.requestDigest,inventoryDigest:result.request.inventoryDigest,taskRevision:null,configRevision:'SS27',profileRevision:'SS27',explicitSkillIds:[],ruleRequiredSkillIds:[],agentSelectedSkillIds:selected,selectionReasons:(selected??[]).map(skillId=>({skillId,reason:'synthetic boundary proposal; not actual AGENT selection'})),applicabilityChecks:(selected??[]).map(skillId=>({skillId,applies:true,excluded:false,reasonRefs:['embedded:SS27']})),unresolvedSkillReferences:[],selectionStatus,adviceApplied:false,hostReceipt:null};
}
const errors:Record<string,string[]> = {'unknown-id':['UNKNOWN_SKILL_ID','MISSING_CANDIDATE_JUDGMENT'],'duplicate-id':['DUPLICATE_SKILL_ID'],'disabled':[],'unsupported':[],'invalid-judgment':['INVALID_RESPONSE_SCHEMA'],'nan-score':[],'omitted-id':['MISSING_CANDIDATE_JUDGMENT'],'additional-id':['UNKNOWN_SKILL_ID']};
describe('SS27 frozen variants',()=>{
  it.each(fixture.variants)('SS27 variant %s response, service and execution availability',async(variant:string)=>{
    const f=setup(variant); mutate(f,variant);
    const validationErrors=validateClassificationResponse(f.request,f.response);
    const result=await f.service.classify(f.input);
    const blocked=['disabled','unsupported'].includes(variant);
    const checked=blocked?validateDecision(result,proposal(result,['software-security-auditor']),result.snapshot):null;
    const reasonCodesRetained=variant==='nan-score'?true:errors[variant].every(code=>JSON.stringify(result).includes(code));
    rows.push({variant,status:blocked||reasonCodesRetained?'PASS':'FAIL',executionKind:'new-isolated-offline-mock',input:{originalPrompt:fixture.originalPrompt,mechanicalPromptSource:'embedded sourceSpec.fields.입력; synthetic API request string, not missing user originalPrompt',request:f.request,providerEvaluation:f.evaluation},expected:{validationErrors:errors[variant],firstAttemptStatus:blocked?'SUCCESS':'INVALID',firstAttemptError:blocked?null:variant==='nan-score'?'INVALID_PROVIDER_USAGE':'INVALID_PROVIDER_RESPONSE',fallback:!blocked,neededSkillIds:blocked?['software-security-auditor']:null,runnableSkillIds:blocked?[]:null,preserveRawFailureReasons:true},observed:{validationErrors,result,selectionBoundary:checked,portCalls:{jevMock:f.jev.classify.mock.calls.length,vendorMock:f.vendor.classify.mock.calls.length},reasonCodesRetained},checks:{safety:'PASS',availabilityBoundary:blocked?'PASS':'NOT_APPLICABLE',rawFailureReasons:reasonCodesRetained?'PASS':'FAIL'},actualHost:{selected:{status:'NOTRUN',skillIds:null},read:{status:'NOTRUN',skillIds:null},applied:{status:'NOTRUN',skillIds:null},verified:{status:'NOTRUN',skillIds:null},hostReceipt:null}});
    expect(validationErrors).toEqual(errors[variant]);
    expect(f.jev.classify).toHaveBeenCalledTimes(1);
    expect(f.vendor.classify).toHaveBeenCalledTimes(blocked?0:1);
    expect(result.attempts[0].status).toBe(blocked?'SUCCESS':'INVALID');
    if(blocked){expect(checked?.neededSkillIds).toEqual(['software-security-auditor']);expect(checked?.runnableSkillIds).toEqual([]);expect(checked?.blockedItems).toEqual([{skillId:'software-security-auditor',reasonCode:variant==='disabled'?'DISABLED':'HOST_UNSUPPORTED'}]);expect(checked?.errors).toEqual(['HOST_RECEIPT_MISMATCH']);
      expect(validateDecision(result,proposal(result,['software-security-auditor'],'SELECTED'),result.snapshot).errors).toContain('UNRESOLVED_SELECTION_MARKED_COMPLETE');
    }else {expect(result.attempts[0].errorCode).toBe(variant==='nan-score'?'INVALID_PROVIDER_USAGE':'INVALID_PROVIDER_RESPONSE');expect(result.response).toEqual(f.baseline);expect(result.attempts).toHaveLength(2);expect(result).not.toHaveProperty('agentSelectedSkillIds');}
  });
});
describe('SS27 additional boundaries and defect witnesses',()=>{
  it('SS27 uninstalled known skill remains needed and cannot run',async()=>{
    const f=setup('not-installed'); const result=await f.service.classify(f.input);const checked=validateDecision(result,proposal(result,['software-security-auditor']),result.snapshot);
    boundaries.push({id:'not-installed',status:'PASS',input:result.request.skills,observed:checked});expect(checked.neededSkillIds).toEqual(['software-security-auditor']);expect(checked.runnableSkillIds).toEqual([]);expect(checked.blockedItems).toEqual([{skillId:'software-security-auditor',reasonCode:'NOT_INSTALLED'}]);
  });
  it('SS27 true NaN score is rejected by JEV decoder before JSON serialization',()=>{
    const f=setup('nan-direct');const body={model:'mock-jev',answers:Object.fromEntries(f.skills.map(s=>[s.skillId,{type:'noul',noul:s.skillId==='cs-engineering'?NaN:0.9}])),usage:{input_tokens:10,output_tokens:2}};
    boundaries.push({id:'nan-direct',status:'PASS',input:body,expected:'INVALID_JEV_SCORE'});expect(()=>jevNoulWireAdapter.decode(body,f.request,f.profile('jev'))).toThrow('INVALID_JEV_SCORE');
  });
  it('SS27 valid independent baseline does not union rejected raw advice',async()=>{
    const f=setup('unknown-id');mutate(f,'unknown-id');const result=await f.service.classify(f.input);boundaries.push({id:'baseline-exact-set',status:'PASS',observed:result.response});expect(result.response.judgments.filter(j=>j.judgment==='needed').map(j=>j.skillId)).toEqual(['test-engineering']);
  });
  it('SS27 no actual receipt cannot become observed no-skill []',async()=>{
    const f=setup('no-selection');const result=await f.service.classify(f.input);const none=validateDecision(result,proposal(result,null,'NEEDS_INPUT'),result.snapshot),empty=validateDecision(result,proposal(result,[],'SELECTED'),result.snapshot);
    boundaries.push({id:'null-vs-empty',status:'PASS',observed:{unobserved:none,claimedEmptyWithoutReceipt:empty}});expect(none.errors).toEqual([]);expect(empty.errors).toContain('HOST_RECEIPT_MISMATCH');
  });
  it('SS27 DEFECT preserves finite known cost when malformed response is INVALID',async()=>{
    const f=setup('duplicate-id',0.1);mutate(f,'duplicate-id');const result=await f.service.classify(f.input);const budget=f.budget.snapshot();boundaries.push({id:'known-cost-invalid-response',status:'FAIL',linksExistingFinding:'valid cost lost with invalid RESP',input:f.evaluation,expected:{actualCostUsd:0.1,jevSpentUsd:0.1},observed:{attempt:result.attempts[0],budget}});expect(result.attempts[0].usage.actualCostUsd).toBe(0.1);expect(budget.limits.jev.spentUsd).toBe(0.1);
  });
  it('SS27 DEFECT preserves specific raw membership error after fallback',async()=>{
    const f=setup('unknown-id');mutate(f,'unknown-id');const rawErrors=validateClassificationResponse(f.request,f.response);const result=await f.service.classify(f.input);boundaries.push({id:'raw-error-provenance',status:'FAIL',input:f.evaluation,expected:rawErrors,observed:result});expect(JSON.stringify(result)).toContain('UNKNOWN_SKILL_ID');
  });
  it('SS27 DEFECT rejects duplicate JSON answer keys at provider wire boundary',async()=>{
    const f=setup('duplicate-wire');const wire='{"model":"mock-jev","answers":{"cs-engineering":{"type":"noul","noul":0.1},"cs-engineering":{"type":"noul","noul":0.9},"software-security-auditor":{"type":"noul","noul":0.1},"test-engineering":{"type":"noul","noul":0.1}},"usage":{"input_tokens":10,"output_tokens":2}}';
    const fetcher=vi.fn<typeof fetch>(async()=>new Response(wire));
    const route:any={routeRef:'mock-jev-route',approvalRef:'synthetic-only',approved:true,providerKind:'jev',vendorId:'mock-typesafe',adapterRevision:'mock',modelIds:['mock-jev'],reasoningEfforts:[null],structuredOutput:true,kind:'remote',endpoint:'https://never-called.invalid',getCredential:async()=>'MOCK_ONLY',adapter:jevNoulWireAdapter};
    const provider=new ApprovedRouteClassificationProvider([route],fetcher);let observed:any;
    try {observed=await provider.classify(f.request,f.profile('jev'),new AbortController().signal);}catch(error){observed={error:String(error)};}
    boundaries.push({id:'duplicate-json-key',status:observed.error?'PASS':'FAIL',input:{rawWire:wire},expected:'INVALID_PROVIDER_RESPONSE; duplicate provider answers must not be accepted',observed,mockFetchCalls:fetcher.mock.calls.length,externalAPICalls:0});expect(observed).toHaveProperty('error');
  });
  it('SS27 DEFECT runtime inventory has no path to current host support observation',async()=>{
    const explicit=await loadSkillInventory({root:process.cwd(),hostSupportedSkillIds:[]});
    const gateway=new RuntimeSkillClassificationGateway({root:process.cwd(),service:new SkillClassificationService({providers:{},budget:new InMemoryClassificationBudget({jev:{limitUsd:null,spentUsd:null},vendors:{}})}),readRuntime:async()=>({config:{jevEnabled:false,mode:'select',providerProfileRegistryRef:'unconfigured',externalClassificationAllowed:false,configRevision:'unconfigured',timeoutMs:1000},registry:{schemaVersion:'1.0.0',profileRevision:'unconfigured',profiles:[]},allowRemotePrivateContent:false})});
    const observed:any=await gateway.inventory();boundaries.push({id:'host-state-supply',status:'FAIL',linksExistingFinding:'host active state supply gap',input:{hostSupportedSkillIds:[],interpretation:'synthetic explicit host observer reports zero supported skills; current real host support unknown'},expected:explicit.skills.map(s=>({skillId:s.skillId,hostSupported:s.hostSupported})),observed:observed.skills.map((s:any)=>({skillId:s.skillId,hostSupported:s.hostSupported})),inventoryIssues:observed.issues});expect(observed.skills.filter((s:any)=>s.hostSupported)).toHaveLength(0);
  });
});
afterAll(()=>writeFileSync('evidence/SS27/observations.json',encode({caseId:'SS27',originalPrompt:fixture.originalPrompt,oracle:fixture.oracle,fixture,variants:rows,boundaries,externalCalls:{jev:0,vendorAPI:0,claude:0},warning:'Mock calls and test proposals are not real AGENT selections; no host receipt was created.'})));
