import {afterAll,expect,it} from 'vitest';
import {writeFileSync} from 'node:fs';
import {createClassificationRequest,digestClassificationValue} from '../../mcp-server/src/skill-classification/request.js';
import {jevNoulWireAdapter} from '../../mcp-server/src/skill-classification/providers.js';
import {validateDecision,validateClassificationResponse} from '../../mcp-server/src/skill-classification/validation.js';
import type {ClassificationResult,ProviderProfile,SkillMetadata,SkillSelectionDecisionV1} from '../../mcp-server/src/skill-classification/types.js';
const rows:any[]=[];
function f(field:'enabled'|'hostSupported'='enabled'){
 const skills:SkillMetadata[]=[{skillId:'software-security-auditor',version:'synthetic',description:'SS27',enabled:true,installed:true,hostSupported:true,capabilities:['test'],actions:['test'],targets:['provider-output'],constraints:[],applicability:['synthetic'],exclusions:['semantic assessment'],dependencies:[],phases:[],sourceRefs:[]}];skills[0][field]=false;
 const request=createClassificationRequest({requestId:`SS27-high-${field}`,operationId:`SS27-high-${field}`,originalPrompt:'SS27 synthetic high-score availability boundary',inventory:{skills,inventoryDigest:digestClassificationValue(skills),taxonomyRevision:'SS27',issues:[]},classificationCriteriaRef:'embedded:SS27'});
 const profile={profileId:'mock',modelRevision:'mock',judgmentPolicy:{neededAt:0.8,notNeededAt:0.2},promptRevision:'mock'} as ProviderProfile;
 const body={model:'mock',answers:{'software-security-auditor':{type:'noul',noul:0.99}},usage:{input_tokens:10,output_tokens:1}};
 const evaluation=jevNoulWireAdapter.decode(body,request,profile);
 const snapshot={taskRevision:null,configRevision:'mock',profileRevision:'mock',inventoryDigest:request.inventoryDigest,requestDigest:request.requestDigest,cancelled:false};
 const result:ClassificationResult={request,response:evaluation.response,config:{jevEnabled:true,mode:'select',providerProfileRegistryRef:'mock',externalClassificationAllowed:false,configRevision:'mock',timeoutMs:1000},profileRevision:'mock',attempts:[],snapshot};
 const decision:SkillSelectionDecisionV1={schemaVersion:'1.0.0',classificationResponseRef:digestClassificationValue(result.response),requestDigest:request.requestDigest,inventoryDigest:request.inventoryDigest,taskRevision:null,configRevision:'mock',profileRevision:'mock',explicitSkillIds:[],ruleRequiredSkillIds:[],agentSelectedSkillIds:['software-security-auditor'],selectionReasons:[{skillId:'software-security-auditor',reason:'synthetic boundary proposal'}],applicabilityChecks:[{skillId:'software-security-auditor',applies:true,excluded:false,reasonRefs:['embedded:SS27']}],unresolvedSkillReferences:[],selectionStatus:'PARTIAL',adviceApplied:false,hostReceipt:null};
 return {request,result,body,evaluation,decision};
}
it.each(['enabled','hostSupported'] as const)('SS27 0.99 score cannot override false %s',(field)=>{
 const x=f(field),observed=validateDecision(x.result,x.decision,x.result.snapshot);rows.push({id:`high-score-${field}`,status:'PASS',input:{skills:x.request.skills,body:x.body},observed:{evaluation:x.evaluation,selectionBoundary:observed},actualHost:{selected:null,hostReceipt:null,status:'NOTRUN'}});
 expect(x.evaluation.response.judgments[0].judgment).toBe('needed');expect(x.request.skills[0][field]).toBe(false);expect(observed.neededSkillIds).toEqual(['software-security-auditor']);expect(observed.runnableSkillIds).toEqual([]);expect(observed.blockedItems).toEqual([{skillId:'software-security-auditor',reasonCode:field==='enabled'?'DISABLED':'HOST_UNSUPPORTED'}]);
});
it('SS27 identical duplicate provider judgment remains INVALID',()=>{const x=f();x.result.response.judgments.push({...x.result.response.judgments[0]});const errors=validateClassificationResponse(x.request,x.result.response);rows.push({id:'identical-duplicate',status:'PASS',input:x.result.response,observed:errors});expect(errors).toEqual(['DUPLICATE_SKILL_ID']);});
it.each(['SUCCESS','PARTIAL','UNCERTAIN'] as const)('SS27 omitted provider candidate in %s remains INVALID',status=>{const x=f();const response={...x.result.response,status,judgments:[],unresolvedItems:status==='UNCERTAIN'?[{skillId:null,reasonCode:'SEMANTIC_UNCERTAINTY'}]:[]};const errors=validateClassificationResponse(x.request,response);rows.push({id:`omitted-${status}`,status:'PASS',input:response,observed:errors});expect(errors).toContain('MISSING_CANDIDATE_JUDGMENT');});
afterAll(()=>writeFileSync('evidence/SS27/extra-observations.json',JSON.stringify({caseId:'SS27',rows,executionKind:'new-isolated-offline-mock',externalAPICalls:0,hostReceipt:null},null,2)+'\n'));
