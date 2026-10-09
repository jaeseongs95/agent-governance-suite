import { readFileSync, writeFileSync } from "node:fs";
import { checkFamilySplit, oracleDigest, scoreCase, aggregate } from "./evaluation.js";
const corpus = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const clone = <T>(x:T):T => structuredClone(x);
const clean = () => ({cases:clone(corpus.cases),calibration:[...corpus.split.calibration],holdout:[...corpus.split.holdout]});
export const observations:any[]=[];
const record=(variant:string,scenario:string,input:any,context:any=null)=> {
  const issues=checkFamilySplit(input.cases,input.calibration,input.holdout);
  const inputSummary={fixtureRef:"tests/skill-classification/fixtures.json",cases:input.cases.map((x:any)=>({caseId:x.caseId,...(Object.hasOwn(x,"familyId")?{familyId:x.familyId}:{}),semanticOraclePresent:x.oracle!==null,...(x.caseId==="SS03-paraphrase"?{originalPrompt:x.originalPrompt}: {})})),calibration:input.calibration,holdout:input.holdout};
  const row={variant,scenario,executionKind:"offline-data-validation",entryPoint:"tests/skill-classification/evaluation.ts#checkFamilySplit",input:inputSummary,unsupportedContext:context,observedIssues:issues};
  observations.push(row);return row;
};
export function probe(variant:string,scenario="base") {
  const input=clean();
  if(variant==="translation-leak") {
    if(scenario==="reverse") {input.calibration=input.calibration.filter((x:string)=>x!=="SS01");input.holdout.push("SS01");}
    else {input.calibration=input.calibration.filter((x:string)=>x!=="SS02");input.holdout.push("SS02");}
  }
  if(variant==="paraphrase-leak") {
    const original=input.cases.find((x:any)=>x.caseId==="SS03");
    input.cases.push({...original,caseId:"SS03-paraphrase",originalPrompt:"같은 메시지를 다시 수신하거나 ACK 뒤 crash, 수신 전 종료가 발생해도 session-handoff 인계 유실과 중복 완료가 없도록 최소 구현과 회귀 테스트를 설계해 줘."});
    if(scenario==="reverse") {input.calibration=input.calibration.filter((x:string)=>x!=="SS03");input.calibration.push("SS03-paraphrase");input.holdout.push("SS03");}
    else input.holdout.push("SS03-paraphrase");
  }
  if(variant==="post-holdout-tuning") {
    const history={holdoutResultObservedAt:"2026-10-09T00:01:00.000Z",adjustedAt:"2026-10-09T00:02:00.000Z",finalScoreSource:"same-holdout-result",reclassifiedAsTuning:false,newHoldout:null,
      before:{oracleRevision:corpus.oracleRevision,splitRevision:corpus.split.revision,thresholdRevision:"ss35-offline-threshold-v1",promptRevision:"ss35-offline-prompt-v1"},
      after:{oracleRevision:corpus.oracleRevision,splitRevision:corpus.split.revision,thresholdRevision:scenario==="threshold"?"ss35-offline-threshold-v2":"ss35-offline-threshold-v1",promptRevision:scenario==="prompt"?"ss35-offline-prompt-v2":"ss35-offline-prompt-v1"}};
    return record(variant,scenario,input,history);
  }
  if(variant==="boundary-missing-family") {const row=input.cases.find((x:any)=>x.caseId==="SS03");if(scenario==="absent")delete row.familyId;else row.familyId=scenario==="null"?null:"";}
  if(variant==="boundary-conflicting-case-family") {input.calibration=input.calibration.filter((x:string)=>x!=="SS02");input.holdout.push("SS02");input.cases.push({...input.cases.find((x:any)=>x.caseId==="SS02"),familyId:"test-only-conflicting-family"});}
  if(variant==="boundary-duplicate-split")input.calibration.push("SS03");
  if(variant==="boundary-unknown-split")input.holdout.push("SS35-unknown");
  if(variant==="boundary-unassigned")input.holdout=input.holdout.filter((x:string)=>x!=="SS04");
  if(variant==="boundary-both-sides")input.holdout.push("SS03");
  if(variant==="boundary-missing-history")return record(variant,scenario,input,{adjustmentHistory:null,thresholdRevision:null,promptRevision:null,claimIndependentHoldout:true});
  return record(variant,scenario,input);
}
export {corpus,oracleDigest,scoreCase,aggregate};
export function save() {writeFileSync(new URL("./ss35-reproduction-observations.json",import.meta.url),JSON.stringify(observations,null,2)+"\n");}
