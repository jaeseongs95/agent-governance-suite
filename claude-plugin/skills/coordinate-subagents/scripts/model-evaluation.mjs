import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assert, keys, text, digest, digestValue, instant, validateBinding, validateReasoning, verifySeal } from './model-routing-core.mjs';

export function validateEvaluation(r) {
  keys(r, ['schemaVersion','binding','host','hostVersion','adapterVersion','resolvedModel','runtimeMode','scenario','nativeReasoning','tools','permissionsDigest','harnessDigest','testResult','reworkCount','evidenceRejections','goalMaintainedAfterCorrection','failureKind','elapsedMs','waitMs','usage','cost','sourceReference','observedAt','recordDigest']);
  assert(r.schemaVersion === '1.0.0','INVALID_INPUT'); validateBinding(r.binding); validateReasoning(r.nativeReasoning);
  for (const k of ['host','hostVersion','adapterVersion','resolvedModel','runtimeMode','scenario','sourceReference']) text(r[k],k);
  digestValue(r.permissionsDigest,'permissionsDigest'); digestValue(r.harnessDigest,'harnessDigest'); instant(r.observedAt,'observedAt');
  assert(Array.isArray(r.tools) && r.tools.every(t => typeof t === 'string') && new Set(r.tools).size === r.tools.length,'INVALID_INPUT');
  assert(['passed','failed','not-run'].includes(r.testResult),'INVALID_INPUT');
  for (const k of ['reworkCount','evidenceRejections']) assert(Number.isSafeInteger(r[k]) && r[k] >= 0,'INVALID_INPUT');
  assert([true,false,null].includes(r.goalMaintainedAfterCorrection),'INVALID_INPUT');
  assert([null,'information','authority','capability','rate-limit','quality','timeout','protocol','unknown'].includes(r.failureKind),'INVALID_INPUT');
  for (const k of ['elapsedMs','waitMs']) assert(r[k] === null || Number.isSafeInteger(r[k]) && r[k] >= 0,'INVALID_INPUT');
  keys(r.usage,['input','output','reasoning','cacheRead','cacheWrite','toolCalls']);
  assert(Object.values(r.usage).every(n => n === null || Number.isSafeInteger(n) && n >= 0),'INVALID_INPUT');
  keys(r.cost,['basis','amount','currency','unit','sourceReference']);
  assert(['actualBilling','apiPriceEstimate','subscriptionUsage','unknown'].includes(r.cost.basis),'INVALID_INPUT');
  if (r.cost.basis === 'unknown') assert(r.cost.amount === null && r.cost.currency === null && r.cost.unit === null,'INVALID_INPUT','Unknown cost cannot report a number');
  else {
    assert(typeof r.cost.amount === 'number' && Number.isFinite(r.cost.amount) && r.cost.amount >= 0,'INVALID_INPUT'); text(r.cost.sourceReference,'cost source');
    if (r.cost.basis === 'subscriptionUsage') { assert(r.cost.currency === null,'INVALID_INPUT','Subscription usage is not API billing'); text(r.cost.unit,'usage unit'); }
    else assert(typeof r.cost.currency === 'string' && /^[A-Z]{3}$/u.test(r.cost.currency) && r.cost.unit === null,'INVALID_INPUT');
  }
  verifySeal(r,'recordDigest'); return r;
}
export function evaluationCohort(r) {
  return digest({ host:r.host,hostVersion:r.hostVersion,adapterVersion:r.adapterVersion,resolvedModel:r.resolvedModel,nativeReasoning:r.nativeReasoning,runtimeMode:r.runtimeMode,
    scenario:r.scenario,inputDigest:r.binding.inputDigest,candidateDigest:r.binding.candidateDigest,tools:r.tools.slice().sort(),permissionsDigest:r.permissionsDigest,harnessDigest:r.harnessDigest });
}
/** Never combines different harnesses, permissions, inputs, models or billing bases. */
export function aggregateEvaluations(records) {
  assert(Array.isArray(records) && records.length <= 100000,'INVALID_INPUT');
  const cohorts=new Map(),seen=new Map();
  for (const r of records) {
    validateEvaluation(r);
    const sampleKey=digest({binding:r.binding,host:r.host,scenario:r.scenario});
    if (seen.has(sampleKey)) { assert(seen.get(sampleKey)===r.recordDigest,'EVALUATION_SAMPLE_CONFLICT'); continue; }
    seen.set(sampleKey,r.recordDigest);
    const key=evaluationCohort(r);
    if (!cohorts.has(key)) cohorts.set(key,{cohortDigest:key,samples:0,tested:0,passed:0,failed:0,notRun:0,reworkCount:0,evidenceRejections:0,correctionSamples:0,correctionMaintained:0,costs:[],timing:{elapsedMsTotal:0,elapsedMsSamples:0,waitMsTotal:0,waitMsSamples:0},usage:Object.fromEntries(Object.keys(r.usage).map(k=>[k,{total:0,samples:0}]))});
    const c=cohorts.get(key); c.samples++;
    if(r.testResult==='not-run')c.notRun++;else {c.tested++; c[r.testResult==='passed'?'passed':'failed']++;}
    c.reworkCount+=r.reworkCount;c.evidenceRejections+=r.evidenceRejections;
    if(r.goalMaintainedAfterCorrection!==null){c.correctionSamples++;if(r.goalMaintainedAfterCorrection)c.correctionMaintained++;}
    for(const k of ['elapsedMs','waitMs'])if(r[k]!==null){c.timing[`${k}Total`]+=r[k];c.timing[`${k}Samples`]++;}
    for(const [k,v] of Object.entries(r.usage))if(v!==null){c.usage[k].total+=v;c.usage[k].samples++;}
    if(r.cost.basis!=='unknown'){
      let cost=c.costs.find(x=>x.basis===r.cost.basis && x.currency===r.cost.currency && x.unit===r.cost.unit);
      if(!cost){cost={basis:r.cost.basis,currency:r.cost.currency,unit:r.cost.unit,amount:0,samples:0};c.costs.push(cost);}
      cost.amount+=r.cost.amount;cost.samples++;
    }
  }
  return {schemaVersion:'1.0.0',policyChanged:false,cohorts:[...cohorts.values()].sort((a,b)=>a.cohortDigest<b.cohortDigest?-1:1)};
}
// A bundle shares one import.meta.url, so the file name keeps this CLI from running inside the bundled MCP server.
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href&&import.meta.url.endsWith('/model-evaluation.mjs')){
  try { assert(process.argv.length===3,'USAGE','model-evaluation.mjs records.json');console.log(JSON.stringify(aggregateEvaluations(JSON.parse(readFileSync(process.argv[2],'utf8'))),null,2)); }
  catch(error){console.error(`${error.code??'ERROR'}: ${error.message}`);process.exitCode=1;}
}
