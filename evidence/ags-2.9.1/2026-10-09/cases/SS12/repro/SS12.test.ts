import path from 'node:path';
import {pathToFileURL} from 'node:url';
const candidateRoot=process.env.AGS_CANDIDATE_ROOT;
const artifactRoot=process.env.AGS_EVIDENCE_ROOT;
if (!candidateRoot || !artifactRoot) throw new Error('Set AGS_CANDIDATE_ROOT and AGS_EVIDENCE_ROOT for reproduction');
const candidateBase=pathToFileURL(path.resolve(candidateRoot)+path.sep);
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
const {scoreCase, fromSelection, canonicalSet, sameSet, oracleDigest, aggregate} = await import(new URL('tests/skill-classification/evaluation.ts',candidateBase).href);
const {loadSkillInventory} = await import(new URL('mcp-server/src/skill-classification/inventory.ts',candidateBase).href);
const {createClassificationRequest, projectClassificationRequest, digestClassificationValue} = await import(new URL('mcp-server/src/skill-classification/request.ts',candidateBase).href);
const {validateClassificationResponse, validateDecision} = await import(new URL('mcp-server/src/skill-classification/validation.ts',candidateBase).href);
const {RuntimeSkillClassificationGateway, readClassificationRuntime} = await import(new URL('mcp-server/src/skill-classification/gateway.ts',candidateBase).href);
const {SkillClassificationService, InMemoryClassificationBudget} = await import(new URL('mcp-server/src/skill-classification/service.ts',candidateBase).href);

const root=candidateRoot, out=artifactRoot;
const corpus=JSON.parse(readFileSync(`${root}/tests/skill-classification/fixtures.json`,'utf8'));
const fixture=corpus.cases.find((c:any)=>c.caseId==='SS12');
const controls:any[]=[];
let inventory:any, request:any, result:any;
const fetchGuard=vi.fn(()=>{throw new Error('EXTERNAL_API_FORBIDDEN');});
function obs(patch:any={}) { return {caseId:'SS12',layer:'selected',state:'PASS',skillIds:null,selectionStatus:'NEEDS_INPUT',
 reasonCodes:['missing-action','missing-target'],selectionReasons:[],executionKind:'offline-mock',host:null,hostReceipt:null,
 requestDigest:request?.requestDigest??'unit-only',inventoryDigest:request?.inventoryDigest??'unit-only',conditionDigest:'SS12-offline',
 stageEvidence:{read:false,applied:false,verified:false},...patch}; }
function record(id:string, input:any, expected:any, observed:any, kind='new-boundary') {controls.push({id,caseId:'SS12',kind,input,expected,observed,executionKind:'offline-mock'});}
function score(id:string,patch:any,expected:string,kind='new-boundary') {const input=obs(patch), observed=scoreCase(fixture,input,corpus.inventorySkillIds); record(id,input,{verdict:expected},observed,kind);expect(observed.verdict).toBe(expected);return observed;}
function response(status='UNCERTAIN',reasonCodes=['missing-action','missing-target']) {return {schemaVersion:'1.0.0',requestId:request.requestId,operationId:request.operationId,
 requestDigest:request.requestDigest,inventoryDigest:request.inventoryDigest,status,
 judgments:request.skills.map((s:any)=>({skillId:s.skillId,judgment:'uncertain',reasonRefs:[],uncertaintyReason:'No recoverable action or target'})),
 unresolvedItems:reasonCodes.map(reasonCode=>({skillId:null,reasonCode})),error:null};}
function decision() {return {schemaVersion:'1.0.0',classificationResponseRef:digestClassificationValue(result.response),...result.snapshot,
 explicitSkillIds:[],ruleRequiredSkillIds:[],agentSelectedSkillIds:null,selectionReasons:[],applicabilityChecks:[],
 unresolvedSkillReferences:[{reference:'action',reason:'missing-action'},{reference:'target',reason:'missing-target'}],
 selectionStatus:'NEEDS_INPUT',adviceApplied:false,hostReceipt:null};}
function bootstrapObservation(resp:any) {
 // Executes the exact unmodified observation-mapping source only; does not invoke prepare/runBootstrap or another case.
 const source=readFileSync(`${root}/tests/skill-classification/live-bootstrap/bootstrap.mts`,'utf8');
 const start=source.indexOf('      observations.push({caseId, layer: "jevRaw"');
 const end=source.indexOf('\n      if (errorCode || capViolation)',start);
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const mapping=source.slice(start,end).replace(/\(row: \{judgment: string\}\)/g,'(row)').replace(/\(row: \{skillId: string\}\)/g,'(row)').replace(/\(row: \{reasonCode: string\}\)/g,'(row)').replace(/\(row: \{skillId: string; reasonRefs: string\[\]\}\)/g,'(row)');
 const rows:any[]=[];
 new Function('observations','caseId','errorCode','capViolation','evaluation','options','request','configDigest',mapping)(rows,'SS12',null,false,{response:resp},{executionKind:'offline-mock'},request,'SS12-offline');
 return rows[0];
}
beforeAll(async()=>{
 vi.stubGlobal('fetch',fetchGuard);
 inventory=await loadSkillInventory({root});
 request=createClassificationRequest({requestId:'SS12/base-offline',operationId:'SS12/base-offline',originalPrompt:fixture.originalPrompt,inventory,classificationCriteriaRef:'skills/orchestrator/references/skill-classification.md'});
 const runtime=await readClassificationRuntime(undefined,root);
 result={request,response:response(),config:runtime.config,profileRevision:runtime.registry.profileRevision,attempts:[],snapshot:{taskRevision:null,configRevision:runtime.config.configRevision,profileRevision:runtime.registry.profileRevision,inventoryDigest:request.inventoryDigest,requestDigest:request.requestDigest,cancelled:false}};
});
afterAll(()=>{expect(fetchGuard).not.toHaveBeenCalled();writeFileSync(`${out}/SS12.controls.json`,JSON.stringify({caseId:'SS12',fixture,request,controls,apiCalls:{JEV:0,externalVendor:0,Claude:0,fetch:fetchGuard.mock.calls.length},selected:'NOTRUN',read:'NOTRUN',applied:'NOTRUN',verified:'NOTRUN'},null,2)+'\n');vi.unstubAllGlobals();});
describe('SS12 only: frozen base and missing boundaries',()=>{
 it('binds frozen SS12 bytes, oracle and complete installed inventory',()=>{
  expect(createHash('sha256').update(readFileSync(`${root}/tests/skill-classification/fixtures.json`)).digest('hex')).toBe('17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
  expect(oracleDigest(corpus)).toBe('sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
  expect(fixture.variants).toEqual(['base']);expect(fixture.originalPrompt).toBe('그거 처리해 줘.');
  expect(inventory.issues).toEqual([]);expect(inventory.skills.map((s:any)=>s.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
  record('frozen-base',fixture,{variants:['base'],inventoryCount:24},{variants:fixture.variants,inventoryCount:inventory.skills.length,inventoryIssues:inventory.issues},'integrity');
 });
 it('preserves exact original prompt, absent action/target and unknown null in public request',()=>{
  const projection=projectClassificationRequest(request);
  expect(projection.payload.originalPrompt).toBe(fixture.originalPrompt);expect(projection.payload.confirmedContext.actions).toBeNull();expect(projection.payload.confirmedContext.targets).toBeNull();expect(projection.payload.confirmedContext.background).toBeNull();expect(request.contextSources).toEqual([]);expect(projection.payload.skills).toHaveLength(24);
  record('request-projection',fixture.originalPrompt,{actions:null,targets:null,background:null,contextSources:[],candidates:24},{confirmedContext:projection.payload.confirmedContext,contextSources:request.contextSources,candidates:projection.payload.skills.length});
 });
 it('replays only the two SS12 evaluator assertions from existing regression lines 119-121',()=>{
  score('existing-null-with-reasons',{},'PASS','existing-regression-extraction');score('existing-empty-selection',{skillIds:[],selectionStatus:'SELECTED',reasonCodes:[]},'FAIL','existing-regression-extraction');expect(canonicalSet(null)).toBeNull();expect(sameSet(null,[])).toBe(false);
 });
 it.each([[],['missing-action'],['missing-target'],['missing_action','missing_target']].map(reasonCodes=>({reasonCodes})))('rejects absent or misspelled missing-input reasons $reasonCodes',({reasonCodes})=>{score(`reason-control-${reasonCodes.join('-')||'none'}`,{reasonCodes},'FAIL');});
 it.each(['PROPOSED','SELECTED','PARTIAL'])('rejects unresolved null with wrong status %s',selectionStatus=>{score(`status-${selectionStatus}`,{selectionStatus},'FAIL');});
 it('rejects fabricated confident implementation/deployment/security choices',()=>{for(const skillId of ['ponytail','mutation-risk-preflight','software-security-auditor']){const observed=score(`invented-${skillId}`,{skillIds:[skillId],selectionStatus:'SELECTED'},'FAIL');expect(observed.reasons).toContain('UNCERTAINTY_HIDDEN_AS_SELECTION');}});
 it('preserves missing, failed and blocked executions as non-passing',()=>{const missing=scoreCase(fixture,undefined,corpus.inventorySkillIds);record('missing-observation',null,{verdict:'NOT_RUN'},missing);expect(missing.verdict).toBe('NOT_RUN');score('notrun',{state:'NOT_RUN'},'NOT_RUN');score('blocked',{state:'BLOCKED'},'BLOCKED');score('failed',{state:'FAIL'},'FAIL');});
 it('rejects mismatched case binding without scoring another case',()=>{score('wrong-binding',{caseId:'invalid-binding'},'FAIL');});
 it('retains independently supplied NEEDS_INPUT decision null without inventing receipt',()=>{
  const d=decision();delete d.cancelled;const checked=validateDecision(result,d,result.snapshot);expect(checked.valid).toBe(true);expect(d.hostReceipt).toBeNull();expect(d.agentSelectedSkillIds).toBeNull();const converted=fromSelection('SS12',d,obs());expect(converted.skillIds).toBeNull();expect(converted.hostReceipt).toBeNull();expect(scoreCase(fixture,converted,corpus.inventorySkillIds).verdict).toBe('PASS');record('decision-validation',d,{valid:true,skillIds:null,hostReceipt:null},{checked,converted});
 });
 it('does not credit selected/read/applied/verified stage flags without host evidence',()=>{const report=aggregate([fixture],[obs({stageEvidence:{read:true,applied:true,verified:true}})],'selected',corpus.inventorySkillIds);expect(report.stageCoverage).toEqual({read:0,applied:0,verified:0});record('stage-flags',obs().stageEvidence,{stageCoverage:{read:0,applied:0,verified:0}},report);});
 it('validates complete uncertain response and maps exact bootstrap UNCERTAIN to null',()=>{const resp=response();expect(validateClassificationResponse(request,resp)).toEqual([]);const mapped=bootstrapObservation(resp);expect(mapped.skillIds).toBeNull();expect(mapped.selectionStatus).toBe('NEEDS_INPUT');const scored=scoreCase(fixture,mapped,corpus.inventorySkillIds);expect(scored.verdict).toBe('PASS');record('bootstrap-UNCERTAIN',resp,{skillIds:null,selectionStatus:'NEEDS_INPUT',verdict:'PASS'},{mapped,scored},'bootstrap-source-boundary-extraction');});
 it('characterizes valid PARTIAL/all-uncertain response mapped to [] and scored FAIL',()=>{const resp=response('PARTIAL');expect(validateClassificationResponse(request,resp)).toEqual([]);const mapped=bootstrapObservation(resp),scored=scoreCase(fixture,mapped,corpus.inventorySkillIds);expect(mapped.selectionStatus).toBe('NEEDS_INPUT');expect(mapped.skillIds).toEqual([]);expect(scored.verdict).toBe('FAIL');expect(scored.reasons).toContain('UNCERTAINTY_HIDDEN_AS_SELECTION');record('bootstrap-PARTIAL-all-uncertain',resp,{semanticPreservation:{skillIds:null,selectionStatus:'NEEDS_INPUT'},currentCharacterization:{skillIds:[],verdict:'FAIL'}},{mapped,scored},'new-bootstrap-boundary-characterization');});
 it('rejects uncertain response missing inventory judgments',()=>{const resp=response();resp.judgments.pop();const errors=validateClassificationResponse(request,resp);expect(errors).toContain('MISSING_CANDIDATE_JUDGMENT');record('missing-candidate',resp,{error:'MISSING_CANDIDATE_JUDGMENT'},errors);});
 it('executes real unconfigured gateway/service for SS12 without a provider call',async()=>{
  const runtime=await readClassificationRuntime(undefined,root);const service=new SkillClassificationService({providers:{},budget:new InMemoryClassificationBudget({jev:{limitUsd:null,spentUsd:null},vendors:{}})});
  const gateway=new RuntimeSkillClassificationGateway({root,service,readRuntime:async()=>runtime});
  const input={schemaVersion:'1.0.0',requestId:request.requestId,operationId:request.operationId,originalPrompt:fixture.originalPrompt,confirmedContext:request.confirmedContext,contextSources:[],explicitSkillIds:[],ruleRequiredSkillIds:[],vendorContext:{vendorId:'unconfigured-SS12',reference:'offline-no-route'},publicSynthetic:true};
  const actual:any=await gateway.classify(input);
  expect(actual.result.response.status).toBe('UNAVAILABLE');expect(actual.result.attempts).toEqual([]);expect(actual.agentSelectedSkillIds).toBeNull();expect(actual.selectionStatus).toBe('PROPOSED');
  const d=decision();delete d.cancelled;const rejected=await gateway.accept({schemaVersion:'1.0.0',operationId:request.operationId,decision:d},null);
  expect(rejected).toEqual({valid:false,errors:['HOST_SELECTION_NOT_OBSERVED'],agentSelectedSkillIds:null});record('gateway-unconfigured',{input,hostObservation:null},{responseStatus:'UNAVAILABLE',attempts:[],agentSelectedSkillIds:null,hostAcceptance:'rejected'},{classification:actual,acceptance:rejected},'offline-local-integration');
 });
});
