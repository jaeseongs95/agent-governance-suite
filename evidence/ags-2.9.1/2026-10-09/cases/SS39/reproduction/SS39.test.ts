import {beforeAll, describe, expect, it, vi} from 'vitest';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {loadSkillInventory} from '../../mcp-server/src/skill-classification/inventory.js';
import {createClassificationRequest, projectClassificationRequest} from '../../mcp-server/src/skill-classification/request.js';
import {digestProviderProfileConfiguration, estimateTokenCostUsd} from '../../mcp-server/src/skill-classification/profiles.js';
import {SkillClassificationService, InMemoryClassificationBudget} from '../../mcp-server/src/skill-classification/service.js';
import {ApprovedRouteClassificationProvider, unknownUsage} from '../../mcp-server/src/skill-classification/providers.js';
import {createNativeClassificationAdapters} from '../../mcp-server/src/skill-classification/native-adapters.js';
import type {ProviderProfile, ProviderProfileRegistry, SkillInventory, SkillClassificationRequestV1, ProviderEvaluation} from '../../mcp-server/src/skill-classification/types.js';
import type {ApprovedClassificationRoute} from '../../mcp-server/src/skill-classification/providers.js';

// Supplemental cases derived from embedded SS39 fields. No mapping to unnamed original counterexamples.
const root = process.cwd();
const evidence = root + '/.ss39-evidence';
const corpus = JSON.parse(readFileSync(root + '/tests/skill-classification/fixtures.json', 'utf8'));
const ss03 = corpus.cases.find((c: any) => c.caseId === 'SS03');
const now = Date.parse('2026-10-09T00:00:00Z');
let inventory: SkillInventory;
beforeAll(async () => {inventory = await loadSkillInventory({root}); expect(inventory.issues).toEqual([]);});
function request(id: string) {return createClassificationRequest({requestId: id, operationId: id,
  originalPrompt: ss03.originalPrompt, inventory, classificationCriteriaRef: 'skills/orchestrator/references/skill-classification.md'});}
function qualify(p: ProviderProfile) {p.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(p);}
function profile(vendor: 'Vendor-A' | 'Vendor-B', req: SkillClassificationRequestV1): ProviderProfile {
  const p: ProviderProfile = {profileId: vendor + '-profile', providerKind: 'vendor', vendorId: vendor,
    modelId: vendor === 'Vendor-A' ? 'model-a' : 'model-b', modelRevision: 'm1', reasoningEffort: vendor === 'Vendor-A' ? 'low' : null,
    supportedOptions: {structuredOutput: true, reasoningEfforts: vendor === 'Vendor-A' ? ['low'] : [null]},
    approvedRouteRef: vendor + '-route', qualificationRevision: 'synthetic-q1', qualification: {status: 'PASS',
      inventoryDigest: req.inventoryDigest, taxonomyRevision: req.taxonomyRevision, modelRevision: 'm1', promptRevision: 'p1',
      validUntil: '2099-01-01T00:00:00Z', profileConfigurationDigest: ''}, adapterRevision: 'a1', promptRevision: 'p1',
    maximumInputBytes: 1000000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: null};
  qualify(p); return p;
}
function evaluation(req: SkillClassificationRequestV1): ProviderEvaluation {
  // Mechanical response binding only: synthetic judgments are NOT model accuracy or AGENT selection.
  return {response: {schemaVersion: '1.0.0', requestId: req.requestId, operationId: req.operationId,
    requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest, status: 'SUCCESS',
    judgments: req.skills.map(s => ({skillId: s.skillId, judgment: 'not-needed', reasonRefs: ['synthetic-mechanical-response'], uncertaintyReason: null})),
    unresolvedItems: [], error: null}, usage: {...unknownUsage(), actualCostUsd: 0.1}, dispatchState: 'started', diagnostics: null};
}
function rig(id: string, vendor: string = 'Vendor-A') {
  const req = request(id), a = profile('Vendor-A', req), b = profile('Vendor-B', req);
  const registry: ProviderProfileRegistry = {schemaVersion: '1.0.0', profileRevision: 'registry1', profiles: [a,b]};
  const wires: any[] = [], encoded: any[] = [];
  const credentials = vi.fn(async () => 'SYNTHETIC-CREDENTIAL');
  const fetcher = vi.fn(async (url: any, init: any) => {wires.push({url: String(url), body: JSON.parse(init.body), redirect: init.redirect}); return new Response('{}');});
  const adapter = {encode: (r: SkillClassificationRequestV1, p: ProviderProfile) => {
    const wire = {model: p.modelId, reasoningEffort: p.reasoningEffort, profileRevision: registry.profileRevision,
      qualificationRevision: p.qualificationRevision, supportedOptions: p.supportedOptions, payload: projectClassificationRequest(r).payload};
    encoded.push(wire); return wire;
  }, decode: (_: unknown, r: SkillClassificationRequestV1) => evaluation(r)};
  const routes: ApprovedClassificationRoute[] = [a,b].map(p => ({kind: 'remote', routeRef: p.approvedRouteRef, approvalRef: 'synthetic-route-approval', approved: true,
    providerKind: 'vendor', vendorId: p.vendorId, adapterRevision: p.adapterRevision, modelIds: [p.modelId], reasoningEfforts: [p.reasoningEffort], structuredOutput: true,
    endpoint: 'https://ss39.invalid/' + p.vendorId, getCredential: credentials, adapter}));
  const provider = new ApprovedRouteClassificationProvider(routes, fetcher as typeof fetch);
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {'Vendor-A': {limitUsd: 2, spentUsd: 0}, 'Vendor-B': {limitUsd: 2, spentUsd: 0}}});
  const jev = {availability: vi.fn(async () => {throw new Error('forbidden JEV');}), classify: vi.fn(async () => {throw new Error('forbidden JEV');})};
  let clock = now;
  const service = new SkillClassificationService({providers: {vendor: provider, jev}, budget, now: () => clock});
  const input = {request: req, config: {jevEnabled: false, mode: 'select' as const, providerProfileRegistryRef: 'synthetic-central-registry', externalClassificationAllowed: true, configRevision: 'config1', timeoutMs: 1000}, registry, currentVendorId: vendor};
  const snapshot = {taskRevision: null, configRevision: 'config1', profileRevision: 'registry1', inventoryDigest: req.inventoryDigest, requestDigest: req.requestDigest, cancelled: false};
  return {req,a,b,registry,routes,credentials,provider,budget,jev,service,input,wires,encoded,snapshot,setClock: (v: number) => {clock=v;}};
}
function record(id: string, f: ReturnType<typeof rig>, result: any, expected: any) {
  mkdirSync(evidence, {recursive:true});
  writeFileSync(`${evidence}/${id}.json`, JSON.stringify({caseId:'SS39', supplementalId:id, executionKind:'offline-mock', originalVariantMapping:null,
    input:{originalPrompt:f.req.originalPrompt, requestDigest:f.req.requestDigest, inventoryDigest:f.req.inventoryDigest,
      goldenReusedForContext:ss03.oracle, profiles:f.registry, config:f.input.config, currentVendorId:f.input.currentVendorId},
    expected, observed:{result,wires:f.wires,credentialCalls:f.credentials.mock.calls.length,budget:f.budget.snapshot()},
    API0:{JEV:0,externalVendor:0,Claude:0,realNative:0,runtimeCatalog:0,runtimePrice:0},
    stages:{selected:'NOTRUN',read:'NOTRUN',applied:'NOTRUN',verified:'NOTRUN'}, agentSelectedSkillIds:null, hostReceipt:null},null,2));
  expect(f.jev.availability).not.toHaveBeenCalled(); expect(f.jev.classify).not.toHaveBeenCalled();
  expect(result).not.toHaveProperty('agentSelectedSkillIds');
}

describe('SS39 supplemental embedded-requirement boundaries', () => {
  it.each(['Vendor-A','Vendor-B'])('SS39-DEV fixed %s wire preserves model effort full workload', async vendor => {
    const id='SS39-DEV-fixed-'+vendor, f=rig(id,vendor), result=await f.service.classify(f.input);
    const expected={model:vendor==='Vendor-A'?'model-a':'model-b',reasoningEffort:vendor==='Vendor-A'?'low':null};
    record(id,f,result,{...expected,status:'SUCCESS',mockFetchCalls:1,agentSelectedSkillIds:null});
    expect(result.response.status).toBe('SUCCESS'); expect(f.wires).toHaveLength(1);
    expect(f.wires[0].body).toMatchObject(expected); expect(f.wires[0].url).toBe('https://ss39.invalid/'+vendor);
    expect(f.wires[0].body.payload.originalPrompt).toBe(ss03.originalPrompt);
    expect(f.wires[0].body.payload.skills.map((s:any)=>s.skillId)).toEqual(inventory.skills.map(s=>s.skillId));
    expect(f.wires[0].body.payload.confirmedContext.actions).toBeNull();
    expect(result.attempts[0].reasoningEffort).toBe(expected.reasoningEffort);
  });
  const holds = ['missing','ambiguous','unqualified','expired','unsupported-effort','unsupported-structured','old-fingerprint','unknown-cost','route-unapproved','route-model-unavailable','egress','budget'];
  const codes = ['PROFILE_UNAVAILABLE','PROFILE_UNAVAILABLE','PROFILE_UNQUALIFIED','QUALIFICATION_EXPIRED','UNSUPPORTED_OPTIONS','UNSUPPORTED_OPTIONS','QUALIFICATION_CONFIGURATION_MISMATCH','COST_UNKNOWN','ROUTE_NOT_APPROVED','ROUTE_CAPABILITY_MISMATCH','EXTERNAL_CLASSIFICATION_BLOCKED','BUDGET_UNAVAILABLE'];
  it.each(holds)('SS39-DEV hold %s never sends or substitutes another vendor', async kind => {
    const id='SS39-DEV-hold-'+kind, f=rig(id);
    if(kind==='missing') f.input.currentVendorId='unknown-vendor';
    if(kind==='ambiguous') {const p=structuredClone(f.a);p.profileId='duplicate-vendor';qualify(p);f.registry.profiles.push(p);}
    if(kind==='unqualified') f.a.qualification.status='NOT_RUN';
    if(kind==='expired') f.a.qualification.validUntil=new Date(now).toISOString();
    if(kind==='unsupported-effort') {f.a.reasoningEffort='high';qualify(f.a);}
    if(kind==='unsupported-structured') {f.a.supportedOptions.structuredOutput=false;qualify(f.a);}
    if(kind==='old-fingerprint') f.a.modelId='premium';
    if(kind==='unknown-cost') {f.a.maximumCostUsd=null;qualify(f.a);}
    if(kind==='route-unapproved') f.routes[0].approved=false;
    if(kind==='route-model-unavailable') f.routes[0].modelIds=[];
    if(kind==='egress') f.input.config.externalClassificationAllowed=false;
    if(kind==='budget') f.budget.reserve(f.a,'preexisting-reservation',2);
    const result=await f.service.classify(f.input), code=codes[holds.indexOf(kind)];
    record(id,f,result,{errorCode:code,mockFetchCalls:0,noModelSubstitution:true});
    expect(result.response.error?.code).toBe(code);expect(f.wires).toEqual([]);
  });
  it('SS39-DEV valid update takes next request after explicit revision and synthetic qualification', async () => {
    const id='SS39-DEV-update',f=rig(id);
    const first=await f.service.classify(f.input);expect(first.attempts[0].modelId).toBe('model-a');
    f.registry.profileRevision='registry2';f.a.modelId='model-a-v2';f.a.modelRevision='m2';f.a.qualification.modelRevision='m2';
    f.a.qualificationRevision='synthetic-q2';qualify(f.a);f.routes[0].modelIds.push('model-a-v2');
    f.input.request=request(id+'-next');
    const result=await f.service.classify(f.input);record(id,f,result,{model:'model-a-v2',profileRevision:'registry2',mockFetchCalls:2});
    expect(result.response.status).toBe('SUCCESS');expect(result.profileRevision).toBe('registry2');expect(result.attempts[0].modelId).toBe('model-a-v2');
    expect(f.wires.map(w=>w.body.model)).toEqual(['model-a','model-a-v2']);
  });
  it('SS39-DEV stale revision after availability blocks before transport', async () => {
    const id='SS39-DEV-stale-availability',f=rig(id);
    f.credentials.mockImplementation(async()=>{f.snapshot.profileRevision='registry2';return 'SYNTHETIC-CREDENTIAL';});
    const result=await f.service.classify({...f.input,getCurrentSnapshot:()=>f.snapshot});
    record(id,f,result,{errorCode:'STALE_CLASSIFICATION',mockFetchCalls:0});
    expect(result.response.error?.code).toBe('STALE_CLASSIFICATION');expect(f.wires).toEqual([]);
  });
  it('SS39-DEV profile freeze prevents caller model mutation during availability', async () => {
    const id='SS39-DEV-freeze',f=rig(id);const pending=f.service.classify(f.input);f.a.modelId='premium';
    const result=await pending;record(id,f,result,{model:'model-a',mockFetchCalls:1});
    expect(result.attempts[0].modelId).toBe('model-a');expect(f.wires[0].body.model).toBe('model-a');
  });
  it('SS39-DEV qualification expires during availability must hold before dispatch', async () => {
    const id='SS39-DEV-expiry-race',f=rig(id);f.a.qualification.validUntil=new Date(now+1).toISOString();
    f.credentials.mockImplementation(async()=>{f.setClock(now+2);return 'SYNTHETIC-CREDENTIAL';});
    const result=await f.service.classify(f.input);record(id,f,result,{errorCode:'QUALIFICATION_EXPIRED',mockFetchCalls:0});
    expect(f.wires,'expired qualification must never be transmitted').toHaveLength(0);
    expect(result.response.error?.code).toBe('QUALIFICATION_EXPIRED');
  });
  it('SS39-DEV profile revision changes during second credential await must hold before dispatch', async () => {
    const id='SS39-DEV-stale-credential',f=rig(id);let n=0;
    f.credentials.mockImplementation(async()=>{if(++n===2)f.snapshot.profileRevision='registry2';return 'SYNTHETIC-CREDENTIAL';});
    const result=await f.service.classify({...f.input,getCurrentSnapshot:()=>f.snapshot});
    record(id,f,result,{errorCode:'STALE_CLASSIFICATION',mockFetchCalls:0});
    expect(result.response.error?.code).toBe('STALE_CLASSIFICATION');
    expect(f.wires,'response rejection must also prevent obsolete profile transmission').toHaveLength(0);
  });
  it('SS39-DEV invalid response retains valid actual cost and ceiling invalidation', async () => {
    const id='SS39-DEV-invalid-response-cost',f=rig(id);
    if(f.routes[0].kind==='remote') f.routes[0].adapter.decode=(_,r)=>{const e=evaluation(r);e.response.requestDigest=`sha256:${'0'.repeat(64)}`;e.usage.actualCostUsd=0.6;return e;};
    const result=await f.service.classify(f.input);record(id,f,result,{errorCode:'INVALID_PROVIDER_RESPONSE',actualCostUsd:0.6,spentUsd:0.6,invalidCostCeilings:['Vendor-A-profile']});
    expect(result.response.error?.code).toBe('INVALID_PROVIDER_RESPONSE');
    expect(result.attempts[0].usage.actualCostUsd,'valid cost must survive malformed classification').toBe(0.6);
    expect(f.budget.snapshot().limits['vendor:Vendor-A'].spentUsd).toBe(0.6);
    expect(f.budget.snapshot().invalidCostCeilings).toContain('Vendor-A-profile');
  });
  it('SS39-DEV offline workload cost calculation preserves unknown cache and prices', () => {
    const id='SS39-DEV-cost',f=rig(id),a={uncachedInputUsdPer1k:2,cachedInputUsdPer1k:.2,outputUsdPer1k:1},b={uncachedInputUsdPer1k:1,cachedInputUsdPer1k:.8,outputUsdPer1k:5};
    const actual=[estimateTokenCostUsd(a,1000,800,100),estimateTokenCostUsd(b,1000,800,100),estimateTokenCostUsd(a,1000,0,100),estimateTokenCostUsd(b,1000,0,100),estimateTokenCostUsd({...a,cachedInputUsdPer1k:null},1000,800,100)];
    record(id,f,{attempts:[],costs:actual},{costs:[.66,1.34,2.1,1.5,null],qualificationQuality:'NOTRUN'});
    for(let i=0;i<4;i++)expect(actual[i]).toBeCloseTo([.66,1.34,2.1,1.5][i]);expect(actual[4]).toBeNull();
  });
  it('SS39-DEV native Codex adapter forwards fixed model effort without spawning host', async () => {
    const id='SS39-DEV-native-encode',f=rig(id);let invocation:any;
    const runner=vi.fn(async (i:any)=>{invocation={...i,args:i.args.map((a:string)=>a.includes('.ags-native-')?'[temporary-schema]':a)};
      return {exitCode:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(evaluation(f.req).response)}})+'\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}})};});
    const adapters=createNativeClassificationAdapters([{adapterId:'mock-codex',host:'codex',executable:'/host/codex',workingDirectory:root,
      approvalRef:'synthetic-native-approval',capabilityEvidenceRef:'synthetic-structured',retryPolicyVerified:true,retryPolicyEvidenceRef:'synthetic-no-retry',isolationEvidenceRef:'synthetic-isolation',isolationArgs:[],timeoutMs:1000,maximumOutputBytes:1000000}],runner);
    const result=await adapters.get('mock-codex')!.invokeStructured(f.req,f.a,new AbortController().signal);
    record(id,f,{attempts:[],nativeMock:result,invocation},{model:'model-a',reasoningEffort:'low',mockRunnerCalls:1,realNativeCalls:0});
    expect(runner).toHaveBeenCalledTimes(1);expect(invocation.args).toContain('model-a');expect(invocation.args).toContain('model_reasoning_effort="low"');
    expect(result.usage.actualCostUsd).toBeNull();
  });
});
