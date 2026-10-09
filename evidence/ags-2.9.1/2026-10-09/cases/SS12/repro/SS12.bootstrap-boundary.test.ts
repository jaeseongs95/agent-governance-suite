import path from 'node:path';
import {pathToFileURL} from 'node:url';
const candidateRoot=process.env.AGS_CANDIDATE_ROOT;
const artifactRoot=process.env.AGS_EVIDENCE_ROOT;
if (!candidateRoot || !artifactRoot) throw new Error('Set AGS_CANDIDATE_ROOT and AGS_EVIDENCE_ROOT for reproduction');
const candidateBase=pathToFileURL(path.resolve(candidateRoot)+path.sep);
import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
const {loadSkillInventory} = await import(new URL('mcp-server/src/skill-classification/inventory.ts',candidateBase).href);
const {createClassificationRequest} = await import(new URL('mcp-server/src/skill-classification/request.ts',candidateBase).href);
const {validateClassificationResponse} = await import(new URL('mcp-server/src/skill-classification/validation.ts',candidateBase).href);

it('SS12 must preserve null for valid PARTIAL with every candidate uncertain',async()=>{
 const fetchGuard=vi.fn(()=>{throw new Error('EXTERNAL_API_FORBIDDEN');});vi.stubGlobal('fetch',fetchGuard);
 try {
  const root=candidateRoot;
  const fixture=JSON.parse(readFileSync(`${root}/tests/skill-classification/fixtures.json`,'utf8')).cases.find((c:any)=>c.caseId==='SS12');
  const inventory=await loadSkillInventory({root});expect(inventory.issues).toEqual([]);
  const request=createClassificationRequest({requestId:'SS12/base-boundary',operationId:'SS12/base-boundary',originalPrompt:fixture.originalPrompt,inventory,classificationCriteriaRef:'skills/orchestrator/references/skill-classification.md'});
  const response={schemaVersion:'1.0.0',requestId:request.requestId,operationId:request.operationId,requestDigest:request.requestDigest,inventoryDigest:request.inventoryDigest,status:'PARTIAL',
   judgments:request.skills.map(s=>({skillId:s.skillId,judgment:'uncertain',reasonRefs:[],uncertaintyReason:'No recoverable action or target'})),
   unresolvedItems:fixture.oracle.requiredReasons.map((reasonCode:string)=>({skillId:null,reasonCode})),error:null};
  expect(validateClassificationResponse(request,response as any)).toEqual([]);
  const source=readFileSync(`${root}/tests/skill-classification/live-bootstrap/bootstrap.mts`,'utf8');
  const start=source.indexOf('      observations.push({caseId, layer: "jevRaw"');
  const end=source.indexOf('\n      if (errorCode || capViolation)',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const mapping=source.slice(start,end).replace(/\(row: \{judgment: string\}\)/g,'(row)').replace(/\(row: \{skillId: string\}\)/g,'(row)').replace(/\(row: \{reasonCode: string\}\)/g,'(row)').replace(/\(row: \{skillId: string; reasonRefs: string\[\]\}\)/g,'(row)');
  const observations:any[]=[];
  new Function('observations','caseId','errorCode','capViolation','evaluation','options','request','configDigest',mapping)(observations,'SS12',null,false,{response},{executionKind:'offline-mock'},request,'SS12-offline');
  expect(observations[0].selectionStatus).toBe('NEEDS_INPUT');
  expect(observations[0].skillIds,'SS12 unresolved input must remain null, not accepted empty []').toBeNull();
 } finally {expect(fetchGuard).not.toHaveBeenCalled();vi.unstubAllGlobals();}
});
