import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkStageBundle } from '../../runtime/engineering-practices/stage-bundle.mjs';
import { validateProof, validateReview } from '../../runtime/engineering-practices/core.mjs';
import { hashJson } from '../../runtime/engineering-practices/io.mjs';
import { fixture, writeJson } from './helpers.mjs';

function bundle(t, capability='test-sensitivity-review') {
  const f=fixture(t);
  f.task={schemaVersion:'1.0.0',taskId:f.plan.taskId,objective:'Verify the prefix.',scope:{included:f.plan.scopeFiles,excluded:[]},
    acceptanceCriteria:[...f.plan.requirements],riskLevel:'low',workUnits:[],requiredCapabilities:[capability],constraints:[],
    authorization:{allowedActions:['local-test'],prohibitedActions:['network'],approvalRequired:[]},decision:{complexity:'simple',hasConflicts:false},orchestration:{requested:true,mcpAvailable:true}};
  f.plan.contractDigest=hashJson(f.task); f.proof.planDigest=hashJson(f.plan);
  f.request.contractDigest=hashJson(f.task); f.report.requestDigest=hashJson(f.request);
  const result=capability==='test-sensitivity-review'?validateProof(f.root,f.plan,f.proof):validateReview(f.root,f.request,f.report);
  f.manifest={schemaVersion:'1.0.0',kind:'engineering-stage-bundle',capability,task:writeJson(f.root,'task.json',f.task),result:writeJson(f.root,'result.json',result)};
  if(capability==='test-sensitivity-review')Object.assign(f.manifest,{plan:writeJson(f.root,'plan.json',f.plan),proof:writeJson(f.root,'proof.json',f.proof)});
  else Object.assign(f.manifest,{request:writeJson(f.root,'request.json',f.request),report:writeJson(f.root,'report.json',f.report)});
  f.sync=()=>writeJson(f.root,'stage-bundle.json',f.manifest);
  f.check=()=>checkStageBundle(f.root,'stage-bundle.json',f.sync().digest,hashJson(f.task),capability);
  return f;
}
test('normal raw test and review bundles are evaluated using existing validators',t=>{
  assert.equal(bundle(t).check().result.verdict,'CONSISTENT');
  assert.equal(bundle(t,'change-code-review').check().result.verdict,'NO_BLOCKING_FINDINGS');
});
test('required case cannot be downgraded even when a resealed proof would be consistent',t=>{
  const f=bundle(t); f.plan.cases[0].required=false;f.proof.planDigest=hashJson(f.plan);
  f.manifest.plan=writeJson(f.root,'plan.json',f.plan);f.manifest.proof=writeJson(f.root,'proof.json',f.proof);
  f.manifest.result=writeJson(f.root,'result.json',validateProof(f.root,f.plan,f.proof));
  assert.throws(()=>f.check(),/no required verification/);
});
test('missing acceptance requirement cannot be hidden in a coherent replacement plan',t=>{
  const f=bundle(t);f.plan.requirements=['OTHER'];f.plan.cases[0].requirementIds=['OTHER'];f.proof.planDigest=hashJson(f.plan);
  f.manifest.plan=writeJson(f.root,'plan.json',f.plan);f.manifest.proof=writeJson(f.root,'proof.json',f.proof);
  f.manifest.result=writeJson(f.root,'result.json',validateProof(f.root,f.plan,f.proof));
  assert.throws(()=>f.check(),/frozen acceptance/);
});
test('task drift cannot replace the signed task digest',t=>{
  const f=bundle(t);const expected=hashJson(f.task);f.task.objective+=' changed';f.manifest.task=writeJson(f.root,'task.json',f.task);
  assert.throws(()=>checkStageBundle(f.root,'stage-bundle.json',f.sync().digest,expected,'test-sensitivity-review'),/signed workflow task/);
});
test('NOT_RUN is recomputed as incomplete rather than accepted as a claimed pass',t=>{
  const f=bundle(t);f.proof.proofs[0]={caseId:'PAGE-1',status:'NOT_RUN',red:{path:'',digest:hashJson('')},green:{path:'',digest:hashJson('')},mutationPaths:[],assertionWitness:'',reason:'Required run absent.'};
  f.manifest.proof=writeJson(f.root,'proof.json',f.proof);assert.throws(()=>f.check(),/current raw-file validation/);
  f.manifest.result=writeJson(f.root,'result.json',validateProof(f.root,f.plan,f.proof));assert.equal(f.check().result.verdict,'INCOMPLETE');
});
test('malformed manifest, traversal and stale result fail closed',t=>{
  const f=bundle(t);f.manifest.extra='unsupported';assert.throws(()=>f.check(),/Invalid or mismatched/);delete f.manifest.extra;
  const prior=f.manifest.plan;f.manifest.plan={...prior,path:'../plan.json'};assert.throws(()=>f.check(),/Unsafe path/);f.manifest.plan=prior;
  writeFileSync(path.join(f.root,'result.json'),'changed');assert.throws(()=>f.check(),/digest mismatch/);
});
test('packaged check-stage-bundle uses no node_modules and binds task schema',t=>{
  const f=bundle(t);const artifact=f.sync();const repo=path.resolve(import.meta.dirname,'../..');
  const installed=mkdtempSync(path.join(tmpdir(),'ags-engineering-cleanroom-'));t.after(()=>rmSync(installed,{recursive:true,force:true}));
  cpSync(path.join(repo,'runtime'),path.join(installed,'runtime'),{recursive:true});
  cpSync(path.join(repo,'contracts'),path.join(installed,'contracts'),{recursive:true});
  const ran=spawnSync(process.execPath,[path.join(installed,'runtime/engineering-practices/cli.mjs'),'check-stage-bundle','--root',f.root,
    '--input','stage-bundle.json','--bundle-digest',artifact.digest,'--task-digest',hashJson(f.task),'--capability','test-sensitivity-review'],{cwd:installed,encoding:'utf8'});
  assert.equal(ran.status,0,ran.stderr);assert.equal(JSON.parse(ran.stdout).result.verdict,'CONSISTENT');
});
