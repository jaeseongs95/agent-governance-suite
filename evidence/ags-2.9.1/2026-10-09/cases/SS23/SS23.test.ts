import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { harness, decision, type Advice, type Accepted } from "./SS23-harness.js";
import { digestClassificationValue } from "../../mcp-server/src/skill-classification/request.js";
import { validateDecision } from "../../mcp-server/src/skill-classification/validation.js";
import { oracleDigest, canonicalSet, fromSelection, scoreCase } from "../skill-classification/evaluation.js";
const corpus = JSON.parse(readFileSync(new URL("../skill-classification/fixtures.json", import.meta.url), "utf8"));
const source = corpus.cases.find((x: any) => x.caseId === "SS23");
const P="ponytail", CS="cs-engineering", SEC="software-security-auditor", T="test-engineering", O="orchestrator", K="korean-prose-editor";
const S=[P,CS,SEC,T,O], raw=[P,T,O];
const rows: any[]=[];
const actualStages={selected:"NOTRUN",read:"NOTRUN",applied:"NOTRUN",verified:"NOTRUN"};
function input(variant: string) {return {schemaVersion:"1.0.0",requestId:`SS23-${variant}`,operationId:`SS23-${variant}`,originalPrompt:source.originalPrompt,
 confirmedContext:{taskRevision:null,objective:null,actions:null,targets:null,constraints:null,prohibitedActions:null,background:null},contextSources:[],
 explicitSkillIds:[CS],ruleRequiredSkillIds:[SEC],vendorContext:{vendorId:"mock-vendor",reference:"fixture:SS23-synthetic"},publicSynthetic:true};}
function evidence(id: string, observed: any, expected: any, extra: any={}) {rows.push({caseId:"SS23",variant:id,executionKind:"offline-mock",expected,observed,
 externalApiCalls:{jev:0,vendor:0,claude:0},actualAgentStages:actualStages,...extra});}
const acceptedStates={admissionStatus:"NOT_EVALUATED",readStatus:"NOT_OBSERVED",appliedStatus:"NOT_OBSERVED",verifiedStatus:"NOT_RUN"};
afterAll(()=>writeFileSync("./SS23.observed.json",JSON.stringify(rows,null,2)+"\n"));
describe("SS23 isolated variants; synthetic receipts never count as actual AGENT choice",()=>{
 it("normal",async()=>{const h=await harness({withJev:true,needed:raw}), req=input("normal");
 const a=(await h.call<Advice>("classify_skills",req)).data!;
 expect(a.agentSelectedSkillIds).toBeNull();expect(a.selectionStatus).toBe("PROPOSED");expect(a.adviceApplied).toBe(false);
 expect(h.jevClassify).toHaveBeenCalledTimes(1);expect(h.availability).not.toHaveBeenCalled();
 expect(h.jevClassify.mock.calls[0][0].originalPrompt).toBe(source.originalPrompt);expect(a.result.request.skills).toHaveLength(24);
 const d=decision(a,S,req); const got=(await h.call<Accepted>("record_skill_selection",h.sign({schemaVersion:"1.0.0",operationId:req.operationId,decision:d}))).data!;
 evidence("normal",{advice:a,acceptance:got},{syntheticSelected:S,excluded:[K],stages:acceptedStates});
 expect(got.valid).toBe(true);expect(canonicalSet(got.decision!.agentSelectedSkillIds)).toEqual(canonicalSet(S));expect(got).toMatchObject(acceptedStates);
 expect(got.neededSkillIds).toEqual([...S].sort());expect(d.hostReceipt).toBeNull();
 });
 it("irrelevant-baseline",async()=>{const baseline=[K], h=await harness({withJev:true,needed:[...raw,K]}),req=input("irrelevant-baseline");
 const a=(await h.call<Advice>("classify_skills",req)).data!;
 const got=(await h.call<Accepted>("record_skill_selection",h.sign({schemaVersion:"1.0.0",operationId:req.operationId,decision:decision(a,S,req)}))).data!;
 evidence("irrelevant-baseline",{baseline,advice:a,acceptance:got},{syntheticSelected:S,excluded:[K]}, {baselineBoundary:"B is test-owned stale input; gateway has no B field. A/B raw includes K deliberately."});
 expect(a.agentSelectedSkillIds).toBeNull();expect(got.valid).toBe(true);expect(got.decision!.agentSelectedSkillIds).not.toContain(K);
 expect(got.neededSkillIds).toContain(K); // recommendation remains observable; it does not rewrite AGENT set
 });
 it("missing-raw-cs",async()=>{const h=await harness({withJev:true,needed:raw}),req=input("missing-raw-cs");
 const a=(await h.call<Advice>("classify_skills",req)).data!;
 const forced=(await h.call<Accepted>("record_skill_selection",h.sign({schemaVersion:"1.0.0",operationId:req.operationId,decision:decision(a,raw,req)}))).data!;
 expect(forced.valid).toBe(false);expect(forced.errors).toContain(`REQUIRED_SKILL_OMITTED:${CS}`);
 const got=(await h.call<Accepted>("record_skill_selection",h.sign({schemaVersion:"1.0.0",operationId:req.operationId,decision:decision(a,S,req)}))).data!;
 evidence("missing-raw-cs",{advice:a,rawMissingCS:true,forcedRaw:forced,acceptance:got},{rawMissingPreserved:true,syntheticSelected:S,forcedRawRejected:true});
 expect(got.valid).toBe(true);expect(a.result.response.judgments.find(x=>x.skillId===CS)!.judgment).toBe("not-needed");
 expect(got.decision!.explicitSkillIds).toEqual([CS]);expect(got.decision!.ruleRequiredSkillIds).toEqual([SEC]);
 });
 it("force-copy-negative",async()=>{const h=await harness({withJev:true,needed:raw}),req=input("force-copy-negative");
 const a=(await h.call<Advice>("classify_skills",req)).data!,d=decision(a,[...raw,K],req),args={schemaVersion:"1.0.0",operationId:req.operationId,decision:d};
 const unsigned=(await h.call<Accepted>("record_skill_selection",args)).data!;
 const forced=(await h.call<Accepted>("record_skill_selection",h.sign(args))).data!;
 expect(unsigned.agentSelectedSkillIds).toBeNull();expect(unsigned.errors).toContain("HOST_SELECTION_NOT_OBSERVED");
 expect(forced.valid).toBe(false);expect(forced.errors).toEqual(expect.arrayContaining([`REQUIRED_SKILL_OMITTED:${CS}`,`REQUIRED_SKILL_OMITTED:${SEC}`]));
 const caller={...args,decision:{...d,hostReceipt:{receiptId:"copied-advice",host:"codex",requestDigest:d.requestDigest,inventoryDigest:d.inventoryDigest,agentSelectedSkillIds:d.agentSelectedSkillIds,acceptedAt:new Date().toISOString()}}};
 const callerRejected=await h.call<Accepted>("record_skill_selection",h.sign(caller));expect(callerRejected.error?.code).toBe("INVALID_INPUT");
 // Complete forced-copy control: machine validation cannot prove how this set was chosen.
 const exactCopied=(await h.call<Accepted>("record_skill_selection",h.sign({...args,decision:decision(a,[...S],req)}))).data!;
 evidence("force-copy-negative",{unsigned,forced,callerRejected,exactCopied},{forcedBehavioralVerdict:"FAIL",unsignedRejected:true,requiredOmissionsRejected:true,callerReceiptRejected:true},
 {completeCopyControl:{construction:"test copied embedded expected S with synthetic reasons/signature",behavioralVerdict:"FAIL",gatewayStructurallyAccepts:exactCopied.valid,independenceDetector:"NOTRUN"}});
 expect(exactCopied.valid).toBe(true); // structural acceptance is NOT evidence of independent AGENT judgment
 });
 it("optional-uncertain-independent-partial",async()=>{const h=await harness({withJev:true,needed:raw,uncertain:[K]}),req=input("optional-uncertain-independent-partial");
 const a=(await h.call<Advice>("classify_skills",req)).data!;
 const d={...decision(a,S,req),selectionStatus:"PARTIAL" as const,unresolvedSkillReferences:[{reference:K,reason:"independent optional candidate unclear; settled implementation/audit work proceeds"}]};
 const got=(await h.call<Accepted>("record_skill_selection",h.sign({schemaVersion:"1.0.0",operationId:req.operationId,decision:d}))).data!;
 evidence("optional-uncertain-independent-partial",{advice:a,acceptance:got},{responseStatus:"PARTIAL",syntheticSelectionStatus:"PARTIAL",syntheticSelected:S,optionalUncertainty:K});
 expect(a.result.response.status).toBe("PARTIAL");expect(got.valid).toBe(true);expect(got.decision!.selectionStatus).toBe("PARTIAL");expect(got.runnableSkillIds).toEqual([...S].sort());
 const allHold={...d,agentSelectedSkillIds:null,selectionStatus:"NEEDS_INPUT" as const,adviceApplied:false,hostReceipt:null};
 const held=fromSelection("SS23",allHold,{state:"NOT_RUN",reasonCodes:[],executionKind:"offline-mock",host:null,conditionDigest:"mock",stageEvidence:{read:false,applied:false,verified:false}});
 expect(held.skillIds).toBeNull();expect(canonicalSet(null)).not.toEqual(canonicalSet([]));
 });
 it("boundary source deduplication and SEC blocked capability does not delete need",async()=>{
 const h=await harness({withJev:true,needed:[...raw,CS,SEC]}),req={...input("dedup"),explicitSkillIds:[CS,SEC],ruleRequiredSkillIds:[SEC,CS]};
 const a=(await h.call<Advice>("classify_skills",req)).data!,d=decision(a,S,req);
 const got=(await h.call<Accepted>("record_skill_selection",h.sign({schemaVersion:"1.0.0",operationId:req.operationId,decision:d}))).data!;
 expect(got.valid).toBe(true);expect(new Set(got.neededSkillIds).size).toBe(5);expect(got.decision!.explicitSkillIds).toEqual([CS,SEC]);expect(got.decision!.ruleRequiredSkillIds).toEqual([SEC,CS]);
 const r=structuredClone(a.result);r.request.skills.find(x=>x.skillId===SEC)!.enabled=false;
 const disabled=validateDecision(r,{...d,selectionStatus:"PARTIAL",hostReceipt:got.decision!.hostReceipt!},r.snapshot);
 evidence("boundary-dedup-blocked",{acceptance:got,disabled}, {needed:S,runnableWithoutDisabledSEC:S.filter(x=>x!==SEC),blockedSEC:true,permissionAdmission:"NOT_EVALUATED"});
 expect(disabled.valid).toBe(true);expect(disabled.neededSkillIds).toContain(SEC);expect(disabled.runnableSkillIds).not.toContain(SEC);expect(disabled.blockedItems).toContainEqual({skillId:SEC,reasonCode:"DISABLED"});
 expect(got).toMatchObject(acceptedStates); // no permission grant follows selection
 });
 it("frozen binding and operational null oracle never gains semantic scores",()=>{
 expect(source.variants).toEqual(["normal","irrelevant-baseline","missing-raw-cs","force-copy-negative","optional-uncertain-independent-partial"]);
 expect(source.oracle).toBeNull();expect(oracleDigest(corpus)).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
 expect(createHash("sha256").update(readFileSync(new URL("../skill-classification/fixtures.json",import.meta.url))).digest("hex")).toBe("17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9");
 expect(()=>scoreCase(source,undefined,corpus.inventorySkillIds)).toThrow("NO_SEMANTIC_ORACLE:SS23");
 });
});
