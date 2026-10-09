import {readFileSync, writeFileSync} from 'node:fs';
import {afterAll, describe, expect, it} from 'vitest';
import {RuntimeSkillClassificationGateway} from '../../mcp-server/src/skill-classification/gateway.js';
import {loadSkillInventory} from '../../mcp-server/src/skill-classification/inventory.js';
import {digestClassificationValue} from '../../mcp-server/src/skill-classification/request.js';
import {digestProviderProfileConfiguration} from '../../mcp-server/src/skill-classification/profiles.js';
import {InMemoryClassificationBudget, SkillClassificationService} from '../../mcp-server/src/skill-classification/service.js';
import {validateDecision} from '../../mcp-server/src/skill-classification/validation.js';
import {oracleDigest, scoreCase, sameSet} from '../skill-classification/evaluation.js';

const root = new URL('../../', import.meta.url).pathname;
const corpus = JSON.parse(readFileSync(root + 'tests/skill-classification/fixtures.json', 'utf8'));
const fixture = corpus.cases.find((c: any) => c.caseId === 'SS22');
// SS03 is referenced input data only; no SS03 case or historical live run executes.
const prompt = corpus.cases.find((c: any) => c.caseId === 'SS03').originalPrompt;
const B = ['ponytail'];
const R = ['ponytail', 'cs-engineering', 'test-engineering', 'orchestrator'];
const records: any[] = [];
const stages = {selected:'NOTRUN', read:'NOTRUN', applied:'NOTRUN', verified:'NOTRUN'};
afterAll(() => writeFileSync('./SS22-output/SS22.observations.json', JSON.stringify({
  caseId:'SS22', executionKind:'new-isolated-offline-mock', externalApiCalls:0,
  syntheticHostBoundary:true, realAgentSelection:false, records
}, null, 2) + '\n'));

async function harness(mode: 'shadow'|'select', suffix: string) {
  const inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
  const profile: any = {profileId:'ss22-mock-jev', providerKind:'jev', vendorId:'ss22-mock',
    modelId:'mock-only', modelRevision:'mock-only-v1', reasoningEffort:null,
    supportedOptions:{reasoningEfforts:[null], structuredOutput:true}, approvedRouteRef:'fixture:local-port',
    qualificationRevision:'mock-only', qualification:{status:'PASS', inventoryDigest:inventory.inventoryDigest,
      taxonomyRevision:inventory.taxonomyRevision, modelRevision:'mock-only-v1', promptRevision:'mock-v1',
      validUntil:'2099-01-01T00:00:00Z', profileConfigurationDigest:''}, adapterRevision:'mock-v1',
    promptRevision:'mock-v1', maximumInputBytes:2_000_000, maximumOutputTokens:1000,
    maximumCostUsd:0, judgmentPolicy:{neededAt:0.8, notNeededAt:0.2}};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const runtime: any = {config:{jevEnabled:true, mode, providerProfileRegistryRef:'fixture:mock-only',
      externalClassificationAllowed:false, configRevision:'ss22-'+mode, timeoutMs:2000},
    registry:{schemaVersion:'1.0.0', profileRevision:'ss22-mock-v1', profiles:[profile]}, allowRemotePrivateContent:false};
  let mockProviderCalls = 0;
  const capturedRequests: any[] = [];
  const provider: any = {
    availability:async () => ({available:true, approved:true, routeKind:'native', reasonCode:null}),
    classify:async (request: any) => {
      mockProviderCalls++; capturedRequests.push(structuredClone(request));
      return {response:{schemaVersion:'1.0.0', requestId:request.requestId, operationId:request.operationId,
        requestDigest:request.requestDigest, inventoryDigest:request.inventoryDigest, status:'SUCCESS',
        judgments:request.skills.map((s: any) => ({skillId:s.skillId, judgment:R.includes(s.skillId)?'needed':'not-needed',
          reasonRefs:['fixture:SS22-embedded-input'], uncertaintyReason:null})), unresolvedItems:[], error:null},
        usage:{inputTokens:null, outputTokens:null, cachedInputTokens:null, actualCostUsd:0},
        dispatchState:'started', diagnostics:null};
    }
  };
  const service = new SkillClassificationService({providers:{jev:provider},
    budget:new InMemoryClassificationBudget({jev:{limitUsd:0,spentUsd:0},vendors:{},
      nativeAllowances:{'ss22-mock-jev':{approvalRef:'fixture:mock-only',remainingCalls:100}}})});
  let acceptReadHook: null|(() => void) = null;
  let task: any = null;
  const gateway = new RuntimeSkillClassificationGateway({root, service,
    readRuntime:async () => {acceptReadHook?.(); return runtime;},
    observeRuntime:() => digestClassificationValue(runtime),
    observeTask:(request, observation) => {
      if (!observation) return null;
      task ??= {taskRevision:null, requestDigest:request.requestDigest, cancelled:false, sourceRef:'fixture:synthetic-host-task'};
      return task;
    }});
  const input: any = {schemaVersion:'1.0.0',requestId:`SS22-${mode}-${suffix}`,operationId:`SS22-op-${mode}-${suffix}`,
    originalPrompt:prompt, confirmedContext:{taskRevision:null,objective:null,actions:null,targets:null,
      constraints:null,prohibitedActions:null,background:null}, contextSources:[], explicitSkillIds:[],ruleRequiredSkillIds:[],
    vendorContext:{vendorId:'ss22-mock',reference:'fixture:mock-only'}, publicSynthetic:true};
  // Injected component-test observation; never a native host attestation.
  const observation = (digest: string): any => ({schemaVersion:'1.0.0', model:'synthetic-only', modelClass:'general',
    reasoningEffort:'high',source:'runtime',observedAt:new Date().toISOString(),
    expiresAt:new Date(Date.now()+60_000).toISOString(),observationId:'synthetic-only-SS22-'+suffix,
    taskId:digest,actorId:'mock-host:ss22'});
  const advice: any = await gateway.classify(input, observation('intake'));
  expect(advice.result.response.error).toBeNull();
  expect(advice.result.attempts).toHaveLength(1);
  const decision = (ids: string[]|null, applied: boolean): any => ({schemaVersion:'1.0.0',
    classificationResponseRef:advice.classificationResponseRef, ...Object.fromEntries(
      ['requestDigest','inventoryDigest','taskRevision','configRevision','profileRevision'].map(k=>[k,advice.result.snapshot[k]])),
    explicitSkillIds:[],ruleRequiredSkillIds:[],agentSelectedSkillIds:ids,
    selectionReasons:(ids??[]).map(skillId=>({skillId,reason:'Synthetic boundary input, no real AGENT claim'})),
    applicabilityChecks:(ids??[]).map(skillId=>({skillId,applies:true,excluded:false,reasonRefs:['fixture:SS22']})),
    unresolvedSkillReferences:[],selectionStatus:ids===null?'PROPOSED':'SELECTED',adviceApplied:applied,hostReceipt:null});
  const accept = (d: any, obs: any = observation(d.requestDigest)) => gateway.accept({schemaVersion:'1.0.0',operationId:input.operationId,decision:d},obs) as Promise<any>;
  return {gateway, input, advice, decision, accept, observation, runtime, capturedRequests,
    calls:()=>mockProviderCalls, task:()=>task, onRead:(fn:()=>void)=>{acceptReadHook=fn;}};
}

describe('SS22 all variants with independent offline boundaries', () => {
  it('SS22 fixture integrity and operational nulls are preserved', () => {
    expect(oracleDigest(corpus)).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
    expect(fixture.originalPrompt).toBeNull(); expect(fixture.oracle).toBeNull();
    expect(fixture.variants).toEqual(['shadow','select']);
    expect(sameSet(null,[])).toBe(false);
    expect(()=>scoreCase(fixture,undefined,corpus.inventorySkillIds)).toThrow('NO_SEMANTIC_ORACLE:SS22');
  });
  it('SS22 shadow observes raw, preserves B omissions and never adopts advice', async () => {
    const h = await harness('shadow','base');
    expect(h.advice.agentSelectedSkillIds).toBeNull(); expect(h.advice.selectionStatus).toBe('PROPOSED');
    expect(h.advice.adviceApplied).toBe(false);
    const raw = h.advice.result.response.judgments.filter((x:any)=>x.judgment==='needed').map((x:any)=>x.skillId);
    expect(new Set(raw)).toEqual(new Set(R));
    const d = h.decision(B,false), accepted = await h.accept(d);
    expect(accepted.valid).toBe(true); expect(accepted.decision.agentSelectedSkillIds).toEqual(B);
    expect(accepted.decision.adviceApplied).toBe(false);
    expect(accepted.readStatus).toBe('NOT_OBSERVED'); expect(accepted.appliedStatus).toBe('NOT_OBSERVED');
    expect(accepted.verifiedStatus).toBe('NOT_RUN');
    const missing = R.filter(x=>!B.includes(x));
    expect(missing).toEqual(['cs-engineering','test-engineering','orchestrator']);
    records.push({variant:'shadow',status:'PASS_OFFLINE_ONLY',input:h.input,expected:{raw:R,selected:B,adviceApplied:false},
      observed:{raw,selected:accepted.decision.agentSelectedSkillIds,adviceApplied:accepted.decision.adviceApplied,
        gatewayValidation:accepted,baselineQuality:'FAIL',missingRequired:missing},mockProviderCalls:h.calls(),stages});
  });
  it('SS22 select records supplied full selection only at synthetic acceptance boundary', async () => {
    const h = await harness('select','base');
    expect(h.advice.agentSelectedSkillIds).toBeNull(); expect(h.advice.adviceApplied).toBe(false);
    const accepted = await h.accept(h.decision(R,true));
    expect(accepted.valid).toBe(true); expect(new Set(accepted.decision.agentSelectedSkillIds)).toEqual(new Set(R));
    expect(accepted.decision.adviceApplied).toBe(true);
    expect(accepted.readStatus).toBe('NOT_OBSERVED'); expect(accepted.appliedStatus).toBe('NOT_OBSERVED');
    expect(accepted.verifiedStatus).toBe('NOT_RUN');
    records.push({variant:'select',status:'PASS_OFFLINE_ONLY',input:h.input,expected:{selected:R,adviceApplied:true},
      observed:{gatewayValidation:accepted},mockProviderCalls:h.calls(),stages});
  });
  it('SS22 modes use separate request operation and digest, with identical semantic inputs', async () => {
    const shadow=await harness('shadow','separate'), select=await harness('select','separate');
    expect(shadow.input.requestId).not.toBe(select.input.requestId);
    expect(shadow.input.operationId).not.toBe(select.input.operationId);
    expect(shadow.advice.result.request.requestDigest).not.toBe(select.advice.result.request.requestDigest);
    expect(shadow.capturedRequests[0].originalPrompt).toBe(select.capturedRequests[0].originalPrompt);
    expect(shadow.capturedRequests[0].skills).toEqual(select.capturedRequests[0].skills);
    expect(shadow.capturedRequests[0].confirmedContext).toEqual(select.capturedRequests[0].confirmedContext);
    records.push({boundary:'separate-modes',requestIds:[shadow.input.requestId,select.input.requestId],
      requestDigests:[shadow.advice.result.request.requestDigest,select.advice.result.request.requestDigest],status:'PASS'});
  });
  it('SS22 shadow rejects applied advice without silently changing B', async () => {
    const h=await harness('shadow','reject-applied');
    const accepted=await h.accept(h.decision(R,true));
    expect(accepted.valid).toBe(false); expect(accepted.errors).toContain('SHADOW_ADVICE_APPLIED');
    expect(accepted.agentSelectedSkillIds).toBeNull();
    const again:any=await h.gateway.classify(h.input,h.observation('intake'));
    expect(again.agentSelectedSkillIds).toBeNull(); expect(h.calls()).toBe(1);
    records.push({boundary:'shadow-applied',status:'PASS',observed:accepted});
  });
  it.each(['shadow','select'] as const)('SS22 %s missing host does not become selected',async mode=>{
    const h=await harness(mode,'no-host'), d=h.decision(mode==='shadow'?B:R,mode==='select');
    const accepted=await h.accept(d,null);
    expect(accepted).toMatchObject({valid:false,errors:['HOST_SELECTION_NOT_OBSERVED'],agentSelectedSkillIds:null});
    records.push({variant:mode,boundary:'missing-host',status:'PASS',observed:accepted});
  });
  it('SS22 select rejects caller-created receipt',async()=>{
    const h=await harness('select','caller-receipt'), d=h.decision(R,true);
    d.hostReceipt={receiptId:'caller-made',host:'mock-host',requestDigest:d.requestDigest,
      inventoryDigest:d.inventoryDigest,agentSelectedSkillIds:R,acceptedAt:new Date().toISOString()};
    await expect(h.accept(d)).rejects.toThrow('CALLER_SELECTION_RECEIPT_REJECTED');
    records.push({variant:'select',boundary:'caller-receipt',status:'PASS',observed:'CALLER_SELECTION_RECEIPT_REJECTED'});
  });
  it('SS22 null is unobserved; empty array is explicit empty and retains omitted purpose',async()=>{
    const h=await harness('select','null-empty'), d=h.decision(null,false);
    expect(validateDecision(h.advice.result,d,h.advice.result.snapshot).valid).toBe(true);
    await expect(h.accept(d)).rejects.toThrow('AGENT_SELECTION_MISSING');
    const empty=await h.accept(h.decision([],true));
    expect(empty.valid).toBe(true); expect(empty.decision.agentSelectedSkillIds).toEqual([]);
    // Validator validity is not semantic success. No numeric SS22 oracle score exists.
    records.push({variant:'select',boundary:'null-empty',status:'PASS',nullObserved:'AGENT_SELECTION_MISSING',
      emptyObserved:empty,emptyPurposeStatus:'FAIL',missingRequired:R});
  });
  it('SS22 accepted deficient select stays quality-failed and is never rewritten by classifier',async()=>{
    const h=await harness('select','deficient'), accepted=await h.accept(h.decision(B,true));
    expect(accepted.valid).toBe(true); expect(accepted.decision.agentSelectedSkillIds).toEqual(B);
    expect(accepted.neededSkillIds).toEqual([...R].sort());
    records.push({variant:'select',boundary:'deficient-selection',status:'PASS',observed:accepted,
      purposeStatus:'FAIL',missingRequired:R.filter(x=>!B.includes(x)),note:'AGENT must evaluate purpose; valid=true is not SS22 PASS'});
  });
  it('SS22 select acceptance rejects cancellation observed before asynchronous reads',async()=>{
    const h=await harness('select','cancel-before'); h.task().cancelled=true;
    const accepted=await h.accept(h.decision(R,true));
    expect(accepted.valid).toBe(false); expect(accepted.errors).toContain('HOST_TASK_CHANGED_OR_NOT_OBSERVED');
    records.push({variant:'select',boundary:'cancel-before-read',status:'PASS',observed:accepted});
  });
  it('SS22 mode config change cannot reuse shadow operation for select',async()=>{
    const h=await harness('shadow','mode-change'); h.runtime.config.mode='select'; h.runtime.config.configRevision='ss22-select';
    await expect(h.gateway.classify(h.input,h.observation('intake'))).rejects.toThrow('STALE_CLASSIFICATION_OPERATION');
    records.push({boundary:'reuse-after-mode-change',status:'PASS',observed:'STALE_CLASSIFICATION_OPERATION'});
  });
});

describe('SS22 known acceptance recheck gap reproducer',()=>{
  it('SS22 select must reject cancellation occurring during runtime reread',async()=>{
    const h=await harness('select','cancel-during-read');
    h.onRead(()=>{h.task().cancelled=true;});
    const accepted=await h.accept(h.decision(R,true));
    records.push({variant:'select',boundary:'cancel-during-read',expected:{valid:false,selected:null},
      observed:accepted,taskCancelled:h.task().cancelled,status:accepted.valid?'FAIL':'PASS',
      existingFinding:'동시성 직전 재검사 공백',syntheticHostBoundary:true});
    expect(accepted.valid,'cancelled task must not be accepted after await readRuntime').toBe(false);
    expect(accepted.agentSelectedSkillIds).toBeNull();
  });
});
