import {createHash} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {createClassificationRequest, digestClassificationValue, projectClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {validateDecision} from "../../mcp-server/src/skill-classification/validation.js";
import {RuntimeSkillClassificationGateway} from "../../mcp-server/src/skill-classification/gateway.js";
import {SkillClassificationService, InMemoryClassificationBudget} from "../../mcp-server/src/skill-classification/service.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {oracleDigest, scoreCase} from "./evaluation.js";
import type {Observation} from "./evaluation.js";
import type {ExecutionContextV1} from "../../contracts/types.js";
import type {SkillInventory, SkillClassificationRequestV1, ProviderProfile, ProviderEvaluation, ClassificationResult, SkillSelectionDecisionV1} from "../../mcp-server/src/skill-classification/types.js";

// SS08 ONLY. All observations and receipts below are synthetic component fixtures.
// None is actual host/AGENT evidence; zero JEV/vendor/Claude API calls.
const root = process.cwd();
const corpusBytes = readFileSync(`${root}/tests/skill-classification/fixtures.json`);
const corpus = JSON.parse(corpusBytes.toString());
const fixture = corpus.cases.find((x: any) => x.caseId === "SS08");
const evidence: any[] = [];
let inventory: SkillInventory;
const hash = (x: Buffer | string) => `sha256:${createHash("sha256").update(x).digest("hex")}`;
function capture(id: string, input: unknown, expected: unknown, observed: unknown, status = "PASS") {
  evidence.push({caseId:"SS08", variant:"base", probeId:id, executionKind:"offline-mock", status, input, expected, observed,
    API0:{jev:0,externalVendor:0,claude:0}, actualHostStages:{selected:"NOTRUN",read:"NOTRUN",applied:"NOTRUN",verified:"NOTRUN"}});
}
beforeAll(async () => {inventory = await loadSkillInventory({root}); expect(inventory.issues).toEqual([]);});
afterAll(() => writeFileSync("ss08-artifacts/probe-observations.json", JSON.stringify(evidence,null,2)+"\n"));

function harness(rawNeeded: string[] = ["cs-engineering"], inv = inventory) {
  const profile: ProviderProfile = {profileId:"ss08-offline",providerKind:"vendor",vendorId:"ss08-mock",modelId:"mock-fixed",modelRevision:"mock-fixed-v1",reasoningEffort:"low",
    supportedOptions:{reasoningEfforts:["low"],structuredOutput:true},approvedRouteRef:"fixture:mock-route",qualificationRevision:"mock-only",
    qualification:{status:"PASS",inventoryDigest:inv.inventoryDigest,taxonomyRevision:inv.taxonomyRevision,modelRevision:"mock-fixed-v1",promptRevision:"p1",validUntil:"2099-01-01T00:00:00Z",profileConfigurationDigest:""},
    adapterRevision:"a1",promptRevision:"p1",maximumInputBytes:2_000_000,maximumOutputTokens:1000,maximumCostUsd:0,judgmentPolicy:null};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const runtime = {config:{jevEnabled:false,mode:"select" as const,providerProfileRegistryRef:"mock:profiles",externalClassificationAllowed:false,configRevision:"c1",timeoutMs:2000},
    registry:{schemaVersion:"1.0.0" as const,profileRevision:"p1",profiles:[profile]},allowRemotePrivateContent:false};
  const request = createClassificationRequest({requestId:"ss08-request",operationId:"ss08-operation",originalPrompt:fixture.originalPrompt,inventory:inv,
    classificationCriteriaRef:"skills/orchestrator/references/skill-classification.md"});
  const input = {schemaVersion:"1.0.0",requestId:request.requestId,operationId:request.operationId,originalPrompt:request.originalPrompt,confirmedContext:request.confirmedContext,contextSources:request.contextSources,
    explicitSkillIds:["cs-engineering"],ruleRequiredSkillIds:[],vendorContext:{vendorId:"ss08-mock",reference:"fixture:mock-route"},publicSynthetic:true};
  const classify = vi.fn(async (req: SkillClassificationRequestV1):Promise<ProviderEvaluation> => ({response:{schemaVersion:"1.0.0",requestId:req.requestId,operationId:req.operationId,requestDigest:req.requestDigest,inventoryDigest:req.inventoryDigest,status:"SUCCESS",
    judgments:req.skills.map(x=>({skillId:x.skillId,judgment:rawNeeded.includes(x.skillId)?"needed":"not-needed",reasonRefs:["fixture:mock"],uncertaintyReason:null})),unresolvedItems:[],error:null},
    usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null,actualCostUsd:0},dispatchState:"started",diagnostics:null}));
  const budget = new InMemoryClassificationBudget({jev:{limitUsd:0,spentUsd:0},vendors:{},nativeAllowances:{"ss08-offline":{approvalRef:"fixture:mock-only",remainingCalls:20}}});
  const service = new SkillClassificationService({providers:{vendor:{availability:async()=>({available:true,approved:true,routeKind:"native",reasonCode:null}),classify}},budget});
  const task = {taskRevision:null,requestDigest:request.requestDigest,cancelled:false,sourceRef:"fixture:synthetic-task"};
  const readRuntime = vi.fn(async()=>runtime);
  const gateway = new RuntimeSkillClassificationGateway({root,service,readRuntime,observeTask:()=>task,observeRuntime:()=>digestClassificationValue(runtime)});
  const observation: ExecutionContextV1 = {schemaVersion:"1.0.0",model:"synthetic-component-model",modelClass:"general",reasoningEffort:"high",source:"runtime",
    observationId:"synthetic-only-NOT-live",taskId:request.requestDigest,actorId:"mock:component",observedAt:new Date().toISOString(),expiresAt:"2099-01-01T00:00:00Z"};
  return {request,input,profile,runtime,classify,budget,service,task,readRuntime,gateway,observation};
}
function decision(result:ClassificationResult, selected:string[]|null, status:"SELECTED"|"PARTIAL"|"NEEDS_INPUT"=selected===null?"NEEDS_INPUT":"SELECTED"):SkillSelectionDecisionV1 {
  return {schemaVersion:"1.0.0",classificationResponseRef:digestClassificationValue(result.response),...result.snapshot,
    explicitSkillIds:["cs-engineering"],ruleRequiredSkillIds:[],agentSelectedSkillIds:selected,
    selectionReasons:(selected??[]).map(skillId=>({skillId,reason:"SS08 embedded sourceSpec: explicit CS, idempotency and resource lifetime; code and other skills prohibited"})),
    applicabilityChecks:(selected??[]).map(skillId=>({skillId,applies:true,excluded:false,reasonRefs:["fixture:SS08/sourceSpec.fields"]})),
    unresolvedSkillReferences:[],selectionStatus:status,adviceApplied:selected!==null,hostReceipt:null,
    // cancelled is a snapshot field, not a decision schema field; removed below.
  } as SkillSelectionDecisionV1;
}
function proposed(result:ClassificationResult, selected:string[]|null, status?:"SELECTED"|"PARTIAL"|"NEEDS_INPUT") {
  const d=decision(result,selected,status); Reflect.deleteProperty(d,"cancelled"); return d;
}
function syntheticUnitReceipt(d:SkillSelectionDecisionV1) {
  return {...d,hostReceipt:d.agentSelectedSkillIds===null?null:{receiptId:"synthetic-unit-only-NOT-AGENT",host:"mock",requestDigest:d.requestDigest,inventoryDigest:d.inventoryDigest,
    agentSelectedSkillIds:d.agentSelectedSkillIds,acceptedAt:"2000-01-01T00:00:00Z"}};
}
function rawObservation(result:ClassificationResult):Observation {
  return {caseId:"SS08",layer:"vendorRaw",state:"PASS",skillIds:result.response.judgments.filter(x=>x.judgment==="needed").map(x=>x.skillId),selectionStatus:"PROPOSED",reasonCodes:[],selectionReasons:[],executionKind:"offline-mock",host:null,hostReceipt:null,
    requestDigest:result.request.requestDigest,inventoryDigest:result.request.inventoryDigest,conditionDigest:digestClassificationValue(fixture.sourceSpec.fields),stageEvidence:{read:false,applied:false,verified:false}};
}
describe("SS08 isolated development",()=>{
  it("base frozen provenance and exact prompt/full inventory projection",()=>{
    expect(hash(corpusBytes)).toBe("sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9");
    expect(oracleDigest(corpus)).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
    expect(fixture.variants).toEqual(["base"]);
    for(const ref of fixture.oracle.sourceRefs) expect(hash(readFileSync(`${root}/${ref.path}`))).toBe(ref.digest);
    const h=harness(), p=projectClassificationRequest(h.request);
    expect(p.payload.originalPrompt).toBe(fixture.originalPrompt); expect(p.payload.skills.map(x=>x.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
    expect(Object.values(h.request.confirmedContext)).toEqual(Array(7).fill(null)); expect(h.request.contextSources).toEqual([]);
    expect(p.payload.originalPrompt.endsWith("코드 작성과 타 스킬 호출은 하지 마.")).toBe(true);
    capture("exact-request",h.input,{prompt:fixture.originalPrompt,inventoryCount:corpus.inventorySkillIds.length,unknownContext:null},{request:h.request,projection:p});
  });
  it.each([["raw-CS",["cs-engineering"],"PASS"],["raw-misses-CS",[],"FAIL"]] as const)("base %s retains separate raw score and explicit choice",async(id,raw,verdict)=>{
    const h=harness([...raw]), a:any=await h.gateway.classify(h.input,h.observation);
    expect(a.agentSelectedSkillIds).toBeNull(); expect(a.selectionStatus).toBe("PROPOSED");
    const rawScore=scoreCase(fixture,rawObservation(a.result),corpus.inventorySkillIds); expect(rawScore.verdict).toBe(verdict);
    const d=proposed(a.result,["cs-engineering"]), accepted:any=await h.gateway.accept({schemaVersion:"1.0.0",operationId:h.input.operationId,decision:d},h.observation);
    capture(id,{intake:h.input,rawNeeded:raw,proposed:d},{rawVerdict:verdict,syntheticSelected:["cs-engineering"],noStagePromotion:true},{rawScore,advice:a,syntheticValidation:accepted});
    expect(accepted.valid).toBe(true); expect(accepted.decision.agentSelectedSkillIds).toEqual(["cs-engineering"]); expect(accepted.neededSkillIds).toEqual(["cs-engineering"]);
    expect(accepted).toMatchObject({admissionStatus:"NOT_EVALUATED",readStatus:"NOT_OBSERVED",appliedStatus:"NOT_OBSERVED",verifiedStatus:"NOT_RUN"});
    expect(h.classify).toHaveBeenCalledTimes(1);
  });
  it.each([{selected:[]},{selected:["ponytail"]},{selected:["orchestrator"]}])("base rejects explicit CS replacement $selected",async ({selected})=>{
    const h=harness([]),a:any=await h.gateway.classify(h.input,h.observation),d=proposed(a.result,selected);
    const result:any=await h.gateway.accept({schemaVersion:"1.0.0",operationId:h.input.operationId,decision:d},h.observation);
    capture(`no-replacement-${JSON.stringify(selected)}`,{rawNeeded:[],proposed:d},{valid:false,error:"REQUIRED_SKILL_OMITTED:cs-engineering",selected:null},result);
    expect(result.valid).toBe(false); expect(result.errors).toContain("REQUIRED_SKILL_OMITTED:cs-engineering");expect(result.agentSelectedSkillIds).toBeNull();
  });
  it("base actual selection remains null without host observation, caller receipt rejected",async()=>{
    const h=harness([]),a:any=await h.gateway.classify(h.input,h.observation),d=proposed(a.result,["cs-engineering"]);
    const result=await h.gateway.accept({schemaVersion:"1.0.0",operationId:h.input.operationId,decision:d},null);
    capture("no-host",d,{valid:false,selected:null},result);
    expect(result).toMatchObject({valid:false,agentSelectedSkillIds:null,errors:["HOST_SELECTION_NOT_OBSERVED"]});
    await expect(h.gateway.accept({schemaVersion:"1.0.0",operationId:h.input.operationId,decision:syntheticUnitReceipt(d)},h.observation)).rejects.toThrow("CALLER_SELECTION_RECEIPT_REJECTED");
    const nullDecision=proposed(a.result,null); expect(validateDecision(a.result,nullDecision,a.result.snapshot).valid).toBe(true);
    const emptyDecision=syntheticUnitReceipt(proposed(a.result,[]));expect(validateDecision(a.result,emptyDecision,a.result.snapshot).errors).toContain("REQUIRED_SKILL_OMITTED:cs-engineering");
    capture("null-vs-empty",{nullDecision,emptyDecision},{nullUnresolved:true,emptyInvalidForSS08:true},{null:validateDecision(a.result,nullDecision,a.result.snapshot),empty:validateDecision(a.result,emptyDecision,a.result.snapshot)});
  });
  it.each([["enabled","DISABLED"],["installed","NOT_INSTALLED"],["hostSupported","HOST_UNSUPPORTED"]] as const)("base %s unavailable preserves needed CS and blocks completion",async(field,reason)=>{
    const inv=structuredClone(inventory);inv.skills.find(x=>x.skillId==="cs-engineering")![field]=false;
    inv.inventoryDigest=digestClassificationValue(inv.skills);
    const h=harness([],inv),result=await h.service.classify({request:h.request,config:h.runtime.config,registry:h.runtime.registry,currentVendorId:"ss08-mock"});
    const d=syntheticUnitReceipt(proposed(result,["cs-engineering"],"PARTIAL")),checked=validateDecision(result,d,result.snapshot);
    capture(`availability-${field}`,{request:h.request,rawNeeded:[],unitDecision:d},{needed:["cs-engineering"],runnable:[],blocked:reason},checked);
    expect(checked.valid).toBe(true);expect(checked.neededSkillIds).toEqual(["cs-engineering"]);expect(checked.runnableSkillIds).toEqual([]);expect(checked.blockedItems).toEqual([{skillId:"cs-engineering",reasonCode:reason}]);
    expect(validateDecision(result,{...d,selectionStatus:"SELECTED"},result.snapshot).errors).toContain("UNRESOLVED_SELECTION_MARKED_COMPLETE");
  });
  it("base CS absent from inventory never substitutes another ID",async()=>{
    const inv=structuredClone(inventory);inv.skills=inv.skills.filter(x=>x.skillId!=="cs-engineering");inv.inventoryDigest=digestClassificationValue(inv.skills);
    const h=harness([],inv),r=await h.service.classify({request:h.request,config:h.runtime.config,registry:h.runtime.registry,currentVendorId:"ss08-mock"});
    const d=proposed(r,null),checked=validateDecision(r,d,r.snapshot);
    capture("missing-CS",{request:h.request,decision:d},{needed:["cs-engineering"],runnable:[],blocked:"UNKNOWN_REQUIRED_SKILL",selected:null},checked);
    expect(checked.neededSkillIds).toEqual(["cs-engineering"]);expect(checked.runnableSkillIds).toEqual([]);expect(checked.blockedItems).toEqual([{skillId:"cs-engineering",reasonCode:"UNKNOWN_REQUIRED_SKILL"}]);
  });
  it.each(["CS","orchestrator"])("base failed raw proposal %s remains oracle failure after separate correction",async wrong=>{
    const h=harness([wrong]),a:any=await h.gateway.classify(h.input,h.observation);
    const score=scoreCase(fixture,{...rawObservation(a.result),skillIds:[wrong]},corpus.inventorySkillIds);
    capture(`raw-wrong-${wrong}`,{rawNeeded:[wrong]},{rawVerdict:"FAIL",mustNotCreditCorrectionAsRaw:true},score);
    expect(score.verdict).toBe("FAIL");expect(score.missingRequired).toEqual(["cs-engineering"]);
  });
  it("base gateway cannot consume host discovery absence (known host-state supply gap)",async()=>{
    const hostInstalledIds=inventory.skills.map(x=>x.skillId).filter(x=>x!=="cs-engineering");
    const knownHost=await loadSkillInventory({root,installedSkillIds:hostInstalledIds,hostSupportedSkillIds:hostInstalledIds});
    const h=harness([]),gatewayInventory:any=await h.gateway.inventory();
    const expected=knownHost.skills.find(x=>x.skillId==="cs-engineering"),observed=gatewayInventory.skills.find((x:any)=>x.skillId==="cs-engineering");
    capture("known-host-state-supply-gap",{hostInstalledIds,limitation:"gateway constructor/runtime/input has no installedSkillIds/hostSupportedSkillIds supply path"},{installed:false,hostSupported:false},{knownHost:expected,gateway:observed},"FAIL");
    expect(observed.installed).toBe(expected!.installed);expect(observed.hostSupported).toBe(expected!.hostSupported);
  });
  it("base cancellation during acceptance async read must prevent recorded selection (known recheck gap)",async()=>{
    const h=harness([]),a:any=await h.gateway.classify(h.input,h.observation),d=proposed(a.result,["cs-engineering"]);
    let entered!:()=>void,release!:()=>void;const enteredPromise=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
    h.readRuntime.mockImplementationOnce(async()=>{entered();await wait;return h.runtime;});
    const pending=h.gateway.accept({schemaVersion:"1.0.0",operationId:h.input.operationId,decision:d},h.observation);
    await enteredPromise;h.task.cancelled=true;release();const observed:any=await pending;
    capture("known-acceptance-recheck-gap",{intake:h.input,proposed:d,interleaving:["host/task verified","runtime read suspended","host task cancelled","runtime read resumed"]},{valid:false,selected:null},observed,"FAIL");
    expect(observed.valid).toBe(false);
  });
  it("base invalid RESP retains valid usage (known cost-loss defect)",async()=>{
    const h=harness([]);h.profile.maximumCostUsd=0.4;h.profile.qualification.profileConfigurationDigest=digestProviderProfileConfiguration(h.profile);
    const budget=new InMemoryClassificationBudget({jev:{limitUsd:0,spentUsd:0},vendors:{"ss08-mock":{limitUsd:1,spentUsd:0}}});
    const evaluation=await h.classify(h.request);evaluation.response.judgments=[];evaluation.usage.actualCostUsd=0.1;
    const service=new SkillClassificationService({providers:{vendor:{availability:async()=>({available:true,approved:true,routeKind:"remote",reasonCode:null}),classify:async()=>evaluation}},budget});
    const r=await service.classify({request:h.request,config:{...h.runtime.config,externalClassificationAllowed:true},registry:h.runtime.registry,currentVendorId:"ss08-mock"});
    capture("known-invalid-RESP-cost-loss",{intake:h.input,mockedProviderEvaluation:evaluation},{error:"INVALID_PROVIDER_RESPONSE",actualCostUsd:0.1,spentUsd:0.1},{result:r,budget:budget.snapshot()},"FAIL");
    expect(r.response.error?.code).toBe("INVALID_PROVIDER_RESPONSE");expect(r.attempts[0]!.usage.actualCostUsd).toBe(0.1);
  });
  it("base large safe-integer timeout must not become an immediate timeout (known overflow)",async()=>{
    const h=harness([]);
    const service=new SkillClassificationService({providers:{vendor:{availability:async()=>{
      await new Promise<void>(resolve=>setTimeout(resolve,10));return {available:true,approved:true,routeKind:"native",reasonCode:null};
    },classify:h.classify}},budget:h.budget});
    const r=await service.classify({request:h.request,config:{...h.runtime.config,timeoutMs:2_147_483_648},registry:h.runtime.registry,currentVendorId:"ss08-mock"});
    capture("known-timeout-overflow",{intake:h.input,timeoutMs:2_147_483_648,mockAvailabilityDelayMs:10},{status:"SUCCESS",timedOut:false},{result:r,providerClassifyCalls:h.classify.mock.calls.length},"FAIL");
    expect(r.response.error).toBeNull();expect(r.response.status).toBe("SUCCESS");
  });
});
