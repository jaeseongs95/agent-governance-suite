import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { probe, save, corpus, oracleDigest, scoreCase, aggregate } from "./SS35-probes.js";
afterAll(save);
describe("SS35 isolated offline specification checks",()=>{
 it("SS35 frozen identity and null operational oracle",()=>{
  const bytes=readFileSync(new URL("./fixtures.json",import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9");
  expect(oracleDigest(corpus)).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
  const ss35=corpus.cases.find((x:any)=>x.caseId==="SS35");expect(ss35.originalPrompt).toBeNull();expect(ss35.oracle).toBeNull();
  expect(ss35.variants).toEqual(["family-clean","translation-leak","paraphrase-leak","post-holdout-tuning"]);
  expect(()=>scoreCase(ss35,undefined,corpus.inventorySkillIds)).toThrow("NO_SEMANTIC_ORACLE:SS35");
  const report=aggregate([ss35],[],"selected",corpus.inventorySkillIds);expect(report.denominator).toBe(0);expect(report.precision).toBeNull();expect(report.exactPurposeSuccessRate).toBeNull();
 });
 it("SS35 family-clean accepts only family-disjoint structural split",()=>{
  const row=probe("family-clean");expect(row.observedIssues).toEqual([]);
  const lookup=new Map(row.input.cases.map((c:any)=>[c.caseId,c.familyId]));const a=new Set(row.input.calibration.map((id:string)=>lookup.get(id)));
  expect(row.input.holdout.map((id:string)=>lookup.get(id)).filter((family:any)=>a.has(family))).toEqual([]);
  expect(row.input.calibration).toEqual(expect.arrayContaining(["SS01","SS02","SS03"]));expect(row.input.holdout).toContain("SS04");
  expect(corpus.split.independentHoldoutClaim).toBe(false);
 });
 it.each(["base","reverse"])("SS35 translation-leak %s must FAIL the split",scenario=>{
  expect(probe("translation-leak",scenario).observedIssues).toEqual(["FAMILY_LEAKAGE"]);
 });
 it.each(["base","reverse"])("SS35 paraphrase-leak %s must FAIL the split",scenario=>{
  expect(probe("paraphrase-leak",scenario).observedIssues).toEqual(["FAMILY_LEAKAGE"]);
 });
 it.each(["threshold","prompt"])("SS35 post-holdout-tuning %s must not pass independence gate",scenario=>{
  const row=probe("post-holdout-tuning",scenario);
  expect(row.observedIssues,"SS35_TUNING_HISTORY_INPUT_UNSUPPORTED: public split boundary cannot reject known contaminated frame").not.toEqual([]);
 });
 it.each(["absent","null","blank"])("SS35 missing family %s must not be treated as independent",scenario=>{
  const row=probe("boundary-missing-family",scenario);
  expect(row.observedIssues,"SS35_MISSING_FAMILY_NOT_REJECTED: specification requires deferral when family membership unavailable").not.toEqual([]);
 });
 it("SS35 duplicate conflicting source row must not hide translation leakage",()=>{
  expect(probe("boundary-conflicting-case-family").observedIssues,"SS35_CONFLICTING_FAMILY_OVERWRITE: duplicate caseId must not hide original shared family").not.toEqual([]);
 });
 it("SS35 missing adjustment history must not pass independent claim",()=>{
  expect(probe("boundary-missing-history").observedIssues,"SS35_TUNING_HISTORY_INPUT_UNSUPPORTED: missing history cannot establish independence").not.toEqual([]);
 });
 it("SS35 duplicate split case is rejected",()=>{expect(probe("boundary-duplicate-split").observedIssues).toEqual(["DUPLICATE_SPLIT_CASE"]);});
 it("SS35 unknown split case is rejected",()=>{expect(probe("boundary-unknown-split").observedIssues).toEqual(["UNKNOWN_SPLIT_CASE"]);});
 it("SS35 unassigned semantic row is rejected",()=>{expect(probe("boundary-unassigned").observedIssues).toEqual(["UNASSIGNED_SEMANTIC_CASE"]);});
 it("SS35 same case on both sides is rejected",()=>{expect(probe("boundary-both-sides").observedIssues).toEqual(["DUPLICATE_SPLIT_CASE","FAMILY_LEAKAGE"]);});
});
