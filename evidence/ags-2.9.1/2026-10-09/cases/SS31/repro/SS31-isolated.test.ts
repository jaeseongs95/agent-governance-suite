import {afterAll, afterEach, describe, expect, it, vi} from "vitest";
import {InMemoryClassificationBudget, SkillClassificationService, type ClassificationServiceInput} from "../mcp-server/src/skill-classification/service.js";
import {ClassificationProviderError, unknownUsage} from "../mcp-server/src/skill-classification/providers.js";
import {createClassificationRequest} from "../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../mcp-server/src/skill-classification/profiles.js";
import type {ProviderEvaluation, ProviderProfile, SkillClassificationProviderPort, SkillClassificationRequestV1} from "../mcp-server/src/skill-classification/types.js";

// TD-002/004, CONC-CANCEL-004, DIST-IDEMPOTENCY-002/RETRY-003/ORDER-004.
// Public service boundary; fake transport/clock only. Provider-live/host selection are NOT_RUN here.
function fixture() {
  const request = createClassificationRequest({requestId: "request", operationId: "operation", originalPrompt: "확실한 미전송 timeout, 전송 뒤 응답 없는 timeout, 전송 여부도 불명인 timeout, timeout 뒤 늦게 성공하는 응답을 각각 주입한다.",
    inventory: {skills: [{skillId: "review", version: "1", description: "고정 변경분 검토", enabled: true, installed: true, hostSupported: true, capabilities: ["review"], actions: ["review"], targets: ["diff"], constraints: ["read-only"], applicability: ["fixed diff"], exclusions: ["implementation"], dependencies: [], phases: [], sourceRefs: []}], issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "taxonomy"}, classificationCriteriaRef: "criteria"});
  const profile = (kind: "jev" | "vendor"): ProviderProfile => {
    const value: ProviderProfile = {profileId: kind, providerKind: kind, vendorId: kind === "jev" ? "typesafe" : "current-vendor", modelId: `${kind}-fixed`, modelRevision: `${kind}-fixed`, reasoningEffort: kind === "jev" ? null : "low",
    supportedOptions: {reasoningEfforts: kind === "jev" ? [null] : ["low"], structuredOutput: true}, approvedRouteRef: `${kind}-route`, qualificationRevision: "q1", qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: `${kind}-fixed`, promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}, adapterRevision: "a1", promptRevision: "p1", maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: kind === "jev" ? {neededAt: 0.8, notNeededAt: 0.2} : null};
    value.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(value);
    return value;
  };
  const input: ClassificationServiceInput = {request, config: {jevEnabled: true, mode: "select", providerProfileRegistryRef: "profiles", externalClassificationAllowed: true, configRevision: "c1", timeoutMs: 50}, registry: {schemaVersion: "1.0.0", profileRevision: "pr1", profiles: [profile("jev"), profile("vendor")]}, currentVendorId: "current-vendor"};
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: 0}, vendors: {"current-vendor": {limitUsd: 2, spentUsd: 0}}, nativeAllowances: {vendor: {approvalRef: "fixture-quota", remainingCalls: 2}}});
  const evaluation = (req: SkillClassificationRequestV1 = request): ProviderEvaluation => ({response: {schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest, status: "SUCCESS", judgments: [{skillId: "review", judgment: "needed", reasonRefs: ["fixture"], uncertaintyReason: null}], unresolvedItems: [], error: null}, usage: {...unknownUsage(), actualCostUsd: 0.1}, dispatchState: "started", diagnostics: null});
  const provider = (): SkillClassificationProviderPort => ({availability: vi.fn(async () => ({available: true, approved: true, routeKind: "remote" as const, reasonCode: null})), classify: vi.fn(async (req) => evaluation(req))});
  const jev = provider(), vendor = provider();
  const service = new SkillClassificationService({providers: {jev, vendor}, budget});
  return {input, budget, evaluation, jev, vendor, service, profile};
}

import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {ApprovedRouteClassificationProvider, type ApprovedClassificationRoute} from "../mcp-server/src/skill-classification/providers.js";
const observations: any[] = [];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function scenario(id: string, variant: string, input: string, expected: string, run: (row: any) => Promise<void>) {
  it(id, async () => {
    const row: any = {id, variant, input, expected, executionKind: "isolated-offline-mock", apiCalls: {jev: 0, vendor: 0, claude: 0}, status: "FAIL", observations: null};
    try {await run(row); row.status = "PASS";} finally {observations.push(row);}
  });
}
function observe(row: any, f: ReturnType<typeof fixture>, result: any, extra = {}) {
  row.observations = {result, budget: f.budget.snapshot(), providerCalls: {jev: vi.mocked(f.jev.classify).mock.calls.length, vendor: vi.mocked(f.vendor.classify).mock.calls.length}, ...extra};
}
function check(value: boolean, message: string) {expect(value, message).toBe(true);}
function remote(f: ReturnType<typeof fixture>, credentials: () => Promise<string|null>, fetcher: typeof fetch) {
  const p = f.profile("jev");
  const route: ApprovedClassificationRoute = {kind: "remote", routeRef: p.approvedRouteRef, approvalRef: "synthetic-approval-not-production", approved: true,
    providerKind: "jev", vendorId: p.vendorId, adapterRevision: p.adapterRevision, modelIds: [p.modelId], reasoningEfforts: [p.reasoningEffort], structuredOutput: true,
    endpoint: "https://ss31.invalid/mock-only", getCredential: credentials, adapter: {encode: (req, profile) => ({request: req, model: profile.modelId}), decode: (_body, req) => f.evaluation(req)}};
  const provider = new ApprovedRouteClassificationProvider([route], fetcher);
  return new SkillClassificationService({providers: {jev: provider, vendor: f.vendor}, budget: f.budget});
}
afterEach(() => vi.useRealTimers());
afterAll(() => writeFileSync(join(process.env.SS31_OUTPUT_DIRECTORY ?? ".", "isolated-observations.json"), JSON.stringify(observations, null, 2)+"\n"));
describe("SS31 all variants and missing boundaries", () => {
  scenario("SS31-ND-availability", "not-dispatched", "JEV availability remains pending until timeout then resolves; approved vendor succeeds", "JEV not-started/timedOut=true/reserved=0; JEV dispatch 0; vendor 1; late availability never dispatches", async row => {
    vi.useFakeTimers(); const f=fixture(); let release!:()=>void;
    vi.mocked(f.jev.availability).mockImplementation(()=>new Promise(resolve=>{release=()=>resolve({available:true,approved:true,routeKind:"remote",reasonCode:null});}));
    const pending=f.service.classify(f.input); await vi.advanceTimersByTimeAsync(51); const result=await pending;
    release(); await flush(); observe(row,f,result);
    expect(result.attempts[0]).toMatchObject({errorCode:"PROVIDER_TIMEOUT",timedOut:true,dispatchState:"not-started",reservedCostUsd:0,status:"UNAVAILABLE",usage:{actualCostUsd:null}});
    expect(f.jev.classify).toHaveBeenCalledTimes(0); expect(f.vendor.classify).toHaveBeenCalledTimes(1); expect(result.response.status).toBe("SUCCESS"); expect(f.budget.snapshot().reservations).toEqual([]);
  });
  scenario("SS31-ND-typed", "not-dispatched", "provider confirms timeout before dispatch via PROVIDER_TIMEOUT/not-started", "Confirmed nondispatch releases reservation; timeout remains recorded; vendor succeeds", async row=>{
    const f=fixture(); vi.mocked(f.jev.classify).mockRejectedValue(new ClassificationProviderError("PROVIDER_TIMEOUT","not-started"));
    const result=await f.service.classify(f.input); observe(row,f,result,{mockHttpTransmissions:0});
    expect(result.attempts[0]).toMatchObject({timedOut:true,dispatchState:"not-started",status:"UNAVAILABLE"}); expect(f.budget.snapshot().reservations).toEqual([]); expect(result.response.status).toBe("SUCCESS");
  });
  scenario("SS31-ND-credential-gap", "not-dispatched", "approved remote provider's first credential read succeeds; second read remains pending until timeout; fetch never invoked", "Known nondispatch timeout must be not-started with no retained charge reservation; JEV mock HTTP 0", async row=>{
    vi.useFakeTimers(); const f=fixture(); let reads=0, transmissions=0, release!:(v:string)=>void;
    const service=remote(f,async()=>{reads++; return reads===1?"SYNTHETIC_NOT_SECRET":new Promise(resolve=>{release=resolve;});},(async()=>{transmissions++; return new Response("{}");}) as typeof fetch);
    const pending=service.classify(f.input); await vi.advanceTimersByTimeAsync(51); const result=await pending;
    release("SYNTHETIC_NOT_SECRET"); await flush(); observe(row,f,result,{credentialReads:reads,mockHttpTransmissions:transmissions});
    check(transmissions===0,"No late remote fetch is permitted");
    expect(result.attempts[0]?.dispatchState,"Known no HTTP dispatch must not become unknown").toBe("not-started"); expect(f.budget.snapshot().reservations).toEqual([]);
  });
  for (const dispatch of ["started","unknown"] as const) scenario(`SS31-UC-${dispatch}`,"unknown-consumption",`JEV reports PROVIDER_TIMEOUT/${dispatch}; vendor succeeds`,"Attempt UNCERTAIN/timedOut=true; costs null; JEV reserve .4 and vendor confirmed .1 remain separate; 1 attempt each",async row=>{
    const f=fixture(); vi.mocked(f.jev.classify).mockRejectedValue(new ClassificationProviderError("PROVIDER_TIMEOUT",dispatch));
    const result=await f.service.classify(f.input); observe(row,f,result);
    expect(result.attempts[0]).toMatchObject({timedOut:true,dispatchState:dispatch,status:"UNCERTAIN",errorCode:"PROVIDER_TIMEOUT",usage:{actualCostUsd:null},reservedCostUsd:.4});
    expect(result.response.status).toBe("SUCCESS"); expect(f.jev.classify).toHaveBeenCalledTimes(1); expect(f.vendor.classify).toHaveBeenCalledTimes(1);
    expect(f.budget.snapshot()).toMatchObject({limits:{jev:{spentUsd:0},"vendor:current-vendor":{spentUsd:.1}},reservations:[{bucket:"jev",maximumUsd:.4}]});
  });
  scenario("SS31-UC-remote-hang","unknown-consumption","JEV approved remote mock fetch starts and never resolves; service deadline expires","Exactly 1 mock HTTP fetch; abort signal sent; JEV unknown reservation retained; fallback profile fixed; final completion 1",async row=>{
    vi.useFakeTimers(); const f=fixture(); let transmissions=0, signal:AbortSignal|null=null, completions=0;
    const service=remote(f,async()=>"SYNTHETIC_NOT_SECRET",(async(_url,init)=>{transmissions++; signal=init!.signal!; return new Promise(()=>{});}) as typeof fetch);
    const pending=service.classify(f.input).then(r=>{completions++;return r;}); await vi.advanceTimersByTimeAsync(51); const result=await pending;
    observe(row,f,result,{mockHttpTransmissions:transmissions,abortSignalSent:(signal as AbortSignal|null)?.aborted,cancellationConfirmed:false,completions});
    check(transmissions===1&&(signal as AbortSignal|null)?.aborted===true&&completions===1,"Single fetch and completion; abort requested, not cancellation confirmed");
    expect(result.attempts[0]).toMatchObject({timedOut:true,dispatchState:"unknown",status:"UNCERTAIN",usage:{actualCostUsd:null}}); expect(result.attempts[1]).toMatchObject({modelId:"vendor-fixed",reasoningEffort:"low"});
    expect(f.budget.snapshot().reservations).toHaveLength(1);
  });
  scenario("SS31-UC-vendor-missing","unknown-consumption","JEV timeout/started; no vendor provider available","Final UNAVAILABLE or UNCERTAIN hold retains JEV timeout attempt and conservative reservation; actual selection NOTRUN",async row=>{
    const f=fixture(); vi.mocked(f.jev.classify).mockRejectedValue(new ClassificationProviderError("PROVIDER_TIMEOUT","started"));
    const service=new SkillClassificationService({providers:{jev:f.jev},budget:f.budget}); const result=await service.classify(f.input); observe(row,f,result);
    expect(result.attempts[0]).toMatchObject({status:"UNCERTAIN",timedOut:true,dispatchState:"started"}); expect(f.budget.snapshot().reservations).toHaveLength(1);
    check(["UNAVAILABLE","UNCERTAIN"].includes(result.response.status)&&result.response.error!==null,"Allowed final hold blocks completed selection while JEV attempt remains available");
  });
  scenario("SS31-UC-vendor-blocked","unknown-consumption","JEV timeout/unknown; vendor route is unapproved","No policy escape, vendor dispatch 0; allowed final hold with JEV uncertain diagnosis retained in attempts",async row=>{
    const f=fixture(); vi.mocked(f.jev.classify).mockRejectedValue(new ClassificationProviderError("PROVIDER_TIMEOUT","unknown"));
    vi.mocked(f.vendor.availability).mockResolvedValue({available:false,approved:false,routeKind:"remote",reasonCode:"ROUTE_NOT_APPROVED"});
    const result=await f.service.classify(f.input); observe(row,f,result); expect(f.vendor.classify).toHaveBeenCalledTimes(0); expect(result.attempts[0]).toMatchObject({timedOut:true,status:"UNCERTAIN"});
    check(["UNAVAILABLE","UNCERTAIN"].includes(result.response.status)&&result.response.error!==null,"Allowed final hold blocks completed selection while JEV attempt remains available"); expect(f.budget.snapshot().reservations).toHaveLength(1);
  });
  scenario("SS31-UC-both-timeout","unknown-consumption","JEV timeout/started then vendor timeout/unknown","Both costs remain unknown with distinct .4 reservations; final UNCERTAIN; neither provider retries",async row=>{
    const f=fixture(); vi.mocked(f.jev.classify).mockRejectedValue(new ClassificationProviderError("PROVIDER_TIMEOUT","started")); vi.mocked(f.vendor.classify).mockRejectedValue(new ClassificationProviderError("PROVIDER_TIMEOUT","unknown"));
    const result=await f.service.classify(f.input); observe(row,f,result); expect(result.response.status).toBe("UNCERTAIN"); expect(result.attempts).toHaveLength(2);
    expect(f.budget.snapshot().reservations.map(r=>r.bucket)).toEqual(["jev","vendor:current-vendor"]); expect(f.jev.classify).toHaveBeenCalledTimes(1); expect(f.vendor.classify).toHaveBeenCalledTimes(1);
  });
  scenario("SS31-LR-remote-success","late-result","JEV remote mock fetch times out; vendor succeeds; JEV late response supplies successful result and .1 cost; replay identical operation","Late success cannot overwrite fallback, settle unknown reservation or complete twice; replay does not resend",async row=>{
    vi.useFakeTimers(); const f=fixture(); let transmissions=0, completions=0, release!:(r:Response)=>void;
    const service=remote(f,async()=>"SYNTHETIC_NOT_SECRET",(async()=>{transmissions++;return new Promise(resolve=>{release=resolve;});}) as typeof fetch);
    const pending=service.classify(f.input).then(r=>{completions++;return r;}); await vi.advanceTimersByTimeAsync(51); const result=await pending;
    const before=JSON.stringify({result,budget:f.budget.snapshot()}); release(new Response("{}")); await flush(); const replay=await service.classify(f.input);
    observe(row,f,result,{mockHttpTransmissions:transmissions,completions,lateStateUnchanged:before===JSON.stringify({result,budget:f.budget.snapshot()}),replaySame:JSON.stringify(replay)===JSON.stringify(result)});
    check(before===JSON.stringify({result,budget:f.budget.snapshot()}),"Late result/cost may not mutate published result or conservative reservation"); check(transmissions===1&&completions===1,"Late success/replay must not resend or double-complete"); expect(f.vendor.classify).toHaveBeenCalledTimes(1); expect(replay).toEqual(result);
  });
  scenario("SS31-LR-remote-rejection","late-result","JEV remote mock fetch times out then rejects late; vendor succeeded","Late rejection must not overwrite or double complete; no unhandled rejection; reservation remains unknown",async row=>{
    vi.useFakeTimers(); const f=fixture(); let transmissions=0,reject!:(e:Error)=>void;
    const service=remote(f,async()=>"SYNTHETIC_NOT_SECRET",(async()=>{transmissions++;return new Promise((_r,j)=>{reject=j;});}) as typeof fetch);
    const pending=service.classify(f.input); await vi.advanceTimersByTimeAsync(51); const result=await pending; const before=JSON.stringify({result,budget:f.budget.snapshot()});
    reject(new Error("synthetic late transport error")); await flush(); observe(row,f,result,{mockHttpTransmissions:transmissions,lateStateUnchanged:before===JSON.stringify({result,budget:f.budget.snapshot()})});
    check(before===JSON.stringify({result,budget:f.budget.snapshot()}),"Late transport failure must not mutate final result"); check(transmissions===1,"No automatic timeout resend");
  });
  scenario("SS31-LR-during-fallback","late-result","JEV times out; vendor remains pending; JEV late success arrives before vendor completes","JEV late result cannot complete or overwrite vendor-in-flight result; one final fallback completion; unknown JEV cost retained",async row=>{
    vi.useFakeTimers(); const f=fixture(); let releaseJ!:(r:ProviderEvaluation)=>void,releaseV!:(r:ProviderEvaluation)=>void,completions=0;
    vi.mocked(f.jev.classify).mockImplementation(()=>new Promise(resolve=>{releaseJ=resolve;})); vi.mocked(f.vendor.classify).mockImplementation(()=>new Promise(resolve=>{releaseV=resolve;}));
    const pending=f.service.classify(f.input).then(r=>{completions++;return r;}); await vi.advanceTimersByTimeAsync(51);
    releaseJ(f.evaluation()); await flush(); const completionsBeforeVendor=completions; releaseV(f.evaluation()); const result=await pending; observe(row,f,result,{completionsBeforeVendor,completions});
    check(completionsBeforeVendor===0&&completions===1,"Only the active vendor fallback can complete"); expect(result.attempts.map(a=>a.providerKind)).toEqual(["jev","vendor"]); expect(result.attempts[0]?.usage.actualCostUsd).toBe(null); expect(f.budget.snapshot().reservations).toHaveLength(1);
  });
  scenario("SS31-LR-cancelled-task","late-result","User cancels active JEV task; JEV late success arrives afterward","Cancellation signal sent but completion/charge not confirmed; fallback 0; late result inert; one final hold",async row=>{
    vi.useFakeTimers(); const f=fixture(); const controller=new AbortController(); f.input.signal=controller.signal; let release!:(r:ProviderEvaluation)=>void,receivedSignal:AbortSignal|null=null;
    vi.mocked(f.jev.classify).mockImplementation((_req,_profile,signal)=>{receivedSignal=signal;return new Promise(resolve=>{release=resolve;});});
    const pending=f.service.classify(f.input); await flush(); controller.abort(); const result=await pending; const before=JSON.stringify({result,budget:f.budget.snapshot()});release(f.evaluation());await flush();observe(row,f,result,{abortSignalSent:(receivedSignal as AbortSignal|null)?.aborted,cancellationConfirmed:false,lateStateUnchanged:before===JSON.stringify({result,budget:f.budget.snapshot()})});
    check((receivedSignal as AbortSignal|null)?.aborted===true,"Cancellation was requested"); check(before===JSON.stringify({result,budget:f.budget.snapshot()}),"Late success cannot override cancelled task"); expect(f.vendor.classify).toHaveBeenCalledTimes(0); expect(f.budget.snapshot().reservations).toHaveLength(1); expect(result.response.error?.code).toBe("STALE_CLASSIFICATION");
  });
  scenario("SS31-UC-timeout-overflow","unknown-consumption","timeoutMs=2147483648 (safe positive integer); JEV availability pending; Node real timer used","Unsupported timer delay must be rejected INVALID_TIMEOUT before availability, never silently collapse to 1ms",async row=>{
    const f=fixture(); f.input.config.timeoutMs=2147483648; vi.mocked(f.jev.availability).mockImplementation(()=>new Promise(()=>{}));
    const result=await f.service.classify(f.input); observe(row,f,result,{timeoutMs:f.input.config.timeoutMs,clock:"Node real timer"});
    expect(result.response.error?.code,"Oversized Node timeout must not be accepted").toBe("INVALID_TIMEOUT"); expect(f.jev.availability).toHaveBeenCalledTimes(0);
  });
});
