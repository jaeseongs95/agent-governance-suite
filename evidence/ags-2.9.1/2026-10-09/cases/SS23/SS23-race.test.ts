import { expect,it } from "vitest";
import { writeFileSync,readFileSync } from "node:fs";
import { harness,decision,barrier,type Advice,type Accepted } from "./SS23-harness.js";
it("SS23 cancellation during acceptance asynchronous read must prevent selection",async()=>{
 const c=JSON.parse(readFileSync(new URL("../skill-classification/fixtures.json",import.meta.url),"utf8")).cases.find((x:any)=>x.caseId==="SS23");
 const h=await harness({withJev:true,needed:["ponytail","test-engineering","orchestrator"]});
 const req={schemaVersion:"1.0.0",requestId:"SS23-race",operationId:"SS23-race",originalPrompt:c.originalPrompt,confirmedContext:{taskRevision:null,objective:null,actions:null,targets:null,constraints:null,prohibitedActions:null,background:null},contextSources:[],explicitSkillIds:["cs-engineering"],ruleRequiredSkillIds:["software-security-auditor"],vendorContext:{vendorId:"mock-vendor",reference:"fixture:synthetic"},publicSynthetic:true};
 const a=(await h.call<Advice>("classify_skills",req)).data!;
 const entered=barrier(),release=barrier();
 h.readRuntime.mockImplementation(async()=>{entered.open();await release.promise;return h.runtime;});
 const pending=h.call<Accepted>("record_skill_selection",h.sign({schemaVersion:"1.0.0",operationId:req.operationId,decision:decision(a,["ponytail","cs-engineering","software-security-auditor","test-engineering","orchestrator"],req)}));
 await entered.promise;const state=h.taskStates.get(req.requestId)!;state.cancelled=true;release.open();
 const got=(await pending).data!;
 writeFileSync("./SS23.race-observed.json",JSON.stringify({caseId:"SS23",executionKind:"offline-mock",expected:{valid:false,agentSelectedSkillIds:null},observed:got,taskAfterRead:state,knownFinding:"concurrency immediate recheck gap",externalApiCalls:{jev:0,vendor:0,claude:0},actualAgentStages:{selected:"NOTRUN",read:"NOTRUN",applied:"NOTRUN",verified:"NOTRUN"}},null,2)+"\n");
 expect(got.valid,"cancelled task accepted after async runtime/inventory read").toBe(false);
});
