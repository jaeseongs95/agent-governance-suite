#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const ownRoot = import.meta.dirname;
const source = resolve(process.argv[process.argv.indexOf('--source')+1] || '/workspace/ags-a7c-w06w07');
const phase = process.argv.includes('--proposed-copy') ? 'proposed-copy' : 'baseline';
const evidence = join(ownRoot,phase); mkdirSync(evidence,{recursive:false});
const temporary = mkdtempSync('/tmp/ags-g18-');
const sha = value => createHash('sha256').update(value).digest('hex');
const cliPaths = ['skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs','skills/mutation-risk-preflight/scripts/verify-preflight-receipt.mjs'];
const testPath = 'tests/mutation-risk-preflight/preflight.node-test.mjs';
const sourceFiles = [...cliPaths,testPath];
const originalHashes = sourceFiles.map(path=>({path,sha256:sha(readFileSync(join(source,path)))}));
const startedAt = new Date().toISOString();
const now = new Date(), verifyAt = new Date(now.getTime()+1000).toISOString();
const approvalUntil = new Date(now.getTime()+3600000).toISOString();
const results = []; let executionRoot = source, copyChanges = [];
function canonical(value) {
  if(value===null || typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
}
// Independent digest oracle over the known original fixture projection. Never
// derives expected text or digests from the CLI's decoded input or output.
function oracle(intent) {
  const targetDigest='sha256:'+sha(canonical(intent.targets));
  const {schemaVersion,targets,...projection}=intent;
  return {targetDigest,actionDigest:'sha256:'+sha(canonical({...projection,targetDigest}))};
}
function fixture(description='한글🧪 원문') {
  const operationId='g18-synthetic-'+now.getTime();
  const locator='fixture://g18/exact-target';
  const digest=n=>'sha256:'+String(n).repeat(64);
  return {schemaVersion:'1.0.0',operationId,actionClass:'delete',
    targets:[{locator,targetType:'file',environment:'synthetic',expectedFingerprint:digest(1)}],
    plannedCommandOrTool:{tool:'fixture-only',action:'describe-without-execution'},
    scopeRef:{locator:'fixture://g18/scope',digest:digest(2),includedTargets:[locator],excludedTargets:[]},
    authorizationRef:{locator:'fixture://g18/authorization',digest:digest(3),allowedActions:['delete'],allowedTargets:[locator],environments:['synthetic']},
    approvalEvidenceRefs:[{locator:'fixture://g18/approval',digest:digest(4),operationId,actionClass:'delete',targetLocators:[locator],environments:['synthetic'],expiresAt:approvalUntil}],
    currentStateEvidenceRefs:[{locator:'fixture://g18/state',digest:digest(5),targetLocator:locator,fingerprint:digest(1)}],
    recoveryPlan:{available:true,method:'synthetic restoration only',backupRef:'fixture://g18/backup',restoreProcedureRef:'fixture://g18/restore',restoreTestEvidenceRef:'fixture://g18/restore-test',irreversibilityAccepted:false},
    expectedBlastRadius:{affectedTargets:1,affectedUsers:0,external:false,description}};
}
async function execute(id,args,input,transport,cuts=[],cwd=executionRoot) {
  const inputFile=join(evidence,id+'.input.json');writeFileSync(inputFile,input);
  const traceFile=join(evidence,id+'.trace.json');
  const env={PATH:process.env.PATH,G18_INPUT:inputFile,G18_TRACE:traceFile,G18_TRANSPORT:transport,G18_CUTS:JSON.stringify(cuts)};
  const command=[process.execPath,...(['input-file','direct'].includes(transport)?[]:['--import',join(ownRoot,'stream-preload.mjs')]),...args,...(transport==='input-file'?['--input',inputFile]:[])];
  const start=new Date().toISOString(),t=performance.now();
  const child=spawn(command[0],command.slice(1),{cwd,env,stdio:['pipe','pipe','pipe']});
  const stdout=[],stderr=[];child.stdout.on('data',x=>stdout.push(x));child.stderr.on('data',x=>stderr.push(x));
  child.stdin.on('error',()=>{});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);
  const close=once(child,'close');
  if(transport==='os-stdin') {
    // Actual OS pipe, byte-oriented writes, asynchronous ticks and backpressure.
    let offset=0;
    while(offset<input.length && !child.stdin.destroyed) {
      const end=Math.min(offset+65537,input.length);
      const accepted=child.stdin.write(input.subarray(offset,end));offset=end;
      if(!accepted && !child.stdin.destroyed)await Promise.race([once(child.stdin,'drain'),close]);
      await new Promise(r=>setImmediate(r));
    }
    child.stdin.end();
  } else child.stdin.end();
  const [exit,signal]=await close;clearTimeout(timeout);
  const out=Buffer.concat(stdout),err=Buffer.concat(stderr);
  writeFileSync(join(evidence,id+'.stdout'),out);writeFileSync(join(evidence,id+'.stderr'),err);
  const receipt={id,command,cwd,startedAt:start,durationMs:Math.round(performance.now()-t),exit,signal,inputBytes:input.length,inputSha256:sha(input),stdoutBytes:out.length,stdoutSha256:sha(out),stderrSha256:sha(err),transport};
  writeFileSync(join(evidence,id+'.receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  let parsed=null;try{parsed=JSON.parse(out);}catch{}
  let trace=null;try{trace=JSON.parse(readFileSync(traceFile));}catch{}
  return {receipt,parsed,trace};
}
function schedule(bytes,name) {
  if(name==='one-byte')return Array.from({length:bytes.length},(_,i)=>i+1);
  if(name==='whole')return [bytes.length];
  const [character,cut]=name.startsWith('korean')?['한',Number(name.at(-1))]:['🧪',Number(name.at(-1))];
  const index=bytes.indexOf(Buffer.from(character));assert(index>=0);
  return [index+cut,bytes.length];
}
async function assess(cli,label,payload,transport,cuts,expectation) {
  const input=Buffer.from(JSON.stringify(payload));
  const result=await execute(cli+'-'+label,[join(executionRoot,cliPaths[cli==='evaluate'?0:1])],input,transport,cuts?.(input)??[]);
  let reasons=[];
  try {await expectation(result.parsed,result.receipt.exit);}catch(e){reasons.push(e.message);}
  if(result.trace) {
    if(result.trace.iteratorByteSha256!==sha(input))reasons.push('Transport did not preserve original bytes');
    if(result.trace.concatenatedTextSha256!==sha(input))reasons.push('Decoded text differs from independent original UTF-8 bytes');
  }
  const row={...result.receipt,passed:reasons.length===0,reasons,trace:result.trace};
  results.push(row);console.log(JSON.stringify({id:row.id,passed:row.passed,exit:row.exit,reasons:row.reasons,iteratorTypes:row.trace?.iteratorTypes,replacementCharacters:row.trace?.replacementCharacters}));
}
try {
  const head=spawnSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  assert.equal(head,'a7c049d5de392651b102840cb7e75243e1afe317');
  if(phase==='proposed-copy') {
    assert(process.argv.includes('--allow-isolated-copy-experiment'),'isolated-copy experiment must be explicitly selected');
    executionRoot=join(temporary,'copy');mkdirSync(executionRoot);
    for(const dir of ['skills/mutation-risk-preflight','runtime','tests/mutation-risk-preflight'])cpSync(join(source,dir),join(executionRoot,dir),{recursive:true});
    symlinkSync(join(source,'node_modules'),join(executionRoot,'node_modules'),'dir');
    for(const path of cliPaths) {
      const file=join(executionRoot,path),original=readFileSync(file,'utf8');
      const needle='  let raw = "";\n  for await (const chunk of process.stdin) raw += chunk;';
      assert.equal(original.split(needle).length,2,'exact original reader expected');
      const proposed=original.replace(needle,'  process.stdin.setEncoding("utf8");\n'+needle);
      writeFileSync(file,proposed);copyChanges.push({path,originalSha256:sha(original),proposedSha256:sha(proposed),change:'insert one process.stdin.setEncoding("utf8") line before stdin iteration'});
    }
  }
  writeFileSync(join(evidence,'source-identity.json'),JSON.stringify({head,tree:'7028d31985a497dfbb4f8e74c9a219b3400bffa2',phase,sourceFiles:originalHashes,copyChanges,sourceGo:false,gate:'Explicit user/lead delegation permits external preparation and isolated reproduction. Candidate AGENTS/development-scope prohibit inference of canonical writer/Task authority; no explicit prohibition on disposable copy experiment found.'},null,2)+'\n');
  const contract=await execute('existing-contract',['--test',join(executionRoot,testPath)],Buffer.from('{}'),'direct');
  results.push({...contract.receipt,passed:contract.receipt.exit===0,reasons:contract.receipt.exit===0?[]:['existing contract failed']});
  const {evaluatePreflight}=await import(pathToFileURL(join(source,cliPaths[0])).href);
  const intent=fixture(),originalOracle=oracle(intent),report=evaluatePreflight(intent,{now:now.toISOString()});
  assert.equal(report.verdict,'READY');assert.equal(report.actionDigest,originalOracle.actionDigest);assert.equal(report.targetDigest,originalOracle.targetDigest);
  const verification={report,intent,verificationTime:verifyAt};
  const evaluateExpected=(expectedIntent,expectedVerdict)=>(output,exit)=>{
    assert.equal(output?.verdict,expectedVerdict);assert.equal(exit,expectedVerdict==='READY'?0:2);
    const expected=oracle(expectedIntent);assert.equal(output.actionDigest,expected.actionDigest,'independent action digest');assert.equal(output.targetDigest,expected.targetDigest,'independent target digest');
    assert.equal(output.blastRadius.description,expectedIntent.expectedBlastRadius.description,'original Korean/emoji text');
    const originalReport=evaluatePreflight(expectedIntent,{now:output.observedAt});assert.deepEqual(output,originalReport);
  };
  const verifyExpected=(valid,code=null)=>(output,exit)=>{
    assert.equal(output?.valid,valid);assert.equal(output?.errorCode,code);assert.equal(exit,valid?0:2);
    if(valid){assert.equal(output.actionDigest,originalOracle.actionDigest);assert.equal(output.targetDigest,originalOracle.targetDigest);}
  };
  for(const name of ['whole','korean-1','korean-2','emoji-1','emoji-2','emoji-3','one-byte']) {
    const cuts=b=>schedule(b,name);
    const controlBytes=Buffer.from(JSON.stringify(intent));
    const control=await execute('decoder-control-'+name,[join(ownRoot,'decoder-control.mjs')],controlBytes,'readable',cuts(controlBytes));
    assert.equal(control.receipt.exit,0);assert.equal(control.parsed.textSha256,sha(controlBytes));assert.equal(control.trace.concatenatedTextSha256,sha(controlBytes));
    await assess('evaluate',name,intent,'readable',cuts,evaluateExpected(intent,'READY'));
    await assess('verify',name,verification,'readable',cuts,verifyExpected(true));
  }
  const denied=structuredClone(intent);denied.authorizationRef.allowedActions=['read'];
  const deniedReport=evaluatePreflight(denied,{now:now.toISOString()});
  const expired={...verification,verificationTime:new Date(now.getTime()+15*60000).toISOString()};
  const tampered=structuredClone(verification);tampered.report.validUntil=new Date(now.getTime()+24*3600000).toISOString();
  const changed=structuredClone(verification);changed.intent.expectedBlastRadius.description='변조🧪';
  for(const transport of ['input-file','os-stdin']) {
    await assess('evaluate',transport,intent,transport,null,evaluateExpected(intent,'READY'));
    await assess('verify',transport,verification,transport,null,verifyExpected(true));
    await assess('evaluate','deny-'+transport,denied,transport,null,evaluateExpected(denied,'BLOCKED'));
    await assess('verify','deny-'+transport,{...verification,intent:denied,report:deniedReport},transport,null,verifyExpected(false,'INVALID_TRANSITION'));
    for(const [name,input]of [['ttl',expired],['tamper',tampered],['changed-text',changed]])await assess('verify',name+'-'+transport,input,transport,null,verifyExpected(false,'STALE_REVISION'));
  }
  const large=fixture('한글🧪'.repeat(131072)+' large-original-text'),largeOracle=oracle(large),largeReport=evaluatePreflight(large,{now:now.toISOString()});
  assert.equal(largeReport.actionDigest,largeOracle.actionDigest);
  for(const transport of ['os-stdin','input-file']) {
    await assess('evaluate','large-'+transport,large,transport,null,evaluateExpected(large,'READY'));
    await assess('verify','large-'+transport,{intent:large,report:largeReport,verificationTime:verifyAt},transport,null,(output,exit)=>{
      assert.equal(exit,0);assert.equal(output?.valid,true);assert.equal(output.actionDigest,largeOracle.actionDigest);assert.equal(output.targetDigest,largeOracle.targetDigest);
    });
  }
  assert.deepEqual(sourceFiles.map(path=>({path,sha256:sha(readFileSync(join(source,path)))})),originalHashes,'canonical original bytes changed');
  const failures=results.filter(r=>!r.passed);
  const summary={phase,startedAt,endedAt:new Date().toISOString(),requestedRouting:{model:'gpt-6.1-sol',effort:'high',fallback:false},observedRouting:'unobservable from this execution API; no provider/model call made',originalHashes,copyChanges,checks:results.length,passed:results.length-failures.length,failed:failures.length,failures:failures.map(r=>({id:r.id,exit:r.exit,reasons:r.reasons})),existingContractStatus:contract.receipt.exit,control:'all seven real Readable StringDecoder control cases matched original bytes',limits:['Synthetic read-only CLI inputs only; no mutation invoked','Original contract historical dates are fixed test constants, not current receipts or authority','New harness approval/report/verification timestamps generated fresh for this run','No source GO/Task/revision/writer authority inferred','No D7 R03 retry or causality claim','Real OS pipe chunk geometry is observed, not guaranteed; deterministic Readable cases force the required byte boundaries'],results};
  writeFileSync(join(evidence,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({phase,checks:summary.checks,passed:summary.passed,failed:summary.failed,summary:join(evidence,'summary.json')}));
  process.exitCode=failures.length?1:0;
} finally {rmSync(temporary,{recursive:true,force:true});}
