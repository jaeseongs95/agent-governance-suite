import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.SS17_REPO ?? process.cwd();
const out = process.env.SS17_OUTPUT ?? join(process.cwd(), 'ss17-reproduction-output');
mkdirSync(out, {recursive:true});
const moduleAt = relative => import(pathToFileURL(join(root, relative)).href);
const {loadSkillInventory} = await moduleAt('mcp-server/src/skill-classification/inventory.ts');
const {createClassificationRequest, projectClassificationRequest, digestClassificationValue} = await moduleAt('mcp-server/src/skill-classification/request.ts');
const {validateClassificationResponse, validateDecision} = await moduleAt('mcp-server/src/skill-classification/validation.ts');
const {SkillClassificationService, InMemoryClassificationBudget} = await moduleAt('mcp-server/src/skill-classification/service.ts');
const {RuntimeSkillClassificationGateway, readClassificationRuntime} = await moduleAt('mcp-server/src/skill-classification/gateway.ts');
const {digestProviderProfileConfiguration} = await moduleAt('mcp-server/src/skill-classification/profiles.ts');
const {oracleDigest, scoreCase, sameSet, aggregate} = await moduleAt('tests/skill-classification/evaluation.ts');
const sha = v => createHash('sha256').update(v).digest('hex');
const corpus = JSON.parse(readFileSync(join(root, 'tests/skill-classification/fixtures.json')));
const fixture = corpus.cases.find(x=>x.caseId==='SS17');
const inventory = await loadSkillInventory({root});
const request = createClassificationRequest({requestId:'SS17-base-offline', operationId:'SS17-base-offline', originalPrompt:fixture.originalPrompt, inventory, classificationCriteriaRef:'skills/orchestrator/references/skill-classification.md'});
let externalCalls = 0;
globalThis.fetch = async () => {externalCalls++; throw new Error('EXTERNAL_API_FORBIDDEN_FOR_SS17');};
const records=[];
function save(name, input, expected, observed, executionKind='offline-isolated') {
  records.push({caseId:'SS17', fixtureVariant:'base', boundaryId:name, executionKind, input, expected, observed});
  writeFileSync(join(out,'SS17.observations.json'), JSON.stringify({records, externalCalls},null,2)+'\n');
}
function check(name, input, expected, run) {
  test(`SS17 ${name}`, async () => {
    const observed = await run(); save(name,input,expected,observed);
  });
}
const advice = ids => ({caseId:'SS17',layer:'combined',state:'PASS',skillIds:ids,selectionStatus:'PROPOSED',reasonCodes:[],selectionReasons:[],executionKind:'offline-mock',host:null,hostReceipt:null,requestDigest:request.requestDigest,inventoryDigest:request.inventoryDigest,conditionDigest:'offline-only',stageEvidence:{read:false,applied:false,verified:false}});
const responseFor = ids => ({schemaVersion:'1.0.0',requestId:request.requestId,operationId:request.operationId,requestDigest:request.requestDigest,inventoryDigest:request.inventoryDigest,status:'SUCCESS',judgments:request.skills.map(s=>({skillId:s.skillId,judgment:ids.includes(s.skillId)?'needed':'not-needed',reasonRefs:['explicit-offline-oracle-control'],uncertaintyReason:null})),unresolvedItems:[],error:null});

check('frozen-input-and-source-bindings', {caseId:'SS17',variants:fixture.variants}, {commit:'c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6',tree:'28f2f2ed8a864405320f6d20e7bc5004e8466ad3',fixtureSha:'17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9',oracleSha:'5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055'}, () => {
  const commit=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const tree=execFileSync('git',['-C',root,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
  assert.equal(commit,'c6a8019be30e4bf5ee9a36147ca45ae28b0f75b6'); assert.equal(tree,'28f2f2ed8a864405320f6d20e7bc5004e8466ad3');
  const fixtureSha=sha(readFileSync(join(root,'tests/skill-classification/fixtures.json')));
  assert.equal(fixtureSha,'17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9');
  assert.equal(oracleDigest(corpus),'sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055');
  assert.deepEqual(fixture.variants,['base']);
  const sourceRefs=fixture.oracle.sourceRefs.map(s=>{ const actual='sha256:'+sha(readFileSync(join(root,s.path))); assert.equal(actual,s.digest); return {...s,actual};});
  return {commit,tree,fixtureSha,oracleDigest:oracleDigest(corpus),sourceRefs,embeddedSourceSpec:fixture.sourceSpec};
});

check('base-request-preserves-entire-prompt-inventory-and-unknown-context', {originalPrompt:fixture.originalPrompt}, {inventoryCount:corpus.inventorySkillIds.length,unknownContext:null}, () => {
  assert.deepEqual(inventory.issues,[]);
  assert.deepEqual(inventory.skills.map(s=>s.skillId).sort(),[...corpus.inventorySkillIds].sort());
  const projected=projectClassificationRequest(request);
  assert.equal(projected.payload.originalPrompt,fixture.originalPrompt);
  assert.match(projected.payload.originalPrompt,/코드 품질 리뷰·복구·커밋은 하지 마\.$/);
  assert.deepEqual(projected.payload.skills.map(s=>s.skillId),request.skills.map(s=>s.skillId));
  assert.ok(Object.values(projected.payload.confirmedContext).every(x=>x===null));
  return {request,projection:projected};
});

check('unknown-null-is-distinct-from-confirmed-empty', {actions:[null,[]]}, {sameSet:false,unknown:null,confirmedEmpty:[]}, () => {
  const known=createClassificationRequest({requestId:'SS17-empty-control',operationId:'SS17-empty-control',originalPrompt:fixture.originalPrompt,inventory,classificationCriteriaRef:'criteria',confirmedContext:{actions:[]},contextSources:[{field:'actions',reference:'SS17-new-boundary:explicit-empty-control'}]});
  assert.equal(request.confirmedContext.actions,null); assert.deepEqual(projectClassificationRequest(known).payload.confirmedContext.actions,[]); assert.equal(sameSet(null,[]),false);
  return {unknown:request.confirmedContext.actions,confirmedEmpty:known.confirmedContext.actions,sameSet:sameSet(null,[])};
});

check('byte-limit-keeps-final-prohibition-or-abstains-without-trimming', {prompt:fixture.originalPrompt}, {atLimit:'preserved',belowLimit:'INPUT_TOO_LONG',omittedRanges:[]}, () => {
  const projection=projectClassificationRequest(request);
  assert.equal(projectClassificationRequest(request,projection.payloadBytes).payload.originalPrompt,fixture.originalPrompt);
  let failure; try {projectClassificationRequest(request,projection.payloadBytes-1);} catch(e) {failure={message:e.message,payloadBytes:e.payloadBytes,maximumInputBytes:e.maximumInputBytes,omittedRanges:e.omittedRanges};}
  assert.equal(failure.message,'INPUT_TOO_LONG'); assert.deepEqual(failure.omittedRanges,[]); return {payloadBytes:projection.payloadBytes,failure};
});

for (const [name, ids, verdict] of [
  ['exact-canonical-advice',['change-scope-guardian'],'PASS'],
  ['unofficial-id-rejected',['scope guardian'],'FAIL'],
  ['forbidden-code-review-rejected',['change-scope-guardian','code-review'],'FAIL'],
  ['forbidden-ponytail-rejected',['change-scope-guardian','ponytail'],'FAIL'],
  ['unnecessary-orchestrator-rejected',['change-scope-guardian','orchestrator'],'FAIL'],
  ['empty-advice-missing-required',[],'FAIL'],
]) check(name,{syntheticAdvice:ids}, {verdict},()=>{const score=scoreCase(fixture,advice(ids),corpus.inventorySkillIds); assert.equal(score.verdict,verdict); return score;});

check('response-unknown-id-and-missing-candidate-rejected', {syntheticResp:'canonical/full, alias/full, incomplete'}, {canonical:[],alias:'UNKNOWN_SKILL_ID',incomplete:'MISSING_CANDIDATE_JUDGMENT'}, () => {
  const valid=responseFor(['change-scope-guardian']); assert.deepEqual(validateClassificationResponse(request,valid),[]);
  const alias=structuredClone(valid); alias.judgments.find(x=>x.skillId==='change-scope-guardian').skillId='scope guardian';
  const aliasErrors=validateClassificationResponse(request,alias); assert.ok(aliasErrors.includes('UNKNOWN_SKILL_ID')); assert.ok(aliasErrors.includes('MISSING_CANDIDATE_JUDGMENT'));
  const incomplete={...valid,judgments:valid.judgments.filter(x=>x.skillId!=='change-scope-guardian')};
  assert.ok(validateClassificationResponse(request,incomplete).includes('MISSING_CANDIDATE_JUDGMENT'));
  return {canonical:validateClassificationResponse(request,valid),alias:aliasErrors,incomplete:validateClassificationResponse(request,incomplete)};
});

check('mock-provider-support-never-selects-agent-or-mints-receipt', {originalPrompt:fixture.originalPrompt,provider:'in-memory synthetic vendor; JEV OFF'}, {advice:['change-scope-guardian'],selected:null,acceptError:'HOST_SELECTION_NOT_OBSERVED',externalCalls:0}, async () => {
  let mockCalls=0;
  const profile={profileId:'SS17-offline-only',providerKind:'vendor',vendorId:'offline-vendor',modelId:'synthetic-no-model-call',modelRevision:'offline',reasoningEffort:'low',supportedOptions:{reasoningEfforts:['low'],structuredOutput:true},approvedRouteRef:'in-memory-no-egress',qualificationRevision:'synthetic-only',qualification:{status:'PASS',inventoryDigest:request.inventoryDigest,taxonomyRevision:request.taxonomyRevision,modelRevision:'offline',promptRevision:'offline',validUntil:'2099-01-01T00:00:00Z',profileConfigurationDigest:''},adapterRevision:'offline',promptRevision:'offline',maximumInputBytes:1000000,maximumOutputTokens:1000,maximumCostUsd:0,judgmentPolicy:null};
  profile.qualification.profileConfigurationDigest=digestProviderProfileConfiguration(profile);
  const provider={availability:async()=>({available:true,approved:true,routeKind:'remote',reasonCode:null}),classify:async req=>{mockCalls++; assert.equal(req.originalPrompt,fixture.originalPrompt); assert.equal(req.skills.length,inventory.skills.length); return {response:{...responseFor(['change-scope-guardian']),requestId:req.requestId,operationId:req.operationId,requestDigest:req.requestDigest},usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null,actualCostUsd:0},dispatchState:'started',diagnostics:null};}};
  const service=new SkillClassificationService({providers:{vendor:provider},budget:new InMemoryClassificationBudget({jev:{limitUsd:null,spentUsd:null},vendors:{'offline-vendor':{limitUsd:0,spentUsd:0}}})});
  const runtime={config:{jevEnabled:false,mode:'select',providerProfileRegistryRef:'offline',externalClassificationAllowed:true,configRevision:'SS17-offline',timeoutMs:30000},registry:{schemaVersion:'1.0.0',profileRevision:'offline',profiles:[profile]},allowRemotePrivateContent:false,approvedPublicRequestDigests:[request.requestDigest]};
  const gateway=new RuntimeSkillClassificationGateway({root,service,readRuntime:async()=>runtime});
  const input={schemaVersion:'1.0.0',requestId:request.requestId,operationId:request.operationId,originalPrompt:fixture.originalPrompt,confirmedContext:request.confirmedContext,contextSources:[],explicitSkillIds:[],ruleRequiredSkillIds:[],vendorContext:{vendorId:'offline-vendor',reference:'offline-control'},publicSynthetic:true};
  const classified=await gateway.classify(input);
  assert.equal(classified.result.response.status,'SUCCESS'); assert.equal(classified.agentSelectedSkillIds,null); assert.equal(classified.selectionStatus,'PROPOSED'); assert.equal(mockCalls,1);
  assert.deepEqual(classified.result.response.judgments.filter(x=>x.judgment==='needed').map(x=>x.skillId),['change-scope-guardian']);
  const decision={schemaVersion:'1.0.0',classificationResponseRef:classified.classificationResponseRef,requestDigest:request.requestDigest,inventoryDigest:request.inventoryDigest,taskRevision:null,configRevision:'SS17-offline',profileRevision:'offline',explicitSkillIds:[],ruleRequiredSkillIds:[],agentSelectedSkillIds:['change-scope-guardian'],selectionReasons:[{skillId:'change-scope-guardian',reason:'compare stored baseline and dirty worktree read-only'}],applicabilityChecks:[{skillId:'change-scope-guardian',applies:true,excluded:false,reasonRefs:['SS17.embedded-source']}],unresolvedSkillReferences:[],selectionStatus:'SELECTED',adviceApplied:false,hostReceipt:null};
  const rejected=await gateway.accept({schemaVersion:'1.0.0',operationId:request.operationId,decision},null);
  assert.deepEqual(rejected,{valid:false,errors:['HOST_SELECTION_NOT_OBSERVED'],agentSelectedSkillIds:null});
  assert.ok(validateDecision(classified.result,decision,classified.result.snapshot).errors.includes('HOST_RECEIPT_MISMATCH'));
  assert.equal(externalCalls,0);
  return {classified,rejected,mockProviderCalls:mockCalls,API0:true,notActualAgentSelection:true};
});

check('no-host-observation-keeps-all-four-stages-NOTRUN', {observation:null}, {selected:'NOTRUN',read:'NOTRUN',applied:'NOTRUN',verified:'NOTRUN'}, () => {
  const score=scoreCase(fixture,undefined,corpus.inventorySkillIds); assert.equal(score.verdict,'NOT_RUN');
  const stages=aggregate([fixture],[],'selected',corpus.inventorySkillIds); assert.equal(stages.notRun,1); assert.deepEqual(stages.stageCoverage,{read:0,applied:0,verified:0});
  const unsupported=scoreCase(fixture,{...advice(['change-scope-guardian']),layer:'selected',selectionStatus:'SELECTED'},corpus.inventorySkillIds);
  assert.ok(unsupported.reasons.includes('HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH'));
  return {selected:null,hostReceipt:null,stages:{selected:'NOTRUN',read:'NOTRUN',applied:'NOTRUN',verified:'NOTRUN'},score,unsupported};
});

check('unconfigured-host-runtime-has-no-qualified-provider', {configurationEnvPresent:!!process.env.AGENT_GOVERNANCE_CLASSIFICATION_CONFIG}, {response:'UNAVAILABLE',attempts:[],externalCalls:0}, async () => {
  const runtime=await readClassificationRuntime(undefined,root);
  const gateway=new RuntimeSkillClassificationGateway({root,readRuntime:async()=>runtime,service:new SkillClassificationService({providers:{},budget:new InMemoryClassificationBudget({jev:{limitUsd:null,spentUsd:null},vendors:{}})})});
  const classified=await gateway.classify({schemaVersion:'1.0.0',requestId:request.requestId,operationId:request.operationId,originalPrompt:fixture.originalPrompt,confirmedContext:request.confirmedContext,contextSources:[],explicitSkillIds:[],ruleRequiredSkillIds:[],vendorContext:{vendorId:'unconfigured-vendor',reference:'local-read-only'},publicSynthetic:true});
  assert.equal(classified.result.response.status,'UNAVAILABLE'); assert.deepEqual(classified.result.attempts,[]); assert.equal(classified.agentSelectedSkillIds,null); assert.equal(externalCalls,0);
  return {runtime,classified,API0:true};
});

check('known-host-membership-supply-gap', {hostObservedInstalledSkillIds:[],hostObservedSupportedSkillIds:[]}, {directInventoryInstalled:false,gatewayInventoryInstalled:true,knownFinding:'host-active-state-supply-gap'}, async () => {
  const direct=await loadSkillInventory({root,installedSkillIds:[],hostSupportedSkillIds:[]});
  const gateway=new RuntimeSkillClassificationGateway({root,readRuntime:()=>readClassificationRuntime(undefined,root),service:new SkillClassificationService({providers:{},budget:new InMemoryClassificationBudget({jev:{limitUsd:null,spentUsd:null},vendors:{}})})});
  const automatic=await gateway.inventory();
  const explicitSkill=direct.skills.find(x=>x.skillId==='change-scope-guardian'); const gatewaySkill=automatic.skills.find(x=>x.skillId==='change-scope-guardian');
  assert.equal(explicitSkill.installed,false); assert.equal(explicitSkill.hostSupported,false); assert.equal(gatewaySkill.installed,true); assert.equal(gatewaySkill.hostSupported,true);
  return {explicitHostObservation:explicitSkill,gatewayDefault:gatewaySkill,knownFinding:'host-active-state-supply-gap',status:'REPRODUCED',notNewRootCause:true,hostLive:'NOTRUN'};
});

// Actual Git/CLI behavior on disposable synthetic repositories. Fixture setup alone writes/commits;
// the invoked capture/compare CLIs run under a read-only Git verb allowlist, with full before/after state.
const sandbox=mkdtempSync(join(out,'scope-sandbox-'));
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
function repo(name) {
  const dir=join(sandbox,name); mkdirSync(join(dir,'src'),{recursive:true}); mkdirSync(join(dir,'docs'));
  git(dir,'init','-q'); git(dir,'config','user.name','SS17 Isolated Fixture'); git(dir,'config','user.email','fixture@example.invalid');
  writeFileSync(join(dir,'src/user.txt'),'committed\n'); writeFileSync(join(dir,'docs/excluded.txt'),'committed\n');
  git(dir,'add','.'); git(dir,'commit','-qm','SS17 synthetic fixture initialization'); return dir;
}
const taskEnvelope={schemaVersion:'1.0.0',taskId:'SS17-synthetic-scope',objective:'Read-only check of excluded paths and preexisting overlap',scope:{included:['src/**'],excluded:['docs/**']},acceptanceCriteria:['Report scope and overlap only'],riskLevel:'low',workUnits:[],requiredCapabilities:[],constraints:['read-only','do not infer ownership'],authorization:{allowedActions:['read'],prohibitedActions:['reset','restore','stash','clean','checkout','commit','quality-review'],approvalRequired:[]},decision:{complexity:'simple',hasConflicts:false},orchestration:{requested:false,mcpAvailable:false}};
const wrapper=join(sandbox,'bin'); mkdirSync(wrapper);
const realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim(); const gitLog=join(out,'SS17.git-readonly-trace.jsonl');
writeFileSync(join(wrapper,'git'),`#!/usr/bin/env python3\nimport os,sys,json\na=sys.argv[1:]\nwith open(${JSON.stringify(gitLog)},'a') as f: f.write(json.dumps(a)+'\\n')\nif len(a)<3 or a[0]!='-C' or a[2] not in ['rev-parse','status','ls-files','ls-tree','diff','show']:\n print('SS17 read-only git allowlist blocked '+repr(a),file=sys.stderr);sys.exit(97)\nos.execv(${JSON.stringify(realGit)},['git']+a)\n`,{mode:0o755});
const cliEnv={...process.env,PATH:wrapper+':'+process.env.PATH,GIT_OPTIONAL_LOCKS:'0'};
function snapshot(dir) {
  const files={}; const walk=(d,p='')=>{for(const n of readdirSync(d)){const rel=p+n,full=join(d,n),stat=lstatSync(full);if(stat.isDirectory())walk(full,rel+'/');else files[rel]=stat.isSymbolicLink()?{link:readlinkSync(full)}:{sha256:sha(readFileSync(full)),mode:stat.mode};}};walk(dir);return files;
}
function cli(name,input) {
  const before=snapshot(input.repositoryRoot);
  const command=[process.execPath,join(root,'skills/change-scope-guardian/scripts/'+name+'.mjs')];
  const result=spawnSync(command[0],command.slice(1),{input:JSON.stringify(input),encoding:'utf8',env:cliEnv});
  assert.deepEqual(snapshot(input.repositoryRoot),before,'compare/capture changed repository bytes or .git state');
  return {command,exit:result.status,stdout:result.stdout,stderr:result.stderr,input,output:result.status===0?JSON.parse(result.stdout):null,repositoryUnchanged:true};
}
function capture(dir) {
  const result=cli('capture-workspace-baseline',{schemaVersion:'1.0.0',mode:'capture',repositoryRoot:dir,comparisonTarget:'working-tree',taskEnvelope}); assert.equal(result.exit,0,result.stderr); return result;
}
function verify(dir,baseline,overrides={}) {
  return cli('compare-change-scope',{schemaVersion:'1.0.0',mode:'verify',repositoryRoot:dir,comparisonTarget:'working-tree',taskEnvelope,...(baseline?{baseline:baseline.output,baselineArtifactDigest:baseline.output.manifestSha256}:{}),...overrides});
}
check('base-dirty-excluded-plus-preexisting-overlap-readonly-CLI', {syntheticRepo:'base',baseline:'saved before second user-file edit',excluded:'docs/**'}, {verdict:'BLOCKED',excluded:1,overlap:1,repositoryUnchanged:true},()=>{
  const dir=repo('base'); writeFileSync(join(dir,'src/user.txt'),'preexisting user edit\n'); const baseline=capture(dir);
  writeFileSync(join(dir,'src/user.txt'),'preexisting user edit plus subsequent edit\n'); writeFileSync(join(dir,'docs/excluded.txt'),'excluded edit\n');
  const result=verify(dir,baseline); assert.equal(result.exit,0,result.stderr); assert.equal(result.output.verdict,'BLOCKED'); assert.equal(result.output.summary.excluded,1); assert.equal(result.output.summary['preexisting-overlap'],1);
  assert.deepEqual(result.output.findings.sort(),['excluded:docs/excluded.txt','preexisting-overlap:src/user.txt']); return {baseline,result};
});
check('preexisting-user-change-untouched-readonly-CLI',{syntheticRepo:'untouched'}, {verdict:'PASS',classification:'preexisting-untouched'},()=>{
  const dir=repo('untouched'); writeFileSync(join(dir,'src/user.txt'),'preexisting user edit\n'); const baseline=capture(dir); const result=verify(dir,baseline);
  assert.equal(result.exit,0,result.stderr); assert.equal(result.output.verdict,'PASS'); assert.equal(result.output.changes[0].classification,'preexisting-untouched'); return {baseline,result};
});
check('missing-baseline-never-guesses-ownership-readonly-CLI',{syntheticRepo:'missing-baseline',baseline:null},{verdict:'INCONCLUSIVE',classification:'ownership-unknown'},()=>{
  const dir=repo('missing'); writeFileSync(join(dir,'src/user.txt'),'unknown edit\n'); const result=verify(dir,null);
  assert.equal(result.exit,0,result.stderr); assert.equal(result.output.verdict,'INCONCLUSIVE'); assert.equal(result.output.changes[0].classification,'ownership-unknown'); assert.equal(result.output.changes[0].baselineSha256,null); return result;
});
check('repository-identity-mismatch-abstains-readonly-CLI',{syntheticRepos:['identity-A','identity-B']},{exit:1,error:'baseline repository identity does not match',report:null},()=>{
  const a=repo('identity-A'),b=repo('identity-B'); const baseline=capture(a); writeFileSync(join(b,'src/user.txt'),'dirty second repo\n'); const result=verify(b,baseline);
  assert.equal(result.exit,1); assert.match(result.stderr,/baseline repository identity does not match/); assert.equal(result.stdout,''); return {baseline,result};
});
check('baseline-digest-and-task-mismatch-abstain-readonly-CLI',{syntheticRepo:'binding-mismatch'},{digestExit:1,taskExit:1},()=>{
  const dir=repo('binding'); const baseline=capture(dir); const digest=verify(dir,baseline,{baselineArtifactDigest:'0'.repeat(64)});
  assert.equal(digest.exit,1); assert.match(digest.stderr,/frozen digest/);
  const task=verify(dir,baseline,{taskEnvelope:{...taskEnvelope,taskId:'SS17-changed-task'}}); assert.equal(task.exit,1); assert.match(task.stderr,/taskEnvelope digest/); return {baseline,digest,task};
});
check('rename-excluded-original-path-remains-blocked-readonly-CLI',{syntheticRepo:'rename',rename:'docs/excluded.txt -> src/moved.txt'},{verdict:'BLOCKED',originalPath:'docs/excluded.txt'},()=>{
  const dir=repo('rename'); const baseline=capture(dir); git(dir,'mv','docs/excluded.txt','src/moved.txt'); const result=verify(dir,baseline);
  assert.equal(result.exit,0,result.stderr); assert.equal(result.output.verdict,'BLOCKED'); assert.ok(result.output.changes.some(x=>x.classification==='excluded'&&(x.path==='docs/excluded.txt'||x.originalPath==='docs/excluded.txt'))); return {baseline,result};
});
test.after(()=>{
  assert.equal(externalCalls,0);
  const trace=readFileSync(gitLog,'utf8').trim().split('\n').map(x=>JSON.parse(x));
  assert.ok(trace.length>0); assert.ok(trace.every(x=>['rev-parse','status','ls-files','ls-tree','diff','show'].includes(x[2])));
  save('final-api-and-readonly-audit',{cliGitTrace:gitLog},{externalAPI:0,gitMutationCalls:0},{externalCalls,gitMutationCalls:0,readOnlyGitCalls:trace.length,sandbox});
});
